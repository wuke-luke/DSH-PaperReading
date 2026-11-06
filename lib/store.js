// Paper Studio — durable storage for the library, papers, notes and chats.
//
// Layout (default root: ~/.dsh/paper-studio):
//   library.json                 { version, folders, papers: [PaperMeta] }
//   config.json                  user settings (links never stored here)
//   papers/<id>/paper.pdf        the original PDF bytes
//   papers/<id>/text.json        extracted pages/paragraphs (browser extraction)
//   papers/<id>/zh.json          translation cache, one entry per paragraph
//   papers/<id>/notes.md         free-form paper notes
//   papers/<id>/chats.json       conversations
//   papers/<id>/figures.json     generated diagram specs
//
// Every write is atomic (tmp + rename) and serialized per file, so a crash or a
// concurrent request can never leave a half-written JSON document behind.

import { mkdir, readFile, writeFile, rename, readdir, rm, stat, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

import { addUsage } from './usage.js'

export const SCHEMA_VERSION = 1

export function defaultDataDir() {
  return join(homedir(), '.dsh', 'paper-studio')
}

const locks = new Map()

/** Serialize async work per key (file path). */
export async function withLock(key, fn) {
  const prev = locks.get(key) ?? Promise.resolve()
  let release
  const next = new Promise((resolve) => { release = resolve })
  locks.set(key, prev.then(() => next))
  await prev
  try {
    return await fn()
  } finally {
    release()
    if (locks.get(key) === next) locks.delete(key)
  }
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
}

export async function readJson(file, fallback) {
  try {
    const raw = await readFile(file, 'utf8')
    if (!raw.trim()) return fallback
    return JSON.parse(raw)
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return fallback
    if (err instanceof SyntaxError) return fallback
    throw err
  }
}

export async function writeJson(file, value) {
  await withLock(file, async () => {
    await ensureDir(dirname(file))
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
    await rename(tmp, file)
  })
}

export async function writeText(file, text) {
  await withLock(file, async () => {
    await ensureDir(dirname(file))
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, file)
  })
}

export async function readText(file, fallback = '') {
  try {
    return await readFile(file, 'utf8')
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return fallback
    throw err
  }
}

export function safeId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{6,64}$/.test(id) ? id : null
}

