// Paper Studio — tiny HTTP helpers shared by the route table.

import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttc': 'font/collection',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
}

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message)
    this.status = status
    this.code = code || 'error'
  }
}

export function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

export function text(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

export async function readBody(req, limit = 80 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, '请求体过大', 'too-large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export async function readJsonBody(req, limit) {
  const buf = await readBody(req, limit)
  if (!buf.length) return {}
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON', 'bad-json')
  }
}

/** An NDJSON response: one JSON object per line, flushed as produced. */
export function ndjson(res) {
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  })
  let closed = false
  res.on('close', () => { closed = true })
  return {
    get closed() { return closed },
    send(obj) {
      if (closed) return false
      res.write(JSON.stringify(obj) + '\n')
      return true
    },
    end() {
      if (closed) return
      closed = true
      res.end()
    },
    fail(message, code = 'error') {
      if (closed) return
      try { res.write(JSON.stringify({ type: 'error', message: String(message), code }) + '\n') } catch {}
      res.end()
      closed = true
    },
  }
}

/** Serve a file from `root`, refusing anything that escapes it. */
export async function serveFile(res, root, relPath, { download = null, cache = 'no-cache' } = {}) {
  const clean = normalize(decodeURIComponent(relPath)).replace(/^([/\\])+/, '')
  const target = resolve(join(root, clean))
  const base = resolve(root)
  if (target !== base && !target.startsWith(base + sep)) {
    json(res, 403, { error: 'forbidden' })
    return
  }
  try {
    const body = await readFile(target)
    const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
    const headers = { 'content-type': type, 'content-length': body.length, 'cache-control': cache }
    if (download) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(download)}`
    res.writeHead(200, headers)
    res.end(body)
  } catch {
    json(res, 404, { error: 'not found' })
  }
}

export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo))
}

export function splitSentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?。！？])\s+/)
    .filter(Boolean)
}
