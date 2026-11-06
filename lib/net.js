// Paper Studio — small HTTP helpers for outbound calls (recommendations, cloud
// storage APIs). Every call is bounded by a timeout and a browser-ish UA, so a
// hanging third party can never wedge a sync or a feed request.

const UA = 'dsh-paper-studio/0.2 (+https://github.com/; academic reader)'

export class NetError extends Error {
  constructor(message, { status, url, body } = {}) {
    super(message)
    this.status = status
    this.url = url
    this.body = body
  }
}

export async function request(url, { method = 'GET', headers = {}, body, timeout = 20000, redirect = 'follow' } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(url, {
      method,
      headers: { 'user-agent': UA, ...headers },
      body,
      redirect,
      signal: controller.signal,
    })
    return res
  } catch (err) {
    if (err?.name === 'AbortError') throw new NetError(`请求超时（${Math.round(timeout / 1000)}s）：${url}`, { url })
    throw new NetError(`网络错误：${err?.message || err}`, { url })
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchText(url, options = {}) {
  const res = await request(url, options)
  const text = await res.text()
  if (!res.ok) throw new NetError(`HTTP ${res.status}：${text.slice(0, 200)}`, { status: res.status, url, body: text })
  return text
}

export async function fetchJson(url, options = {}) {
  const text = await fetchText(url, options)
  try {
    return JSON.parse(text)
  } catch {
    throw new NetError(`返回的不是 JSON：${text.slice(0, 120)}`, { url, body: text })
  }
}

export async function fetchBuffer(url, options = {}) {
  const res = await request(url, options)
  if (!res.ok) throw new NetError(`HTTP ${res.status}`, { status: res.status, url })
  return Buffer.from(await res.arrayBuffer())
}

/** Try several strategies in order; return the first success. */
export async function firstOk(strategies, label = 'operation') {
  const errors = []
  for (const strategy of strategies) {
    try {
      return await strategy()
    } catch (err) {
      errors.push(String(err?.message || err))
    }
  }
  throw new NetError(`${label}失败：${errors.join('；')}`)
}

export function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new NetError(`${label}超时`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
