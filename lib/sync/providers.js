// Paper Studio — cloud targets for library sync.
//
// Every target speaks the same tiny filesystem: list / get / put / del over a
// flat key space (`p-<paperId>__<file>`). Flat keys keep the three very
// different APIs (Drive folders, Baidu /apps paths, WebDAV) honest, and the sync
// engine never needs provider-specific branches.

import { mkdir, readdir, readFile, writeFile, unlink, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'

import { fetchBuffer, fetchJson, fetchText, request } from '../net.js'
import { baiduRefresh, googleRefresh } from './oauth.js'

export class ProviderError extends Error {}

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' }

// ── local folder (works with any desktop sync client) ────────────────────

export class FolderProvider {
  constructor({ root }) {
    this.id = 'folder'
    this.label = '本地/同步文件夹'
    if (!root) throw new ProviderError('请填写同步文件夹路径（例如 OneDrive、坚果云、iCloud 里的某个目录）')
    this.root = root
  }

  file(key) { return join(this.root, key) }

  async test() {
    await mkdir(this.root, { recursive: true })
    const probe = join(this.root, '.paper-studio-probe')
    await writeFile(probe, String(Date.now()))
    await unlink(probe)
    return `可写：${this.root}`
  }

  async list() {
    await mkdir(this.root, { recursive: true })
    const names = await readdir(this.root)
    const out = []
    for (const name of names) {
      if (name.startsWith('.') || name === 'manifest.json') continue
      try {
        const info = await stat(join(this.root, name))
        if (info.isFile()) out.push({ key: name, size: info.size, mtime: info.mtimeMs })
      } catch { /* vanished */ }
    }
    return out
  }

  async get(key) {
    try {
      return await readFile(this.file(key))
    } catch (err) {
      if (err.code === 'ENOENT') return null
      throw err
    }
  }

  async put(key, buffer) {
    await mkdir(dirname(this.file(key)), { recursive: true })
    await writeFile(this.file(key), buffer)
    const info = await stat(this.file(key))
    return { size: info.size, mtime: info.mtimeMs }
  }

  async del(key) {
    try { await unlink(this.file(key)) } catch (err) { if (err.code !== 'ENOENT') throw err }
  }
}

// ── WebDAV (坚果云 / Nextcloud / Synology) ───────────────────────────────

export class WebDavProvider {
  constructor({ baseUrl, username, password }) {
    this.id = 'webdav'
    this.label = 'WebDAV'
    if (!baseUrl) throw new ProviderError('请填写 WebDAV 地址')
    this.base = baseUrl.replace(/\/+$/, '') + '/'
    const auth = Buffer.from(`${username || ''}:${password || ''}`).toString('base64')
    this.headers = { authorization: `Basic ${auth}` }
  }

  url(key) { return this.base + encodeURIComponent(key) }

  async test() {
    const res = await request(this.base, { method: 'PROPFIND', headers: { ...this.headers, depth: '0' }, timeout: 15000 })
    if (res.status === 401) throw new ProviderError('WebDAV 用户名或密码不对')
    if (res.status >= 400) throw new ProviderError(`WebDAV 返回 ${res.status}，请检查地址（通常以 / 结尾）`)
    return `已连接：${this.base}`
  }

  async list() {
    const res = await request(this.base, { method: 'PROPFIND', headers: { ...this.headers, depth: '1' }, timeout: 20000 })
    if (res.status >= 400) throw new ProviderError(`WebDAV 列目录失败：${res.status}`)
    const xml = await res.text()
    const out = []
    const blocks = xml.split(/<[^>]*response[^>]*>/i).slice(1)
    for (const block of blocks) {
      const href = block.match(/<[^>]*href[^>]*>([^<]+)</i)?.[1]
      if (!href) continue
      let name
      try { name = decodeURIComponent(new URL(href, this.base).pathname.split('/').filter(Boolean).pop() || '') } catch { continue }
      if (!name || name === 'manifest.json') continue
      const isCollection = /<[^>]*collection\s*\/?>/i.test(block)
      if (isCollection) continue
      const size = Number(block.match(/<[^>]*getcontentlength[^>]*>(\d+)</i)?.[1] || 0)
      const modified = block.match(/<[^>]*getlastmodified[^>]*>([^<]+)</i)?.[1]
      out.push({ key: name, size, mtime: modified ? Date.parse(modified) || Date.now() : Date.now() })
    }
    return out
  }

  async get(key) {
    const res = await request(this.url(key), { headers: this.headers, timeout: 30000 })
    if (res.status === 404) return null
    if (!res.ok) throw new ProviderError(`WebDAV 下载失败：${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }

  async put(key, buffer) {
    const res = await request(this.url(key), { method: 'PUT', headers: this.headers, body: buffer, timeout: 60000 })
    if (!res.ok) throw new ProviderError(`WebDAV 上传失败：${res.status}`)
    return { size: buffer.length, mtime: Date.now() }
  }

  async del(key) {
    const res = await request(this.url(key), { method: 'DELETE', headers: this.headers, timeout: 20000 })
    if (res.status >= 400 && res.status !== 404) throw new ProviderError(`WebDAV 删除失败：${res.status}`)
  }
}

// ── Google Drive ─────────────────────────────────────────────────────────

export class GoogleDriveProvider {
  constructor({ clientId, clientSecret, refreshToken, accessToken, expiresAt, tokens, folderName = 'DSH Paper Studio' }) {
    this.id = 'gdrive'
    this.label = 'Google Drive'
    if (!clientId || !clientSecret) throw new ProviderError('请先填写 Google OAuth 的 Client ID / Client Secret')
    if (!refreshToken) throw new ProviderError('还没有授权 Google Drive，请点「绑定账号」')
    this.clientId = clientId
    this.clientSecret = clientSecret
    this.refreshToken = refreshToken
    this.accessToken = accessToken
    this.expiresAt = expiresAt || 0
    this.tokens = tokens
    this.folderName = folderName
    this.folderId = null
    this.index = new Map()
  }

  async token() {
    if (this.accessToken && Date.now() < this.expiresAt - 60000) return this.accessToken
    const next = await googleRefresh({
      refreshToken: this.refreshToken,
      clientId: this.clientId,
      clientSecret: this.clientSecret,
    })
    this.accessToken = next.accessToken
    this.expiresAt = next.expiresAt
    this.tokens?.({ accessToken: next.accessToken, expiresAt: next.expiresAt })
    return this.accessToken
  }

  async api(path, init = {}) {
    const token = await this.token()
    const res = await request(`https://www.googleapis.com${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) },
      timeout: init.timeout || 30000,
    })
    if (res.status === 401) throw new ProviderError('Google 授权已失效，请重新绑定')
    return res
  }

  async ensureFolder() {
    if (this.folderId) return this.folderId
    const q = encodeURIComponent(`name='${this.folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`)
    const found = await this.api(`/drive/v3/files?q=${q}&fields=files(id,name)&spaces=drive&pageSize=10`)
    const data = await found.json()
    if (data.files?.length) {
      this.folderId = data.files[0].id
      return this.folderId
    }
    const created = await this.api('/drive/v3/files?fields=id', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ name: this.folderName, mimeType: 'application/vnd.google-apps.folder' }),
    })
    const body = await created.json()
    this.folderId = body.id
    return this.folderId
  }

  async refreshIndex() {
    const folderId = await this.ensureFolder()
    this.index = new Map()
    let pageToken = ''
    do {
      const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`)
      const res = await this.api(`/drive/v3/files?q=${q}&fields=nextPageToken,files(id,name,size,modifiedTime)&pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ''}`)
      const data = await res.json()
      for (const file of data.files || []) {
        this.index.set(file.name, { id: file.id, size: Number(file.size || 0), mtime: Date.parse(file.modifiedTime) || Date.now() })
      }
      pageToken = data.nextPageToken || ''
    } while (pageToken)
    return this.index
  }

  async test() {
    await this.ensureFolder()
    const list = await this.refreshIndex()
    return `已连接：Drive 文件夹「${this.folderName}」，已有 ${list.size} 个文件`
  }

  async list() {
    const index = await this.refreshIndex()
    return [...index.entries()].map(([key, value]) => ({ key, size: value.size, mtime: value.mtime }))
  }

  async get(key) {
    const index = await this.refreshIndex()
    const entry = index.get(key)
    if (!entry) return null
    const res = await this.api(`/drive/v3/files/${entry.id}?alt=media`)
    if (!res.ok) throw new ProviderError(`Drive 下载失败：${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }

  async put(key, buffer, { mtime } = {}) {
    const index = await this.refreshIndex()
    const entry = index.get(key)
    const token = await this.token()
    if (entry) {
      const res = await request(`https://www.googleapis.com/upload/drive/v3/files/${entry.id}?uploadType=media`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
        body: buffer,
        timeout: 120000,
      })
      if (!res.ok) throw new ProviderError(`Drive 更新失败：${res.status} ${(await res.text()).slice(0, 160)}`)
      return { size: buffer.length, mtime: mtime || Date.now() }
    }
    const boundary = `ps${Date.now()}`
    const metadata = JSON.stringify({ name: key, parents: [await this.ensureFolder()] })
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
      buffer,
      Buffer.from(`\r\n--${boundary}--`),
    ])
    const res = await request('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/related; boundary=${boundary}` },
      body,
      timeout: 180000,
    })
    if (!res.ok) throw new ProviderError(`Drive 上传失败：${res.status} ${(await res.text()).slice(0, 160)}`)
    return { size: buffer.length, mtime: mtime || Date.now() }
  }

  async del(key) {
    await this.refreshIndex()
    const entry = this.index.get(key)
    if (!entry) return
    const res = await this.api(`/drive/v3/files/${entry.id}`, { method: 'DELETE' })
    if (res.status >= 400 && res.status !== 404) throw new ProviderError(`Drive 删除失败：${res.status}`)
    this.index.delete(key)
  }
}