export function slugify(text, max = 60) {
  const s = String(text ?? '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return s.slice(0, max) || 'untitled'
}

export function newId() {
  return randomUUID().replace(/-/g, '').slice(0, 20)
}

export class Store {
  constructor(dataDir) {
    this.root = dataDir || defaultDataDir()
  }

  get libraryFile() { return join(this.root, 'library.json') }
  get configFile() { return join(this.root, 'config.json') }
  paperDir(id) { return join(this.root, 'papers', id) }
  paperFile(id, name) { return join(this.paperDir(id), name) }

  async init() {
    await ensureDir(join(this.root, 'papers'))
    const lib = await readJson(this.libraryFile, null)
    if (!lib) {
      await writeJson(this.libraryFile, { version: SCHEMA_VERSION, folders: [], papers: [] })
    }
  }

  async library() {
    const lib = await readJson(this.libraryFile, null)
    if (!lib || typeof lib !== 'object') return { version: SCHEMA_VERSION, folders: [], papers: [], deleted: {} }
    if (!Array.isArray(lib.papers)) lib.papers = []
    if (!Array.isArray(lib.folders)) lib.folders = []
    if (!lib.deleted || typeof lib.deleted !== 'object') lib.deleted = {}
    return lib
  }

  async saveLibrary(lib) {
    await writeJson(this.libraryFile, lib)
  }

  async listPapers() {
    const lib = await this.library()
    return [...lib.papers].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  }

  /** Accumulate token usage for one paper (and mirror the totals). */
  async addUsage(id, delta, kind = 'other') {
    const file = join(this.paperDir(id), 'usage.json')
    const current = await readJson(file, null).catch(() => null)
    const next = addUsage(current, delta, kind)
    await writeJson(file, next)
    const lib = await this.library()
    const index = lib.papers.findIndex((p) => p.id === id)
    if (index >= 0) {
      lib.papers[index].usage = { prompt: next.prompt, completion: next.completion, calls: next.calls }
      await this.saveLibrary(lib)
    }
    return next
  }

  async glossary(id) {
    const data = await readJson(join(this.paperDir(id), 'glossary.json'), null).catch(() => null)
    return Array.isArray(data?.terms) ? data.terms : null
  }

  async saveGlossary(id, terms) {
    await writeJson(join(this.paperDir(id), 'glossary.json'), { terms, at: Date.now() })
    return terms
  }

  async usage(id) {
    return readJson(join(this.paperDir(id), 'usage.json'), null).catch(() => null)
  }

  async getPaper(id) {
    const lib = await this.library()
    return lib.papers.find((p) => p.id === id) ?? null
  }

  async upsertPaper(meta) {
    const lib = await this.library()
    const i = lib.papers.findIndex((p) => p.id === meta.id)
    if (i >= 0) lib.papers[i] = { ...lib.papers[i], ...meta }
    else lib.papers.unshift(meta)
    // Re-importing a paper revives it: drop the tombstone so sync agrees.
    if (lib.deleted?.[meta.id]) delete lib.deleted[meta.id]
    await this.saveLibrary(lib)
    return meta
  }

  async patchPaper(id, patch) {
    const lib = await this.library()
    const p = lib.papers.find((x) => x.id === id)
    if (!p) return null
    Object.assign(p, patch, { updatedAt: Date.now() })
    await this.saveLibrary(lib)
    await writeJson(join(this.paperDir(id), 'meta.json'), p)
    return p
  }

  async removePaper(id) {
    const lib = await this.library()
    const p = lib.papers.find((x) => x.id === id)
    if (!p) return false
    // Move the folder into .trash so a mis-click stays recoverable.
    const trash = join(this.root, '.trash', `${id}-${Date.now()}`)
    await ensureDir(dirname(trash))
    if (existsSync(this.paperDir(id))) await rename(this.paperDir(id), trash)
    lib.papers = lib.papers.filter((x) => x.id !== id)
    // A tombstone is what stops the other device from resurrecting it.
    lib.deleted = lib.deleted || {}
    lib.deleted[id] = Date.now()
    await this.saveLibrary(lib)
    return true
  }

  async folders() {
    const lib = await this.library()
    return lib.folders
  }

  async addFolder(name) {
    const lib = await this.library()
    const folder = { id: newId(), name: String(name || '新专题').slice(0, 60), createdAt: Date.now() }
    lib.folders.push(folder)
    await this.saveLibrary(lib)
    return folder
  }

  async renameFolder(id, name) {
    const lib = await this.library()
    const f = lib.folders.find((x) => x.id === id)
    if (!f) return null
    f.name = String(name || f.name).slice(0, 60)
    await this.saveLibrary(lib)
    return f
  }

  async removeFolder(id) {
    const lib = await this.library()
    lib.folders = lib.folders.filter((x) => x.id !== id)
    for (const p of lib.papers) if (p.folderId === id) p.folderId = null
    await this.saveLibrary(lib)
    return true
  }

  async text(id) {
    return readJson(this.paperFile(id, 'text.json'), null)
  }

  async saveText(id, text) {
    await writeJson(this.paperFile(id, 'text.json'), text)
  }

  async translations(id) {
    return readJson(this.paperFile(id, 'zh.json'), { version: 1, target: 'zh', entries: {} })
  }

  async saveTranslations(id, data) {
    await writeJson(this.paperFile(id, 'zh.json'), data)
  }

  async notes(id) {
    return readText(this.paperFile(id, 'notes.md'), '')
  }

  async saveNotes(id, md) {
    await writeText(this.paperFile(id, 'notes.md'), String(md ?? ''))
    await this.patchPaper(id, { noteUpdatedAt: Date.now() })
  }

  async chats(id) {
    return readJson(this.paperFile(id, 'chats.json'), { version: 1, threads: [] })
  }

  async saveChats(id, data) {
    await writeJson(this.paperFile(id, 'chats.json'), data)
  }

  async figures(id) {
    return readJson(this.paperFile(id, 'figures.json'), { version: 1, items: [] })
  }

  async saveFigures(id, data) {
    await writeJson(this.paperFile(id, 'figures.json'), data)
  }

  async config() {
    return readJson(this.configFile, {})
  }

  async saveConfig(patch) {
    const cur = await this.config()
    const next = { ...cur, ...patch, updatedAt: Date.now() }
    await writeJson(this.configFile, next)
    return next
  }

  async stats(id) {
    try {
      const s = await stat(this.paperFile(id, 'paper.pdf'))
      return { sizeBytes: s.size }
    } catch {
      return { sizeBytes: 0 }
    }
  }

  async importBytes(id, bytes) {
    await ensureDir(this.paperDir(id))
    const file = this.paperFile(id, 'paper.pdf')
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, bytes)
    await rename(tmp, file)
    return file
  }

  async duplicateTo(id, destFile) {
    await copyFile(this.paperFile(id, 'paper.pdf'), destFile)
  }
}

export function paperTitleFromFileName(name) {
  const base = basename(String(name || 'paper')).replace(/\.pdf$/i, '').replace(/[_]+/g, ' ')
  return base.trim() || '未命名论文'
}
