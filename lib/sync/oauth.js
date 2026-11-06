// Paper Studio — OAuth for the cloud targets.
//
// Desktop apps cannot receive an HTTPS redirect, so every provider uses the
// loopback pattern: we open the provider's consent page, the browser comes back
// to a short-lived HTTP listener on 127.0.0.1, and we exchange the code for a
// refresh token that stays on this machine.
//
// Google accepts any loopback port for "Desktop app" clients. Baidu requires the
// callback to match the app registration, so the port is fixed (7357) and the
// UI shows the exact URL to register.

import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { fetchJson, NetError } from '../net.js'

export const CALLBACK_PORT = 7357
export const CALLBACK_PATH = '/oauth/callback'

let pending = null

function callbackHtml(title, detail, ok = true) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#f4f0e8;color:#1d1b18;
font:14px/1.7 -apple-system,"Segoe UI","PingFang SC",sans-serif}
.card{max-width:420px;padding:28px 32px;background:#fffdf8;border:1px solid #e3dccd;border-radius:12px;
box-shadow:0 10px 30px rgba(29,27,24,.08);text-align:center}
h1{font-size:17px;margin:0 0 8px;font-weight:600;color:${ok ? '#1f4e79' : '#8c2f39'}}
p{margin:0;color:#6f6a61;font-size:13px}</style></head>
<body><div class="card"><h1>${title}</h1><p>${detail}</p></div></body></html>`
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

/**
 * Start a consent flow. Returns the URL to open plus a promise for the code.
 * Only one flow can be pending at a time; starting another cancels the first.
 */
export async function startAuthorization({ buildUrl, port = CALLBACK_PORT, provider = 'oauth', timeoutMs = 5 * 60 * 1000 }) {
  cancelAuthorization()
  let server
  try {
    server = await listen(port)
  } catch (err) {
    throw new NetError(`本地回调端口 ${port} 被占用，请关掉占用它的程序后重试`)
  }
  const state = randomBytes(16).toString('hex')
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`

  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cancelAuthorization()
      reject(new NetError('授权超时（5 分钟），请重新点击「绑定」'))
    }, timeoutMs)

    server.on('request', (req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`)
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end('not found')
        return
      }
      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      const got = url.searchParams.get('state')
      const finish = (ok, message) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(callbackHtml(ok ? '授权完成' : '授权失败', message, ok))
      }
      if (error) {
        finish(false, `${error}${url.searchParams.get('error_description') ? `：${url.searchParams.get('error_description')}` : ''}`)
        clearTimeout(timer)
        cancelAuthorization()
        reject(new NetError(`授权被拒绝：${error}`))
        return
      }
      if (!code) {
        finish(false, '回调里没有 code，请重试')
        return
      }
      if (got !== state) {
        finish(false, 'state 不匹配，可能是过期或伪造的回调，请重新发起授权')
        clearTimeout(timer)
        cancelAuthorization()
        reject(new NetError('OAuth state 不匹配'))
        return
      }
      finish(true, '可以关闭这个页面，回到 DSH 的DeepPaperReading继续。')
      clearTimeout(timer)
      cancelAuthorization()
      resolve({ code, redirectUri, state })
    })
  })

  pending = { server, provider, state, redirectUri }
  const url = buildUrl({ redirectUri, state })
  return { url, redirectUri, wait: () => done, cancel: cancelAuthorization }
}

export function cancelAuthorization() {
  if (!pending) return
  try { pending.server.close() } catch { /* already closed */ }
  pending = null
}

export function authorizationStatus() {
  return pending ? { provider: pending.provider, redirectUri: pending.redirectUri } : null
}

// ── Google Drive ─────────────────────────────────────────────────────────

export function googleAuthorizeUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/drive.file',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
}

export async function googleExchange({ code, clientId, clientSecret, redirectUri }) {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  })
  const data = await fetchJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!data.refresh_token) throw new NetError('Google 没有返回 refresh_token（请确认已勾选离线访问并重新授权）')
  return {
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  }
}

export async function googleRefresh({ refreshToken, clientId, clientSecret }) {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  })
  const data = await fetchJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!data.access_token) throw new NetError('刷新 Google access token 失败')
  return { accessToken: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 }
}

// ── Baidu Netdisk ────────────────────────────────────────────────────────

export function baiduAuthorizeUrl({ appKey, redirectUri, state }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: appKey,
    redirect_uri: redirectUri,
    scope: 'basic,netdisk',
    state,
  })
  return `https://openapi.baidu.com/oauth/2.0/authorize?${params}`
}

export async function baiduExchange({ code, appKey, appSecret, redirectUri }) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: appKey,
    client_secret: appSecret,
    redirect_uri: redirectUri,
  })
  const data = await fetchJson(`https://openapi.baidu.com/oauth/2.0/token?${params}`)
  if (!data.refresh_token) throw new NetError(`百度没有返回 refresh_token：${data.error_description || data.error || '未知原因'}`)
  return {
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 2592000) * 1000,
    scope: data.scope,
  }
}

export async function baiduRefresh({ refreshToken, appKey, appSecret }) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: appKey,
    client_secret: appSecret,
  })
  const data = await fetchJson(`https://openapi.baidu.com/oauth/2.0/token?${params}`)
  if (!data.access_token) throw new NetError('刷新百度 access token 失败')
  return { accessToken: data.access_token, expiresAt: Date.now() + (data.expires_in || 2592000) * 1000 }
}