// ── Baidu Netdisk ────────────────────────────────────────────────────────

const BAIDU = 'https://pan.baidu.com/rest/2.0/xpan'
const BAIDU_UPLOAD = 'https://d.pcs.baidu.com/rest/2.0/pcs/superfile2'

export class BaiduProvider {
  constructor({ appKey, appSecret, refreshToken, accessToken, expiresAt, tokens, rootDir }) {
    this.id = 'baidu'
    this.label = '百度网盘'
    if (!appKey || !appSecret) throw new ProviderError('百度网盘需要开放平台应用（AppKey / SecretKey），请先在设置里填写')
    if (!refreshToken) throw new ProviderError('还没有授权百度网盘，请点「绑定账号」')
    this.appKey = appKey
    this.appSecret = appSecret
    this.refreshToken = refreshToken
    this.accessToken = accessToken
    this.expiresAt = expiresAt || 0
    this.tokens = tokens
    this.dir = (rootDir || '/apps/dsh-paper-studio/paper-studio').replace(/\/+$/, '')
  }

  async token() {
    if (this.accessToken && Date.now() < this.expiresAt - 60000) return this.accessToken
    const next = await baiduRefresh({ refreshToken: this.refreshToken, appKey: this.appKey, appSecret: this.appSecret })
    this.accessToken = next.accessToken
    this.expiresAt = next.expiresAt
    this.tokens?.({ accessToken: next.accessToken, expiresAt: next.expiresAt })
    return this.accessToken
  }

