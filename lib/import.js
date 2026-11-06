// Paper Studio — getting a PDF in: local bytes, a direct PDF link, or an arXiv
// reference (abs/pdf/id/alphanumeric). Everything returns the same shape so the
// route layer has one path to store.

const MAX_BYTES = 120 * 1024 * 1024
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 dsh-paper-studio'

export const ARXIV_ID = /(?:arxiv[:\s]*|arxiv\.org\/(?:abs|pdf)\/)([a-z-]+\/\d{7}|\d{4}\.\d{4,5})(v\d+)?/i

/** Recognize an arXiv reference in a URL, a `arXiv:...` string, or a bare id. */
export function parseArxiv(input) {
  const raw = String(input || '').trim()
  if (!raw) return null
  const m = raw.match(ARXIV_ID) || raw.match(/^([a-z-]+\/\d{7}|\d{4}\.\d{4,5})(v\d+)?$/i)
  if (!m) return null
  const id = m[1]
  const version = m[2] || ''
  return {
    id,
    version,
    absUrl: `https://arxiv.org/abs/${id}${version}`,
    pdfUrl: `https://arxiv.org/pdf/${id}${version}`,
  }
}

export function isProbablyPdfUrl(url) {
  try {
    const u = new URL(url)
    if (!/^https?:$/.test(u.protocol)) return false
    if (/\.pdf($|\?)/i.test(u.pathname + u.search)) return true
    if (/(^|\.)arxiv\.org$/i.test(u.hostname)) return true
    if (/openreview\.net$/i.test(u.hostname)) return true
    return true
  } catch {
    return false
  }
}

async function fetchWithTimeout(url, { timeout = 45000, headers = {} } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    return await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'application/pdf,text/html;q=0.9,*/*;q=0.8', ...headers },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

/** Download a PDF and prove it starts with %PDF before handing the bytes on. */
export async function downloadPdf(url) {
  const res = await fetchWithTimeout(url)
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`)
  const type = res.headers.get('content-type') || ''
  if (/text\/html/i.test(type) && !/arxiv\.org\/pdf/i.test(url)) {
    // The link served a landing page rather than a file: tell the user instead
    // of storing HTML as a "PDF" that every later step would choke on.
    throw new Error('这个链接返回的是网页而不是 PDF，请换用 PDF 直链（右键「复制链接地址」）或 arXiv 编号')
  }
  const length = Number(res.headers.get('content-length') || 0)
  if (length > MAX_BYTES) throw new Error('文件超过 120MB，暂不支持')
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length > MAX_BYTES) throw new Error('文件超过 120MB，暂不支持')
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('下载到的内容不是 PDF（缺少 %PDF 文件头）')
  }
  return { bytes, finalUrl: res.url || url, contentType: type }
}

/** Best-effort arXiv metadata (title/authors/abstract) for a nicer library card. */
export async function fetchArxivMeta(arxivId) {
  try {
    const res = await fetchWithTimeout(
      `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}&max_results=1`,
      { timeout: 12000 },
    )
    if (!res.ok) return null
    const xml = await res.text()
    const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1]
    if (!entry) return null
    const pick = (tag) => {
      const m = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))
      return m ? m[1].replace(/\s+/g, ' ').trim() : ''
    }
    const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => m[1].trim())
    const published = pick('published')
    return {
      title: pick('title'),
      authors,
      abstract: pick('summary'),
      year: published ? Number(published.slice(0, 4)) : null,
      arxivId,
    }
  } catch {
    return null
  }
}

/** A paper title from the first screenful of extracted text, as a fallback. */
export function guessTitleFromText(text) {
  const lines = String(text || '')
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 12 && l.length < 220)
  const candidates = lines.slice(0, 12).filter((l) => !/^(abstract|introduction|arxiv|doi|keywords)\b/i.test(l))
  return candidates[0] || ''
}
