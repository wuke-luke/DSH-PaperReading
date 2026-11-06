// Paper Studio — library sync engine.
//
// Three-way merge against the last synced snapshot (`state.json`):
//   base    what this device last saw in the cloud
//   local   what is on disk now
//   remote  what the cloud manifest says
//
// A file is only transferred when exactly one side moved away from base; when
// both moved, the newer mtime wins and the loser is preserved under
// `<data>/conflicts/` so nothing is silently destroyed. `library.json` is merged
// structurally (papers by id, newest `updatedAt` wins) with tombstones, so a
// deletion on one device does not resurrect on the next sync.

import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile, unlink, rm, stat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { readJson, writeJson, ensureDir } from '../store.js'
import { createProvider, ProviderError } from './providers.js'

const TEXT_FILES = ['meta.json', 'text.json', 'zh.json', 'notes.md', 'chats.json', 'figures.json']

function sha1(buffer) {
  return createHash('sha1').update(buffer).digest('hex').slice(0, 24)
}

export class SyncEngine {
  constructor({ store, config, onTokens }) {
    this.store = store
    this.syncConfig = config?.sync ?? {}
    this.onTokens = onTokens
    this.stateFile = join(store.root, '.sync', 'state.json')
    this.conflictDir = join(store.root, 'conflicts')
  }

  get configured() {
    return Boolean(this.syncConfig?.kind && this.syncConfig?.target)
  }

  provider() {
    return createProvider(this.syncConfig.kind, this.syncConfig.target, { tokens: this.onTokens })
  }

  keyFor(paperId, name) {
    return `p-${paperId}__${name}`
  }

  /** Every file that should travel. PDFs are optional: they dominate the bill. */
  async collectLocal() {
    const files = new Map()
    const library = await this.store.library()
    const libraryBuffer = await readFile(this.store.libraryFile).catch(() => null)
    if (libraryBuffer) {
      const info = await stat(this.store.libraryFile)
      files.set('library.json', { buffer: libraryBuffer, hash: sha1(libraryBuffer), mtime: info.mtimeMs, size: info.size })
    }
    for (const paper of library.papers) {
      const dir = this.store.paperDir(paper.id)
      for (const name of TEXT_FILES) {
        try {
          const file = join(dir, name)
          const info = await stat(file)
          const buffer = await readFile(file)
          files.set(this.keyFor(paper.id, name), { buffer, hash: sha1(buffer), mtime: info.mtimeMs, size: info.size })
        } catch { /* file absent */ }
      }
      if (this.syncConfig.includePdf) {
        try {
          const file = join(dir, 'paper.pdf')
          const info = await stat(file)
          const buffer = await readFile(file)
          files.set(this.keyFor(paper.id, 'paper.pdf'), { buffer, hash: sha1(buffer), mtime: info.mtimeMs, size: info.size })
        } catch { /* no pdf */ }
      }
    }
    return files
  }

  async readState() {
    const state = await readJson(this.stateFile, null)
    return state && typeof state === 'object' ? state : { version: 1, files: {}, lastSyncAt: 0, device: null }
  }

  async writeState(state) {
    await writeJson(this.stateFile, state)
  }

  async backupConflict(key, buffer, label) {
    await ensureDir(this.conflictDir)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const name = key.replace(/[/\\]/g, '_')
    await writeFile(join(this.conflictDir, `${stamp}-${label}-${name}`), buffer)
  }