  async call(method, params = {}, { base = BAIDU, init = {} } = {}) {
    const token = await this.token()
    const query = new URLSearchParams({ method, access_token: token, ...params })
    const res = await request(`${base}?${query}`, init)
    const text = await res.text()
    let data
    try { data = JSON.parse(text) } catch { throw new ProviderError(`百度返回非 JSON：${text.slice(0, 160)}`) }
    if (data.errno && data.errno !== 0) {
      const message = data.errmsg || data.error_description || `errno ${data.errno}`
      if (data.errno === -6) throw new ProviderError('百度网盘授权失效，请重新绑定')
      throw new ProviderError(`百度网盘：${message}`)
    }
    return data
  }

  async ensureDir() {
    try {
      await this.call('list', { dir: this.dir, limit: '1' })
    } catch {
      const parts = this.dir.split('/').filter(Boolean)
      let current = ''
      for (const part of parts) {
        current += `/${part}`
        try {
          await this.call('create', { path: current, isdir: '1', rtype: '1' })
        } catch { /* already exists */ }
      }
    }
  }

  async test() {
    await this.ensureDir()
    const data = await this.call('list', { dir: this.dir, limit: '1000' })
    return `已连接：${this.dir}，已有 ${data.list?.length ?? 0} 个文件`
  }

