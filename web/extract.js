/* PDF → reading-ready text.
 *
 * Shared by the reader (browser) and the seed/dev tooling (Node), so the
 * paragraphs a screenshot shows are the same paragraphs the app would build.
 *
 * The interesting work is column handling: an 8.5×11 two-column paper puts the
 * left and right columns at the same y, so a naive top-to-bottom sort produces
 * interleaved nonsense. We split by x when a real gutter exists, then rebuild
 * paragraphs inside each column from baseline gaps and indentation.
 */

const cjk = (ch) => /[\u3000-\u9fff\uff00-\uffef]/.test(ch || '')

function joinLines(a, b) {
  if (!a) return b
  if (!b) return a
  if (a.endsWith('-') && /^[a-z]/.test(b)) return a.slice(0, -1) + b
  if (cjk(a.slice(-1)) || cjk(b[0])) return a + b
  return `${a} ${b}`
}

/** Cluster text items into visual lines by baseline. */
export function itemsToLines(items) {
  const lines = []
  const sorted = [...items].sort((a, b) => (b.y - a.y) || (a.x - b.x))
  let current = null
  for (const item of sorted) {
    const height = item.h || 10
    if (!current || Math.abs(current.y - item.y) > height * 0.55) {
      current = { y: item.y, h: height, items: [item] }
      lines.push(current)
    } else {
      current.items.push(item)
      current.h = Math.max(current.h, height)
      current.y = (current.y * (current.items.length - 1) + item.y) / current.items.length
    }
  }
  return lines.map((line) => {
    const ordered = line.items.sort((a, b) => a.x - b.x)
    let text = ''
    let prev = null
    for (const item of ordered) {
      if (prev) {
        const gap = item.x - (prev.x + prev.w)
        const needsSpace = gap > Math.max(1.6, (prev.h || 10) * 0.16)
          && !cjk(prev.str.slice(-1)) && !cjk(item.str[0])
        text += (needsSpace ? ' ' : '') + item.str
      } else {
        text = item.str
      }
      prev = item
    }
    return {
      text: text.replace(/\s+/g, ' ').trim(),
      x: ordered[0].x,
      y: line.y,
      h: line.h,
      width: ordered[ordered.length - 1].x + ordered[ordered.length - 1].w - ordered[0].x,
    }
  }).filter((l) => l.text)
}

/** Split a page with a real vertical gutter into columns. */
export function splitColumns(lines, pageWidth) {
  if (lines.length < 24) return [lines]
  const left = lines.filter((l) => l.x + l.width / 2 < pageWidth * 0.52)
  const right = lines.filter((l) => l.x + l.width / 2 >= pageWidth * 0.52)
  if (left.length < 10 || right.length < 10) return [lines]
  const maxLeft = Math.max(...left.map((l) => l.x + l.width))
  const minRight = Math.min(...right.map((l) => l.x))
  if (minRight - maxLeft < 8) return [lines]
  return [left, right]
}

/** Rebuild paragraphs from one column's lines, keeping each block's box. */
export function linesToParagraphs(lines, page, pageHeight = 792) {
  const out = []
  const heights = lines.map((l) => l.h).sort((a, b) => a - b)
  const medianH = heights[Math.floor(heights.length / 2)] || 10
  let buffer = null
  let prev = null

  const boxOf = (line) => ({
    x: line.x,
    y: pageHeight - (line.y + line.h),
    right: line.x + (line.width || 0),
    bottom: pageHeight - line.y,
    size: line.h || medianH,
  })
  const openBuffer = (line) => {
    const box = boxOf(line)
    return { text: line.text, page, heading: '', x: box.x, y: box.y, right: box.right, bottom: box.bottom, size: box.size }
  }
  const extend = (buf, line) => {
    const box = boxOf(line)
    buf.x = Math.min(buf.x, box.x)
    buf.y = Math.min(buf.y, box.y)
    buf.right = Math.max(buf.right, box.right)
    buf.bottom = Math.max(buf.bottom, box.bottom)
    buf.size = Math.max(buf.size, box.size)
    buf.text = joinLines(buf.text, line.text)
  }
  const finish = (buf) => {
    buf.w = Math.max(8, buf.right - buf.x)
    buf.h = Math.max(6, buf.bottom - buf.y)
    buf.x = Math.round(buf.x * 10) / 10
    buf.y = Math.round(buf.y * 10) / 10
    buf.w = Math.round(buf.w * 10) / 10
    buf.h = Math.round(buf.h * 10) / 10
    buf.size = Math.round(buf.size * 10) / 10
    delete buf.right
    delete buf.bottom
    out.push(buf)
  }

  for (const line of lines) {
    if (!line.text) continue
    const isHeading = line.h > medianH * 1.14 && line.text.length < 110
    if (isHeading) {
      if (buffer) { finish(buffer); buffer = null }
      const heading = openBuffer(line)
      heading.heading = 'h'
      finish(heading)
      prev = null
      continue
    }
    if (!buffer) {
      buffer = openBuffer(line)
      prev = line
      continue
    }
    const gap = prev.y - line.y
    const indent = line.x - prev.x
    const newPara = gap > medianH * 1.55
      || (indent > medianH * 0.9 && !/^[a-z,;)]/.test(line.text))
      || Math.abs(line.h - medianH) > 1.6
    if (newPara) {
      finish(buffer)
      buffer = openBuffer(line)
    } else {
      extend(buffer, line)
    }
    prev = line
  }
  if (buffer) finish(buffer)
  return out
}