  /**
   * Run one sync. Yields progress events so the HTTP layer can stream them.
   * @returns {AsyncGenerator<object>} final event is `type: 'done'` with a summary
   */
  async* run() {
    if (!this.configured) throw new ProviderError('还没有配置同步目标')
    const provider = this.provider()
    yield { type: 'phase', phase: 'connect', text: '正在连接云端…' }
    const detail = await provider.test()

    yield { type: 'phase', phase: 'scan', text: '正在扫描本地文件…' }
    const local = await this.collectLocal()
    const state = await this.readState()
    const base = state.files || {}

    yield { type: 'phase', phase: 'manifest', text: '正在读取云端清单…' }
    let remoteManifest = { version: 1, files: {} }
    try {
      const raw = await provider.get('manifest.json')
      if (raw) remoteManifest = JSON.parse(raw.toString('utf8'))
    } catch (err) {
      throw new ProviderError(`读取云端清单失败：${err.message}`)
    }
    const remote = new Map(Object.entries(remoteManifest.files || {}))

    // ── plan ────────────────────────────────────────────────────────────
    const uploads = []
    const downloads = []
    const remoteDeletes = []
    const conflicts = []
    const keys = new Set([...local.keys(), ...remote.keys(), ...Object.keys(base)])

    for (const key of keys) {
      if (key === 'manifest.json') continue
      const L = local.get(key)
      const R = remote.get(key)
      const B = base[key]
      if (L && !R) {
        if (!B || B.hash !== L.hash) uploads.push(key)
        // else: the other side deleted it and this side never changed → honour deletion
        continue
      }
      if (!L && R) {
        if (!B) downloads.push(key)
        else if (B.hash !== R.hash) downloads.push(key) // remote edited while this side had it
        continue
      }
      if (!L && !R) continue
      if (L.hash === R.hash) continue
      const localChanged = !B || B.hash !== L.hash
      const remoteChanged = !B || B.hash !== R.hash
      if (remoteChanged && !localChanged) downloads.push(key)
      else if (localChanged && !remoteChanged) uploads.push(key)
      else if (remoteChanged && localChanged) {
        if (L.mtime >= R.mtime) {
          uploads.push(key)
          conflicts.push({ key, side: 'remote' })
        } else {
          downloads.push(key)
          conflicts.push({ key, side: 'local' })
        }
      }
    }

    // Files this device deleted since the last sync, and still present remotely.
    for (const [key, B] of Object.entries(base)) {
      if (local.has(key) || !remote.has(key)) continue
      const R = remote.get(key)
      if (R && R.hash !== B.hash) continue // someone else changed it; keep it
      remoteDeletes.push(key)
    }

    const total = uploads.length + downloads.length + remoteDeletes.length
    let done = 0
    const report = (key, action) => {
      done++
      return { type: 'file', key, action, done, total }
    }

    // ── transfers ───────────────────────────────────────────────────────
    for (const key of uploads) {
      const entry = local.get(key)
      if (!entry) continue
      try {
        await provider.put(key, entry.buffer)
        remote.set(key, { size: entry.size, mtime: entry.mtime, hash: entry.hash })
        state.files[key] = { size: entry.size, mtime: entry.mtime, hash: entry.hash }
        yield report(key, 'upload')
      } catch (err) {
        yield { type: 'warn', key, message: `上传 ${key} 失败：${err.message}` }
      }
    }

    for (const key of downloads) {
      try {
        const buffer = await provider.get(key)
        if (!buffer) continue
        const conflict = conflicts.find((c) => c.key === key && c.side === 'local')
        if (conflict) {
          const current = local.get(key)
          if (current) await this.backupConflict(key, current.buffer, 'local')
        }
        await this.writeLocal(key, buffer)
        const hash = sha1(buffer)
        state.files[key] = { size: buffer.length, mtime: Date.now(), hash }
        remote.set(key, { size: buffer.length, mtime: Date.now(), hash })
        yield report(key, 'download')
      } catch (err) {
        yield { type: 'warn', key, message: `下载 ${key} 失败：${err.message}` }
      }
    }

    for (const key of remoteDeletes) {
      try {
        await provider.del(key)
        remote.delete(key)
        delete state.files[key]
        yield report(key, 'delete')
      } catch (err) {
        yield { type: 'warn', key, message: `删除云端 ${key} 失败：${err.message}` }
      }
    }

    // Preserve the winning copy for conflicts that favour remote.
    for (const conflict of conflicts) {
      if (conflict.side !== 'remote') continue
      try {
        const buffer = await provider.get(conflict.key)
        if (buffer) await this.backupConflict(conflict.key, buffer, 'remote')
      } catch { /* best effort */ }
    }

    // ── library merge ───────────────────────────────────────────────────
    yield { type: 'phase', phase: 'library', text: '正在合并文献库…' }
    let mergedLibrary = null
    try {
      mergedLibrary = await this.mergeLibrary(provider)
      if (mergedLibrary) {
        const buffer = Buffer.from(JSON.stringify(mergedLibrary, null, 2))
        const hash = sha1(buffer)
        const remoteEntry = remote.get('library.json')
        if (!remoteEntry || remoteEntry.hash !== hash) {
          await provider.put('library.json', buffer)
          remote.set('library.json', { size: buffer.length, mtime: Date.now(), hash })
        }
        state.files['library.json'] = { size: buffer.length, mtime: Date.now(), hash }
      }
    } catch (err) {
      yield { type: 'warn', message: `文献库合并失败：${err.message}` }
    }

    // ── manifest ────────────────────────────────────────────────────────
    const manifest = {
      version: 1,
      updatedAt: Date.now(),
      device: state.device || 'unknown',
      files: Object.fromEntries([...remote.entries()].filter(([key]) => key !== 'manifest.json')),
    }
    await provider.put('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)))

    state.lastSyncAt = Date.now()
    state.provider = this.syncConfig.kind
    await this.writeState(state)

    yield {
      type: 'done',
      detail,
      summary: {
        upload: uploads.length,
        download: downloads.length,
        deleted: remoteDeletes.length,
        conflicts: conflicts.length,
        papers: mergedLibrary?.papers?.length ?? null,
      },
    }
  }

  async writeLocal(key, buffer) {
    if (key === 'library.json') {
      await writeFile(this.store.libraryFile, buffer)
      return
    }
    const match = key.match(/^p-([A-Za-z0-9_-]+)__(.+)$/)
    if (!match) return
    const [, id, name] = match
    const dir = this.store.paperDir(id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, name), buffer)
  }