  async list() {
    await this.ensureDir()
    const out = []
    const data = await this.call('list', { dir: this.dir, limit: '1000' })
    for (const item of data.list || []) {
      if (item.isdir) continue
      out.push({
        key: item.server_filename,
        size: Number(item.size || 0),
        mtime: Number(item.server_mtime || 0) * 1000 || Date.now(),
        fsId: item.fs_id,
      })
    }
    return out
  }

  async get(key) {
    const data = await this.call('filemetas', { fsids: JSON.stringify([await this.fsid(key)]), dlink: '1' })
    const info = data.list?.[0]
    if (!info?.dlink) return null
    const token = await this.token()
    const res = await request(`${info.dlink}&access_token=${encodeURIComponent(token)}`, { timeout: 120000 })
    if (!res.ok) throw new ProviderError(`百度下载失败：${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }

  async fsid(key) {
    const data = await this.call('list', { dir: this.dir, limit: '1000' })
    const hit = (data.list || []).find((x) => x.server_filename === key)
    if (!hit) throw new ProviderError(`百度网盘里找不到 ${key}`)
    return hit.fs_id
  }

  async put(key, buffer) {
    const path = `${this.dir}/${key}`
    // Remove the previous copy first: Baidu rejects overwriting via `upload`.
    try {
      const fsId = await this.fsid(key)
      await this.call('filemanager', {
        opera: 'delete',
        async: '0',
        filelist: JSON.stringify([path]),
        ondup: 'fail',
      })
      void fsId
    } catch { /* not there yet */ }

    const pre = await this.call('precreate', {
      path,
      size: String(buffer.length),
      isdir: '0',
      autoinit: '1',
      rtype: '3',
      block_list: JSON.stringify(['0']),
    })
    const uploadId = pre.uploadid
    if (uploadId && pre.return_type === 2) {
      // Single 4MB part is enough for our text files.
      const form = new FormData()
      form.append('file', new Blob([buffer]), key)
      const token = await this.token()
      const query = new URLSearchParams({
        method: 'upload',
        access_token: token,
        type: 'tmpfile',
        path,
        uploadid: uploadId,
        partseq: '0',
      })
      const uploaded = await request(`${BAIDU_UPLOAD}?${query}`, { method: 'POST', body: form, timeout: 180000 })
      if (!uploaded.ok) throw new ProviderError(`百度上传失败：${uploaded.status}`)
    }
    await this.call('create', {
      path,
      size: String(buffer.length),
      isdir: '0',
      rtype: '3',
      uploadid: uploadId,
      block_list: JSON.stringify(['0']),
    })
    return { size: buffer.length, mtime: Date.now() }
  }

  async del(key) {
    const path = `${this.dir}/${key}`
    try {
      await this.call('filemanager', { opera: 'delete', async: '0', filelist: JSON.stringify([path]) })
    } catch (err) {
      if (!/不存在|not exist|errno -9/.test(String(err?.message))) throw err
    }
  }
}

export function createProvider(kind, config, hooks = {}) {
  switch (kind) {
    case 'folder': return new FolderProvider(config)
    case 'webdav': return new WebDavProvider(config)
    case 'gdrive': return new GoogleDriveProvider({ ...config, tokens: hooks.tokens })
    case 'baidu': return new BaiduProvider({ ...config, tokens: hooks.tokens })
    default: throw new ProviderError(`未知的同步目标：${kind}`)
  }
}