/** Running heads repeat on most pages; bare page numbers and front matter are noise. */
export function stripRunningHeads(paragraphs) {
  const counts = new Map()
  for (const p of paragraphs) {
    const key = p.text.length < 90 ? p.text.toLowerCase() : null
    if (key) counts.set(key, (counts.get(key) || 0) + 1)
  }
  return paragraphs.filter((p) => {
    const text = p.text
    if (/^\d{1,4}$/.test(text)) return false
    // arXiv side stamp, e.g. "arXiv:2610.14625v1 [cs.AI] 10 Oct 2026"
    if (/^arxiv:\s*\d{4}\.\d{4,5}/i.test(text)) return false
    // Table of contents: dot leaders, or "3.2 Something 6" bailing to a page number.
    if ((text.match(/(\.\s){4,}|…{2,}/g) || []).length > 0) return false
    if (/^\d+(\.\d+)*\s+\S[\s\S]{0,90}\s\d{1,3}$/.test(text) && text.length < 120) return false
    if (/^(contents|table of contents)$/i.test(text)) return false
    const key = text.length < 90 ? text.toLowerCase() : null
    if (key && counts.get(key) >= 3) return false
    return true
  })
}

export function detectSections(paragraphs) {
  return paragraphs
    .filter((p) => p.heading === 'h')
    .map((p) => ({ title: p.text, page: p.page }))
    .slice(0, 60)
}

export function detectAbstract(paragraphs) {
  const idx = paragraphs.findIndex((p) => /^abstract\b/i.test(p.text) || /^abstract[—\-:]/i.test(p.text))
  if (idx >= 0) {
    const parts = []
    if (paragraphs[idx].text.length > 12) parts.push(paragraphs[idx].text.replace(/^abstract[—\-:\s]*/i, ''))
    for (let i = idx + 1; i < Math.min(idx + 6, paragraphs.length); i++) {
      const p = paragraphs[i]
      if (p.heading === 'h' || /^(1\s+)?introduction\b/i.test(p.text)) break
      parts.push(p.text)
    }
    const joined = parts.join(' ').trim()
    if (joined.length > 80) return joined.slice(0, 1800)
  }
  // No "Abstract" heading (surveys and some preprint styles): the opening body
  // paragraph before the first numbered section is the abstract in practice.
  const introAt = paragraphs.findIndex((p) => p.heading === 'h' && /^(1\s+)?introduction\b/i.test(p.text))
  const limit = introAt > 0 ? introAt : Math.min(paragraphs.length, 12)
  for (let i = 0; i < limit; i++) {
    const p = paragraphs[i]
    if (p.heading === 'h') continue
    if (p.text.length > 420 && /[.!?]\s/.test(p.text)) return p.text.slice(0, 1800)
  }
  return ''
}

/**
 * Page one repeats the title as large-font lines; the header already shows it.
 * Runs after extraction, when the title is known.
 */
export function dropTitleEcho(text, title) {
  const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')
  const t = squash(title)
  if (!t || t.length < 8) return text
  const kept = text.paragraphs.filter((p) => {
    if (p.page > 1) return true
    const n = squash(p.text)
    if (!n || n.length < 6) return true
    return !(t.includes(n) || (n.length > 12 && n.includes(t.slice(0, 24))))
  })
  return { ...text, paragraphs: kept.map((p, i) => ({ ...p, i })) }
}

/**
 * Extract a whole document.
 * @param doc  a resolved pdf.js PDFDocumentProxy
 * @param onProgress  (pageNumber, pageCount) => void
 */
export async function extractDocument(doc, onProgress) {
  const pages = []
  const paragraphs = []
  for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
    onProgress?.(pageNo, doc.numPages)
    const page = await doc.getPage(pageNo)
    const viewport = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()
    const items = []
    for (const item of content.items) {
      const str = String(item.str || '')
      if (!str.trim()) continue
      const y = item.transform[5]
      const h = Math.hypot(item.transform[2], item.transform[3]) || item.height || 10
      // Header/footer bands carry page furniture, not prose.
      if (y < viewport.height * 0.055 || y > viewport.height * 0.955) continue
      items.push({ str, x: item.transform[4], y, w: item.width || str.length * h * 0.5, h })
    }
    const lines = itemsToLines(items)
    const columns = splitColumns(lines, viewport.width)
    const pageParas = []
    for (const column of columns) {
      const ordered = [...column].sort((a, b) => b.y - a.y)
      pageParas.push(...linesToParagraphs(ordered, pageNo, viewport.height))
    }
    paragraphs.push(...pageParas)
    pages.push({ page: pageNo, chars: pageParas.reduce((n, p) => n + p.text.length, 0), w: Math.round(viewport.width), h: Math.round(viewport.height) })
  }
  const cleaned = stripRunningHeads(paragraphs)
  return {
    pages,
    paragraphs: cleaned.map((p, i) => ({
      i,
      page: p.page,
      text: p.text,
      heading: p.heading === 'h' ? 'h' : '',
      x: p.x,
      y: p.y,
      w: p.w,
      h: p.h,
      size: p.size,
    })),
    abstract: detectAbstract(cleaned),
    sections: detectSections(cleaned),
  }
}