  /** Merge local + remote libraries; tombstones win over older papers. */
  async mergeLibrary(provider) {
    const localLib = await this.store.library()
    let remoteLib = null
    try {
      const raw = await provider.get('library.json')
      if (raw) remoteLib = JSON.parse(raw.toString('utf8'))
    } catch { remoteLib = null }
    if (!remoteLib) return null

    const merged = mergeLibraries(localLib, remoteLib)
    // Persist the merged view locally too, so both devices converge.
    const current = JSON.stringify(localLib)
    if (JSON.stringify(merged) !== current) {
      await this.store.saveLibrary(merged)
      await this.pruneTombstoned(merged)
    }
    return merged
  }

  /** Remove paper folders that both sides agree are deleted. */
  async pruneTombstoned(library) {
    const deleted = library.deleted || {}
    for (const [id, ts] of Object.entries(deleted)) {
      if (library.papers.some((p) => p.id === id)) continue
      void ts
      try {
        await rm(this.store.paperDir(id), { recursive: true, force: true })
      } catch { /* already gone */ }
    }
  }

  async status() {
    const state = await this.readState()
    const lib = await this.store.library()
    return {
      configured: this.configured,
      kind: this.syncConfig?.kind ?? null,
      includePdf: Boolean(this.syncConfig?.includePdf),
      lastSyncAt: state.lastSyncAt || 0,
      files: Object.keys(state.files || {}).length,
      papers: lib.papers.length,
      device: state.device || null,
      conflicts: await this.countConflicts(),
    }
  }

  async countConflicts() {
    try {
      return (await readdir(this.conflictDir)).length
    } catch {
      return 0
    }
  }
}

export function mergeLibraries(local, remote) {
  const now = Date.now()
  const out = { version: 1, folders: [], papers: [], deleted: {} }
  const deleted = {}
  for (const source of [remote, local]) {
    for (const [id, ts] of Object.entries(source?.deleted || {})) {
      if (!deleted[id] || ts > deleted[id]) deleted[id] = ts
    }
  }
  const folderById = new Map()
  for (const source of [remote, local]) {
    for (const folder of source?.folders || []) {
      if (!folder?.id) continue
      const existing = folderById.get(folder.id)
      if (!existing || (folder.createdAt || 0) > (existing.createdAt || 0)) folderById.set(folder.id, folder)
    }
  }
  const paperById = new Map()
  for (const source of [remote, local]) {
    for (const paper of source?.papers || []) {
      if (!paper?.id) continue
      const existing = paperById.get(paper.id)
      if (!existing) { paperById.set(paper.id, paper); continue }
      if ((paper.updatedAt || 0) > (existing.updatedAt || 0)) paperById.set(paper.id, paper)
    }
  }
  for (const [id, paper] of paperById) {
    const grave = deleted[id]
    if (grave && grave >= (paper.updatedAt || 0)) continue
    out.papers.push(paper)
  }
  out.folders = [...folderById.values()]
  // Tombstones older than 90 days carry no information; keep the map small.
  for (const [id, ts] of Object.entries(deleted)) {
    if (now - ts < 90 * 86400000) out.deleted[id] = ts
  }
  out.papers.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  return out
}
