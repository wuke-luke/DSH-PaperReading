/* Paper Studio — reader application.
 *
 * Vanilla ES module on purpose: the desk is DOM- and canvas-heavy (PDF pages,
 * text layers, SVG figures) and lives in its own document, so a framework would
 * add weight without buying anything. Sections:
 *   1. helpers            6. reader rendering
 *   2. api                7. PDF extraction + canvas view
 *   3. state              8. translation
 *   4. library            9. chat / notes / figures
 *   5. import            10. boot
 */

import { dropTitleEcho, extractDocument } from './extract.js'

// ── 1. helpers ────────────────────────────────────────────────────────────

const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

function debounce(fn, wait) {
  let timer
  const wrapped = (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), wait)
  }
  wrapped.flush = (...args) => { clearTimeout(timer); fn(...args) }
  return wrapped
}

function fmtBytes(n) {
  if (!n) return ''
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function fmtDate(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function timeAgo(ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  const min = Math.round(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr} 小时前`
  return fmtDate(ts)
}

let toastTimer
function toast(message, kind = '') {
  const node = $('#toast')
  node.textContent = message
  node.className = `toast ${kind}`
  node.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { node.hidden = true }, kind === 'error' ? 5200 : 2600)
}

function progress(label) {
  const bar = $('#progress')
  if (label === null) { bar.hidden = true; return }
  bar.hidden = false
  $('span', bar).textContent = label
}

function setProgress(ratio) {
  $('#progress i').style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`
}

const STORE = {
  get(key, fallback) {
    try { const raw = localStorage.getItem(`paperstudio.${key}`); return raw === null ? fallback : JSON.parse(raw) } catch { return fallback }
  },
  set(key, value) {
    try { localStorage.setItem(`paperstudio.${key}`, JSON.stringify(value)) } catch { /* private mode */ }
  },
}

/** Minimal Markdown: exactly what a reading companion emits, nothing more. */
function renderMarkdown(src) {
  const lines = String(src || '').replace(/\r\n/g, '\n').split('\n')
  let html = ''
  let list = null
  let inCode = false
  let code = []
  const math = []
  const stashMath = (raw) => String(raw ?? '').replace(
    /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$|\\\(([\s\S]+?)\\\)/g,
    (match, block, inlineTex, parenTex) => {
      const tex = (block ?? inlineTex ?? parenTex ?? '').trim()
      if (!tex) return match
      let rendered
      try {
        rendered = window.katex
          ? window.katex.renderToString(tex, { displayMode: Boolean(block), throwOnError: false, strict: false })
          : esc(tex)
      } catch { rendered = esc(tex) }
      math.push(rendered)
      return '\u0000' + (math.length - 1) + '\u0000'
    },
  )
  const unstash = (text) => text.replace(/\u0000(\d+)\u0000/g, (_, i) => math[Number(i)] ?? '')
  const inline = (text) => unstash(esc(stashMath(text))
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>'))
  const closeList = () => { if (list) { html += `</${list}>`; list = null } }
  for (const line of lines) {
    if (/^```/.test(line)) {
      if (inCode) { html += `<pre><code>${esc(code.join('\n'))}</code></pre>`; code = []; inCode = false }
      else { closeList(); inCode = true }
      continue
    }
    if (inCode) { code.push(line); continue }
    if (!line.trim()) { closeList(); continue }
    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    if (heading) { closeList(); html += `<h4>${inline(heading[2])}</h4>`; continue }
    const ul = line.match(/^\s*[-*•]\s+(.*)$/)
    if (ul) {
      if (list !== 'ul') { closeList(); list = 'ul'; html += '<ul>' }
      html += `<li>${inline(ul[1])}</li>`
      continue
    }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (ol) {
      if (list !== 'ol') { closeList(); list = 'ol'; html += '<ol>' }
      html += `<li>${inline(ol[1])}</li>`
      continue
    }
    const quote = line.match(/^>\s?(.*)$/)
    if (quote) { closeList(); html += `<blockquote>${inline(quote[1])}</blockquote>`; continue }
    closeList()
    html += `<p>${inline(line)}</p>`
  }
  if (inCode) html += `<pre><code>${esc(code.join('\n'))}</code></pre>`
  closeList()
  return html
}

/** Turn [p.12] into a clickable page chip (after escaping). */
function linkCitations(html) {
  return html.replace(/\[p\.?\s?(\d{1,4})\]/g, '<button class="cite" data-page="$1">第 $1 页</button>')
}

// ── 2. api ────────────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const res = await fetch(`./api${path}`, {
    headers: options.body && !(options.body instanceof Blob) ? { 'content-type': 'application/json' } : undefined,
    ...options,
  })
  if (!res.ok) {
    let detail = ''
    try { detail = (await res.json()).error } catch { detail = await res.text().catch(() => '') }
    throw new Error(detail || `请求失败 (${res.status})`)
  }
  return res.json()
}

/** POST and consume an NDJSON response line by line. */
async function streamApi(path, body, onEvent, signal) {
  const res = await fetch(`./api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    let detail = ''
    try { detail = (await res.json()).error } catch { detail = await res.text().catch(() => '') }
    throw new Error(detail || `请求失败 (${res.status})`)
  }
  if (!res.body) throw new Error('浏览器不支持流式读取')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let event
      try { event = JSON.parse(line) } catch { continue }
      if (event.type === 'error') throw new Error(event.message || '生成失败')
      onEvent(event)
    }
  }
}

// ── 3. state ──────────────────────────────────────────────────────────────

const state = {
  papers: [],
  folders: [],
  config: {},
  selection: null,
  dataDir: '',
  activeId: null,
  paper: null,
  text: null,
  translations: {},
  notes: '',
  threads: [],
  figures: [],
  mode: STORE.get('mode', 'dual'),
  tab: STORE.get('tab', 'chat'),
  view: 'pdf',
  query: '',
  collapsed: STORE.get('collapsedFolders', []),
  railHidden: STORE.get('railHidden', false),
  messages: [],
  busy: { translate: false, chat: false, figure: false, import: false },
  selectionText: '',
  discover: { loading: false, loaded: false, related: [], trending: [], at: 0, error: null },
  pdf: { zoom: STORE.get('pdfZoom', 1), fit: 1, pages: [] },
  translate: { controller: null, done: 0, total: 0 },
  models: [],
  pdfVariant: 'source',
  babeldoc: null,
  babeldocBusy: false,
  chatModel: STORE.get('chatModel', null),
  sync: { kind: 'folder', config: null, running: false },
}

/** True when the stored译文 came from a different model than the current one. */
function needsRetranslate() {
  const used = state.translationModels || state.paper?.translationModels || []
  if (!used.length) return false
  const current = state.selectionLabel
  return Boolean(current) && !used.includes(current)
}

async function loadChatModels() {
  try {
    const data = await api('/models')
    state.models = data.items || []
    if (!state.chatModel || !state.models.some((m) => m.provider + '/' + m.model === state.chatModel)) {
      state.chatModel = data.current || (state.models[0] ? state.models[0].provider + '/' + state.models[0].model : null)
    }
    renderChatModels()
  } catch { /* the picker simply stays empty */ }
}

function renderChatModels() {
  const select = $('#chat-model')
  if (!select) return
  if (!state.models.length) {
    select.innerHTML = '<option value="">默认模型</option>'
    select.disabled = true
    return
  }
  select.disabled = false
  const current = state.chatModel || ''
  select.innerHTML = state.models.map((m) => {
    const value = m.provider + '/' + m.model
    return '<option value="' + esc(value) + '"' + (value === current ? ' selected' : '') + '>' + esc(m.label || value) + '</option>'
  }).join('')
}

/** Run BabelDOC on this paper and switch the viewer to its output. */
async function runBabeldoc() {
  if (!state.paper || state.babeldocBusy) return
  const status = await api('/babeldoc?paperId=' + state.paper.id).catch(() => null)
  if (!status) { toast('无法读取重排引擎状态', 'error'); return }
  if (!status.installed) {
    try { await navigator.clipboard.writeText(status.hint) } catch { /* ignore */ }
    toast('未安装 BabelDOC，安装命令已复制：' + status.hint, 'error')
    return
  }
  if (!status.ready) {
    toast('BabelDOC 需要 API Key：设置 → 模型来源 → API Key 直连（或「从论文伴读导入 Key」）', 'error')
    return
  }
  state.babeldocBusy = true
  renderReader()
  progress('重排翻译中…')
  try {
    await streamApi('/paper/' + state.paper.id + '/babeldoc', {}, (event) => {
      if (event.type === 'log') {
        const text = String(event.text || '')
        if (/translat|%|page|stage/i.test(text)) progress('重排：' + text.slice(0, 70))
      }
      if (event.type === 'ready') progress('重排完成，正在打开…')
    })
    state.babeldoc = { dual: true, mono: true }
    state.pdfVariant = 'babeldoc'
    toast('重排译文已生成')
  } catch (err) {
    toast('重排失败：' + (err.message || err), 'error')
  } finally {
    state.babeldocBusy = false
    progress(null)
    renderReader()
  }
}

/** Show the local Baidu Netdisk folder, if the desktop client is installed. */
async function refreshBaiduLocal() {
  const status = $('#baidu-local-status')
  const button = $('#sync-baidu-local')
  if (!status || !button) return
  status.textContent = '正在检测本机的百度网盘同步空间…'
  button.disabled = true
  let data = null
  try { data = await api('/sync/baidu-local') } catch { data = null }
  const dirs = data?.dirs || []
  state.baiduDirs = dirs
  if (!dirs.length) {
    status.textContent = '没有找到百度网盘同步文件夹。请在百度网盘客户端开启「同步空间」，或直接在上面的「本地文件夹」里填路径。'
    button.disabled = true
    return
  }
  const best = dirs[0]
  status.textContent = '检测到：' + best.path + '（' + best.flavour + '）'
  button.disabled = false
  button.textContent = '绑定到 ' + (best.flavour === '同步空间' ? '同步空间' : '下载目录')
  button.onclick = async () => {
    button.disabled = true
    try {
      await api('/sync/config', { method: 'POST', body: { kind: 'folder', target: { root: best.target } } })
      toast('已绑定：' + best.target)
      status.textContent = '已绑定：' + best.target + '（客户端会自动上传）'
      button.textContent = '已绑定'
      const fresh = await api('/state').catch(() => null)
      if (fresh?.config) state.config = fresh.config
    } catch (err) {
      toast('绑定失败：' + (err.message || err), 'error')
      button.disabled = false
    }
  }
}

// ── discovery ────────────────────────────────────────────────────────────

function discCard(item) {
  const meta = []
  if (item.year) meta.push(item.year)
  if (item.authors?.length) meta.push(`${item.authors.slice(0, 2).join('、')}${item.authors.length > 2 ? ' 等' : ''}`)
  if (item.reason) meta.push(`<span class="tag">${esc(item.reason)}</span>`)
  if (item.stars) meta.push(`★ ${item.stars}`)
  return `<article class="disc-card">
    <div class="disc-title">${esc(item.title || '未命名')}</div>
    <div class="disc-meta">${meta.join(' · ')}</div>
    ${item.abstract ? `<p class="disc-abstract">${esc(item.abstract)}</p>` : ''}
    <div class="disc-actions">
      <button class="ghost-btn sm" data-import="${esc(item.id)}">导入</button>
      <a class="chip" href="${esc(item.url)}" target="_blank" rel="noreferrer">arXiv:${esc(item.id)}</a>
    </div>
  </article>`
}

function renderDiscover() {
  const body = $('#discover-body')
  if (!body) return
  const { loading, related, trending, error } = state.discover
  if (loading) {
    body.innerHTML = '<p class="disc-empty">正在找同方向的论文…</p>'
    return
  }
  if (error) {
    body.innerHTML = `<p class="disc-empty">推荐加载失败：${esc(error)}</p>`
    return
  }
  const relatedHtml = related.length
    ? related.map(discCard).join('')
    : '<p class="disc-empty">这篇论文没有可用的相似推荐（需要 arXiv 编号，或稍后再试）。</p>'
  const trendingHtml = trending.length
    ? trending.map(discCard).join('')
    : '<p class="disc-empty">暂时没有取到热点列表，检查网络后点「刷新推荐」。</p>'
  body.innerHTML = `
    <section class="disc-block">
      <h5>和这篇相关 <span>${related.length} 篇</span></h5>
      ${relatedHtml}
    </section>
    <section class="disc-block">
      <h5>今日热门 <span>community · ${trending.length} 篇</span></h5>
      ${trendingHtml}
    </section>`
  const status = $('#discover-status')
  if (status) status.textContent = state.discover.at ? `更新于 ${timeAgo(state.discover.at)}` : ''
}

async function loadDiscover(force = false) {
  if (state.discover.loading) return
  state.discover.loading = true
  renderDiscover()
  try {
    const params = new URLSearchParams()
    if (state.paper) params.set('paperId', state.paper.id)
    if (force) params.set('force', '1')
    const data = await api(`/discover?${params}`)
    state.discover = {
      loading: false,
      loaded: true,
      related: data.related?.items || [],
      trending: data.trending?.items || [],
      at: Date.now(),
      error: null,
    }
  } catch (err) {
    state.discover = { ...state.discover, loading: false, loaded: true, error: String(err.message || err) }
  }
  renderDiscover()
}

const hasText = () => Boolean(state.text?.paragraphs?.length)

// ── 4. library ────────────────────────────────────────────────────────────

function filteredPapers() {
  const q = state.query.trim().toLowerCase()
  if (!q) return state.papers
  return state.papers.filter((p) => {
    const hay = [p.title, (p.authors || []).join(' '), p.venue, p.arxivId, ...(p.tags || [])].join(' ').toLowerCase()
    return hay.includes(q)
  })
}

function fmtTokens(n) {
  const v = Number(n) || 0
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k'
  return String(Math.round(v))
}

function renderLibrary() {
  const list = $('#library-list')
  const papers = filteredPapers()
  const groups = new Map()
  groups.set('__root__', { id: null, name: '全部文献', papers: [] })
  for (const f of state.folders) groups.set(f.id, { id: f.id, name: f.name, papers: [] })
  for (const p of papers) {
    const g = groups.get(p.folderId) || groups.get('__root__')
    g.papers.push(p)
  }
  let html = ''
  const emit = (group) => {
    if (!group.papers.length && group.id !== null) return
    const closed = state.collapsed.includes(String(group.id))
    html += `<div class="folder-group" data-folder="${esc(group.id ?? '')}">`
    html += `<div class="folder-row ${closed ? 'closed' : ''}" data-folder-toggle="${esc(group.id ?? '')}">
      <span class="caret" aria-hidden="true"></span>
      <span class="name">${esc(group.name)}</span>
      <span class="count">${group.papers.length}</span>
      ${group.id ? `<span class="acts"><button class="icon-btn sm" data-folder-rename="${esc(group.id)}" title="重命名">✎</button></span>` : ''}
    </div>`
    if (!closed) {
      if (!group.papers.length) html += `<div class="paper-meta" style="padding:6px 10px">还没有论文</div>`
      for (const p of group.papers) {
        const active = p.id === state.activeId
        const progressPct = Math.round((p.progress || 0) * 100)
        html += `<div class="paper-card ${active ? 'active' : ''}" data-paper="${p.id}" role="button" tabindex="0">
          <button class="paper-del" data-del-paper="${p.id}" title="删除这篇论文" aria-label="删除">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13M10 11v6M14 11v6"/></svg>
          </button>
          <div class="paper-title">${esc(p.title || '未命名论文')}</div>
          <div class="paper-meta">
            ${p.year ? `<span>${p.year}</span>` : ''}
            ${p.arxivId ? `<span class="badge">arXiv</span>` : ''}
            ${p.indexed ? '' : '<span class="unread">待解析</span>'}
            ${p.noteUpdatedAt ? '<span title="有笔记">✎</span>' : ''}
            ${p.translatedCount ? `<span title="已翻译">译 ${p.translatedCount}</span>` : ''}
            ${p.usage ? `<span class="tok" title="累计 token：输入 ${p.usage.prompt || 0} / 输出 ${p.usage.completion || 0}">${fmtTokens((p.usage.prompt || 0) + (p.usage.completion || 0))} tok</span>` : ''}
          </div>
          ${progressPct ? `<div class="paper-progress"><i style="width:${progressPct}%"></i></div>` : ''}
        </div>`
      }
    }
    html += '</div>'
  }
  for (const g of groups.values()) emit(g)
  list.innerHTML = html || '<div class="paper-meta" style="padding:12px">文献库是空的</div>'

  $('#lib-stat').textContent = `${state.papers.length} 篇`
  const sel = state.selection
  $('#lib-model').textContent = sel ? `${sel.provider}/${sel.model}` : '模型未就绪'
}

// ── 5. import ─────────────────────────────────────────────────────────────

function showImport(title, detail) {
  $('#import-overlay').hidden = false
  $('#import-title').textContent = title
  $('#import-detail').textContent = detail || ''
  $('#import-bar').style.width = '4%'
}

function updateImport(detail, ratio) {
  $('#import-detail').textContent = detail
  if (typeof ratio === 'number') $('#import-bar').style.width = `${Math.round(Math.max(4, Math.min(1, ratio)) * 100)}%`
}

function hideImport() { $('#import-overlay').hidden = true }

async function importFiles(files) {
  const pdfs = [...files].filter((f) => /pdf$/i.test(f.name) || f.type === 'application/pdf')
  if (!pdfs.length) { toast('只支持 PDF 文件', 'error'); return }
  for (const file of pdfs) {
    try {
      showImport('正在导入', file.name)
      const res = await fetch(`./api/import/upload`, {
        method: 'POST',
        headers: { 'content-type': 'application/pdf', 'x-ps-name': encodeURIComponent(file.name) },
        body: file,
      })
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}))
        throw new Error(detail.error || `导入失败 (${res.status})`)
      }
      const { paper } = await res.json()
      await refreshLibrary()
      hideImport()
      await openPaper(paper.id)
      toast('已导入，正在解析正文')
    } catch (err) {
      hideImport()
      toast(String(err.message || err), 'error')
    }
  }
}

async function importUrl(raw) {
  const url = String(raw || '').trim()
  if (!url) return
  try {
    showImport('正在下载', url)
    const { paper } = await api('/import/url', { method: 'POST', body: JSON.stringify({ url }) })
    await refreshLibrary()
    hideImport()
    await openPaper(paper.id)
    toast('已导入，正在解析正文')
  } catch (err) {
    hideImport()
    toast(String(err.message || err), 'error')
    $('#empty-hint').textContent = String(err.message || err)
    $('#empty-hint').className = 'empty-hint error'
  }
}

async function refreshLibrary() {
  const data = await api('/state')
  state.papers = data.papers
  state.folders = data.folders
  state.config = data.config || {}
  state.selection = data.selection
  state.selectionLabel = data.selection ? data.selection.provider + '/' + data.selection.model : null
  state.translationModels = state.paper?.translationModels || state.translationModels || []
  state.dataDir = data.dataDir
  renderLibrary()
}

// ── 6. reader ─────────────────────────────────────────────────────────────

function setMode(mode, { update = true } = {}) {
  state.mode = mode === 'dual' ? 'dual' : 'source'
  STORE.set('mode', mode)
  document.body.dataset.mode = mode
  $$('#mode-switch button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === mode)))
  if (update && state.paper) renderReader({ anchor: captureScrollAnchor() })
}

function renderPaperHead() {
  const p = state.paper
  const authors = (p.authors || []).slice(0, 6).join('，')
  const facts = []
  if (p.year) facts.push(`<span class="chip">${p.year}</span>`)
  if (p.venue) facts.push(`<span class="chip">${esc(p.venue)}</span>`)
  if (p.arxivId) facts.push(`<a class="chip accent" href="https://arxiv.org/abs/${esc(p.arxivId)}" target="_blank" rel="noreferrer">arXiv:${esc(p.arxivId)}</a>`)
  if (p.pages) facts.push(`<span class="chip">${p.pages} 页</span>`)
  if (p.translatedCount) facts.push(`<span class="chip">已译 ${p.translatedCount} 段</span>`)
  if (p.sizeBytes) facts.push(`<span class="chip">${fmtBytes(p.sizeBytes)}</span>`)
  const abstract = ''
  return `<header class="paper-head">
    <h1>${esc(p.title || '未命名论文')}</h1>
    <div class="byline">${authors ? `<em>${esc(authors)}</em>` : '<em>作者未知</em>'}</div>
    <div class="facts">${facts.join('')}</div>
    ${abstract}
  </header>`
}

/** Author/affiliation lines on page one duplicate the byline above. */
function frontMatterSkips(paragraphs) {
  const skip = new Set()
  const limit = Math.min(paragraphs.length, 40)
  for (let i = 0; i < limit; i++) {
    const t = paragraphs[i].text
    if (/universit|institute|college|equal contribution|school of|correspondence|@[a-z0-9.-]+\.(com|edu|cn|org)/i.test(t) && t.length < 420) {
      skip.add(i)
      continue
    }
    if (t.length < 240 && (t.match(/,/g) || []).length >= 2 && !/[.!?]\s/.test(t)) skip.add(i)
  }
  return skip
}

function renderReader(options = {}) {
  const scroll = $('#reader-scroll')
  if (!state.paper) {
    $('#empty').hidden = false
    scroll.innerHTML = ''
    $('#crumb').innerHTML = ''
    $('#btn-translate-all').disabled = true
    return
  }
  $('#empty').hidden = true
  $('#btn-translate-all').disabled = !hasText()
  $('#crumb').innerHTML = `<b>${esc(state.paper.title || '')}</b>`
  renderPdfView(options)
  return
  if (!hasText()) { renderPending(); return }
  const parts = [renderToolbar(), '<div class="reader-inner">', renderPaperHead()]
  const skips = frontMatterSkips(state.text.paragraphs)
  for (const para of state.text.paragraphs) {
    if (skips.has(para.i)) continue
    const zh = state.translations[para.i]
    const isHeading = para.heading === 'h'
    if (isHeading) {
      parts.push(`<h2 class="heading-para" id="p${para.i}" data-page="${para.page}">
        <span class="pnum">P${para.page}</span>${esc(para.text)}</h2>`)
      continue
    }
    const translated = zh?.text
    parts.push(`<div class="para" id="p${para.i}" data-page="${para.page}" data-i="${para.i}">
      <span class="pnum" title="第 ${para.page} 页">P${para.page}</span>
      <span class="src">${esc(para.text)}</span>
      <div class="tr ${translated ? '' : 'empty'}" ${translated || state.mode !== 'dual' ? '' : 'hidden'}>${translated ? esc(translated) : ''}</div>
    </div>`)
  }
  parts.push('</div>')
  scroll.innerHTML = parts.join('')
  if (!state.translations || Object.keys(state.translations).length === 0) {
    // nothing translated yet: keep the translation slots out of the way
  }
  applyModeVisibility()
}

function applyModeVisibility() {
  const mode = state.mode
  document.body.dataset.mode = mode
  for (const para of $$('.para')) {
    const tr = $('.tr', para)
    if (!tr) continue
    const has = tr.textContent.trim().length > 0
    tr.hidden = mode === 'source' || (mode === 'dual' && !has)
  }
}

function renderToolbar() {
  const pages = state.text?.pages?.length ?? state.paper?.pages ?? 0
  return `<div class="reader-toolbar">
    <div class="group"><span>${pages} 页 · ${state.text?.paragraphs?.length ?? 0} 段</span></div>
    <div class="spacer"></div>
    ${
(state.babeldoc?.dual || state.babeldoc?.mono) ? '<div class="seg" id="variant-seg">'
+ '<button data-variant="source" class="' + (state.pdfVariant === 'source' ? 'on' : '') + '">原版</button>'
+ '<button data-variant="babeldoc" class="' + (state.pdfVariant === 'babeldoc' ? 'on' : '') + '">重排译文</button>'
+ '</div>' : ''}
    <button class="ghost-btn sm accent" id="btn-babeldoc">${state.babeldocBusy ? '重排中…' : '重排翻译'}</button>
    ${state.view === 'pdf' ? '<div class="group pdf-zoom">'
      + '<button class="icon-btn sm" data-zoom="out" title="缩小">−</button>'
      + '<span id="zoom-label">' + Math.round((state.pdf.fit || 1) * (state.pdf.zoom || 1) * 100) + '%</span>'
      + '<button class="icon-btn sm" data-zoom="in" title="放大">+</button>'
      + '<button class="ghost-btn sm" data-zoom="fit">适应宽度</button>'
      + '<button class="ghost-btn sm" data-zoom="reset">100%</button>'
      + '</div>' : ''}
    <div class="group">
      ${needsRetranslate() ? '<button class="ghost-btn sm accent" id="btn-retranslate" title="现有译文是别的模型生成的">换模型重译</button>' : ''}
      <button class="ghost-btn sm" id="btn-translate-todo">翻译全文</button>
      <button class="ghost-btn sm" id="btn-export">导出对照</button>
    </div>
  </div>`
}

function renderPending() {
  $('#reader-scroll').innerHTML = `${renderToolbar()}<div class="reader-inner">
    ${renderPaperHead()}
    <div class="pending">
      <p>这篇论文还没有解析正文。</p>
      <button class="primary-btn" id="btn-parse">解析 PDF 正文</button>
      <p class="pending-hint">解析在本机浏览器里完成，PDF 不会被上传到别处。</p>
    </div>
  </div>`
}

// ── 7. pdf extraction + canvas view ──────────────────────────────────────

let pdfjsPromise = null
function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('./vendor/pdfjs/pdf.mjs').then((lib) => {
      // Cache-bust the worker: a stale negative cache leaves the reader dead.
      lib.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/pdf.worker.mjs?v=6.5.438'
      return lib
    })
  }
  return pdfjsPromise
}

async function extractFromPdf(id) {
  const pdfjs = await getPdfjs()
  const res = await fetch(`./api/paper/${id}/pdf`)
  if (!res.ok) throw new Error('读取 PDF 失败')
  const data = new Uint8Array(await res.arrayBuffer())
  const doc = await pdfjs.getDocument({
    data,
    cMapUrl: './vendor/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: './vendor/pdfjs/standard_fonts/',
    wasmUrl: './vendor/pdfjs/wasm/',
    isEvalSupported: false,
  }).promise
  try {
    return await extractDocument(doc, (page, total) => {
      updateImport(`正在解析第 ${page} / ${total} 页`, page / total)
    })
  } finally {
    try { await doc.destroy?.() } catch { /* keep the page usable */ }
  }
}

async function parsePaper(id) {
  if (!id) return
  showImport('正在解析正文', '准备中…')
  const previous = state.text
  try {
    const text = dropTitleEcho(await extractFromPdf(id), state.paper?.title)
    // Re-indexing can shift paragraph numbers: keep a译文 only when the same
    // index still starts with the same text.
    const kept = {}
    for (const [index, entry] of Object.entries(state.translations)) {
      const before = previous?.paragraphs?.[Number(index)]?.text?.slice(0, 40)
      const after = text.paragraphs[Number(index)]?.text?.slice(0, 40)
      if (before && after && before === after) kept[index] = entry
    }
    state.translations = kept
    if (!text.paragraphs.length) throw new Error('没有解析到文字（可能是扫描版 PDF）')
    updateImport('正在建立索引', 0.96)
    const { paper } = await api(`/paper/${id}/index`, { method: 'POST', body: JSON.stringify(text) })
    state.text = text
    state.paper = paper
    hideImport()
    await refreshLibrary()
    renderReader()
    toast(`解析完成：${text.paragraphs.length} 段`)
  } catch (err) {
    hideImport()
    toast(`解析失败：${err.message || err}`, 'error')
  }
}
// PDF canvas view ---------------------------------------------------------

let pdfRenderToken = 0
const pdfCache = { doc: null, paperId: null, observer: null }

/** Load (and cache) the PDF document; a new paper destroys the old one. */
async function getPdfDoc(paperId, variant = 'source') {
  const cacheKey = paperId + ':' + variant
  if (pdfCache.doc && pdfCache.paperId === cacheKey) return pdfCache.doc
  if (pdfCache.doc) {
    try { await pdfCache.doc.destroy?.() } catch { /* already gone */ }
    pdfCache.doc = null
  }
  const pdfjs = await getPdfjs()
  const suffix = variant === 'source' ? '/pdf' : '/babeldoc/' + variant
  const res = await fetch('./api/paper/' + paperId + suffix)
  if (!res.ok) throw new Error(variant === 'source' ? '读取 PDF 失败' : '读取重排译文失败')
  const data = new Uint8Array(await res.arrayBuffer())
  const doc = await pdfjs.getDocument({
    data,
    cMapUrl: './vendor/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: './vendor/pdfjs/standard_fonts/',
    wasmUrl: './vendor/pdfjs/wasm/',
  }).promise
  pdfCache.doc = doc
  pdfCache.paperId = cacheKey
  return doc
}

function noteParagraphs(page) {
  return (state.text?.paragraphs || []).filter((p) => p.page === page && p.heading !== 'h')
}

function translationOf(p) {
  return state.translations[p.i]?.text || ''
}

/** Old parses have no geometry: the laid-out bilingual page needs it. */
function hasLayout() {
  const paragraphs = state.text?.paragraphs || []
  return paragraphs.some((p) => typeof p.x === 'number')
}

function layoutBanner() {
  return '<div class="pdf-notice">'
    + '<span>这篇论文是旧版解析，没有保留版面坐标，整页对照需要重新解析一次（约 10–30 秒，不影响已有译文和笔记）。</span>'
    + '<button class="ghost-btn sm" data-reparse="1">重新解析</button>'
    + '</div>'
}

/** The text column used when geometry is unavailable. */
function notesColumnHtml(page) {
  const paras = noteParagraphs(page)
  if (!paras.length) return '<p class="pdf-notes-empty">这一页没有可用的文字层（可能是扫描页或纯图）。</p>'
  const untranslated = paras.filter((p) => !translationOf(p)).length
  const head = untranslated
    ? '<button class="ghost-btn sm" data-translate-page="' + page + '">翻译本页（' + untranslated + ' 段未译）</button>'
    : ''
  const body = paras.map((p) => {
    const zh = translationOf(p)
    return '<div class="pdf-note" data-i="' + p.i + '">'
      + (zh ? '<p class="zh">' + esc(zh) + '</p>' : '<p class="en muted">' + esc(p.text) + '</p>')
      + '</div>'
  }).join('')
  return '<div class="pdf-notes-head">第 ' + page + ' 页' + head + '</div>' + body
}

function sheetHtml(page, w, h, side) {
  return '<div class="pdf-sheet" data-side="' + side + '">'
    + '<div class="pdf-page" data-page="' + page + '" data-side="' + side + '" style="width:' + w + 'px;height:' + h + 'px">'
    + (side === 'zh' ? '<div class="pdf-overlay"></div>' : '')
    + '</div></div>'
}

/**
 * Build the reader surface. Modes:
 *   source  originals only
 *   dual    translated page beside the original, page by page
 *   target  translated pages only
 */
/** What the reader is currently looking at: page + offset inside it. */
function captureScrollAnchor() {
  const scroller = $('#reader-scroll')
  if (!scroller) return null
  const maxX = Math.max(1, scroller.scrollWidth - scroller.clientWidth)
  const top = scroller.getBoundingClientRect().top
  const nodes = scroller.querySelectorAll('.pdf-pair[data-page], .pdf-spread[data-page]')
  let anchor = null
  for (const el of nodes) {
    const rect = el.getBoundingClientRect()
    if (rect.bottom > top + 1) {
      anchor = { page: Number(el.dataset.page), offset: (top - rect.top) / Math.max(1, rect.height) }
      break
    }
  }
  return { anchor, xRatio: scroller.scrollLeft / maxX }
}

function restoreScrollAnchor(saved) {
  if (!saved) return false
  const scroller = $('#reader-scroll')
  if (!scroller) return false
  // `scroll-behavior: smooth` turns every assignment into an animation, which
  // makes repeated restore attempts fight each other. Force it off for the jump.
  const previous = scroller.style.scrollBehavior
  scroller.style.scrollBehavior = 'auto'
  try {
    if (saved.anchor) {
      const el = scroller.querySelector(
        '.pdf-pair[data-page="' + saved.anchor.page + '"], .pdf-spread[data-page="' + saved.anchor.page + '"]',
      )
      if (el) {
        const rect = el.getBoundingClientRect()
        const topInContent = rect.top - scroller.getBoundingClientRect().top + scroller.scrollTop
        scroller.scrollTop = Math.max(0, topInContent + saved.anchor.offset * rect.height)
      }
    }
    const maxX = Math.max(0, scroller.scrollWidth - scroller.clientWidth)
    scroller.scrollLeft = Math.round(saved.xRatio * maxX)
  } finally {
    scroller.style.scrollBehavior = previous
  }
  return true
}

/** Pages render async, so re-apply the anchor a few times as layout settles. */
function restoreScrollAnchorLater(saved) {
  if (!saved) return
  restoreScrollAnchor(saved)
  for (const delay of [60, 180, 420, 900]) {
    setTimeout(() => restoreScrollAnchor(saved), delay)
  }
}

function renderPdfView(options = {}) {
  const token = ++pdfRenderToken
  const scroll = $('#reader-scroll')
  const mode = state.mode
  const variant = state.pdfVariant === 'babeldoc' && (state.babeldoc?.dual || state.babeldoc?.mono)
    ? (state.babeldoc.dual ? 'dual' : 'mono')
    : 'source'
  const canLayout = hasLayout()
  const usePairs = variant === 'source' && mode !== 'source' && canLayout

  scroll.innerHTML = renderToolbar()
    + '<div class="pdf-wrap" id="pdf-wrap">'
    + (mode !== 'source' && !canLayout ? layoutBanner() : '')
    + '<p class="pdf-status" id="pdf-status">正在加载 PDF…</p></div>'
  const wrap = $('#pdf-wrap')
  const status = $('#pdf-status')

  getPdfDoc(state.paper.id, variant).catch((err) => {
    // Recoverable: a failed worker fetch or a half-written cache usually heals.
    const host = document.querySelector('.pdf-host')
    if (host) {
      host.innerHTML = '<div class="pdf-fail">PDF 加载失败：' + esc(String(err?.message || err))
        + '<button class="ghost-btn sm" data-retry-pdf="1">重试</button></div>'
    }
    throw err
  }).then(async (doc) => {
    if (token !== pdfRenderToken) return
    status.remove()
    const width = Math.max(320, wrap.clientWidth - 24)
    const columnWidth = usePairs ? (mode === 'dual' ? width / 2 - 18 : width * 0.8)
      : mode === 'source' ? width : width * 0.86
    const count = doc.numPages
    const sizes = []
    let maxW = 0
    for (let i = 1; i <= count; i++) {
      const page = await doc.getPage(i)
      const viewport = page.getViewport({ scale: 1 })
      sizes.push({ page: i, w: viewport.width, h: viewport.height })
      if (viewport.width > maxW) maxW = viewport.width
    }
    if (token !== pdfRenderToken) return
    state.pdf.fit = (columnWidth - 26) / (maxW || 612)
    state.pdf.pages = sizes
    const scale = state.pdf.fit * (state.pdf.zoom || 1)
    state.pdf.scale = scale

    const host = document.createElement('div')
    host.className = 'pdf-host mode-' + mode
    const html = []
    for (const size of sizes) {
      const w = Math.round(size.w * scale)
      const h = Math.round(size.h * scale)
      if (usePairs) {
        html.push('<section class="pdf-pair mode-' + mode + '" data-page="' + size.page + '" data-translated="1">'
          + sheetHtml(size.page, w, h, 'zh')
          + sheetHtml(size.page, w, h, 'en')
          + '</section>')
      } else if (mode === 'source' || canLayout) {
        html.push('<section class="pdf-spread" data-page="' + size.page + '">'
          + sheetHtml(size.page, w, h, 'en')
          + (mode === 'dual' ? '<div class="pdf-notes">' + notesColumnHtml(size.page) + '</div>' : '')
          + '</section>')
      } else {
        html.push('<div class="pdf-notes full" data-page="' + size.page + '">' + notesColumnHtml(size.page) + '</div>')
      }
    }
    host.innerHTML = html.join('')
    wrap.appendChild(host)
    if (options.anchor) restoreScrollAnchorLater(options.anchor)
    observePages(host, scale)
    wirePdfPan()
  }).catch((err) => {
    const el = $('#pdf-status')
    if (el) el.textContent = 'PDF 加载失败：' + (err.message || err)
    console.error('[paper-studio] pdf load failed', err)
  })
}

/** Render pages only when they approach the viewport, at the current scale. */
function observePages(host, scale) {
  pdfCache.observer?.disconnect()
  const root = $('#reader-scroll')
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      observer.unobserve(entry.target)
      drawPage(entry.target, scale)
    }
  }, { root, rootMargin: '700px 0px' })
  pdfCache.observer = observer
  for (const el of host.querySelectorAll('.pdf-page[data-side="zh"], .pdf-page[data-side="en"]')) {
    if (el.closest('.pdf-pair')) {
      // Pairs render through the translated sheet only.
      if (el.dataset.side === 'zh') observer.observe(el)
    } else {
      observer.observe(el)
    }
  }
}

async function drawPage(pageEl, scale) {
  const doc = pdfCache.doc
  if (!doc) return
  const pageNo = Number(pageEl.dataset.page)
  const key = scale.toFixed(4)
  if (pageEl.dataset.renderedAt === key) return
  pageEl.dataset.renderedAt = key
  try {
    const page = await doc.getPage(pageNo)
    const viewport = page.getViewport({ scale })
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    const canvas = pageEl.querySelector('canvas') || document.createElement('canvas')
    canvas.width = Math.floor(viewport.width * ratio)
    canvas.height = Math.floor(viewport.height * ratio)
    canvas.style.width = Math.floor(viewport.width) + 'px'
    canvas.style.height = Math.floor(viewport.height) + 'px'
    const ctx = canvas.getContext('2d')
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.scale(ratio, ratio)
    if (!canvas.isConnected) pageEl.prepend(canvas)
    await page.render({ canvasContext: ctx, viewport }).promise
    await buildTextLayer(pageEl, page, scale).catch(() => {})

    const pair = pageEl.closest('.pdf-pair')
    if (pair) {
      const en = pair.querySelector('.pdf-page[data-side="en"]')
      if (en) {
        const enCanvas = en.querySelector('canvas') || document.createElement('canvas')
        enCanvas.width = canvas.width
        enCanvas.height = canvas.height
        enCanvas.style.width = canvas.style.width
        enCanvas.style.height = canvas.style.height
        enCanvas.getContext('2d').drawImage(canvas, 0, 0)
        if (!enCanvas.isConnected) en.prepend(enCanvas)
        const layer = pageEl.querySelector('.textLayer')
        if (layer) {
          en.querySelector('.textLayer')?.remove()
          const clone = layer.cloneNode(true)
          en.appendChild(clone)
        }
      }
      paintOverlay(pair, scale)
    }
  } catch (err) {
    console.error('[paper-studio] page render failed', err)
    delete pageEl.dataset.renderedAt
  }
}

/**
 * Lay the Chinese text back onto the page at the original block positions:
 * an opaque patch over the English, then the translation in the same box.
 * Untranslated blocks keep their English, so a half-translated paper reads
 * as a mixed page instead of losing content.
 */
/** Text that belongs to a figure, a stamp or a margin: leave it alone. */
function isFigureText(block) {
  const text = String(block.text || '').trim()
  if (!text) return true
  if (block.heading === 'h') return false
  // Figure labels, axis ticks and table cells are short and unpunctuated.
  if (text.length < 26 && !/[.。!?！？]$/.test(text)) return true
  // arXiv stamps and page furniture live in the margins.
  const page = state.text?.pages?.find((p) => p.page === block.page)
  const pageW = page?.w || 612
  if (block.x < pageW * 0.07 || block.x + block.w > pageW * 0.93) return true
  if ((block.size || 10) < 7.4) return true
  return false
}

/** Background colour around a block: probe just outside its text box, take
    the most common colour so dark glyph pixels never win. */
function sampleBlockBg(pageEl, block, scale) {
  const canvas = pageEl?.querySelector('canvas')
  if (!canvas) return '#ffffff'
  try {
    const ratio = canvas.width / (parseFloat(canvas.style.width) || canvas.width)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    const bx = block.x * scale
    const by = block.y * scale
    const bw = Math.max(8, block.w * scale)
    const bh = Math.max(6, block.h * scale)
    const pad = Math.max(3, 5 * scale)
    const probes = [
      [bx - pad, by + bh / 2], [bx + bw + pad, by + bh / 2],
      [bx + bw / 2, by - pad], [bx + bw / 2, by + bh + pad],
      [bx - pad, by - pad], [bx + bw + pad, by + bh + pad],
      [bx + bw / 2, by + bh / 2],
    ]
    const buckets = new Map()
    for (const [px, py] of probes) {
      const x = Math.round(px * ratio)
      const y = Math.round(py * ratio)
      if (x < 1 || y < 1 || x >= canvas.width - 1 || y >= canvas.height - 1) continue
      const data = ctx.getImageData(x, y, 1, 1).data
      if (data[3] < 8) continue
      const key = (data[0] >> 4) + ':' + (data[1] >> 4) + ':' + (data[2] >> 4)
      const entry = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 }
      entry.n += 1; entry.r += data[0]; entry.g += data[1]; entry.b += data[2]
      buckets.set(key, entry)
    }
    if (!buckets.size) return '#ffffff'
    const best = [...buckets.values()].sort((a, b) => b.n - a.n)[0]
    const r = Math.round(best.r / best.n)
    const g = Math.round(best.g / best.n)
    const b = Math.round(best.b / best.n)
    // Never cover text with a dark slab: unreadable pages fall back to white.
    const lum = 0.299 * r + 0.587 * g + 0.114 * b
    return lum < 70 ? '#ffffff' : 'rgb(' + r + ',' + g + ',' + b + ')'
  } catch {
    return '#ffffff'
  }
}

function paintOverlay(pair, scale) {
  const layer = pair.querySelector('.pdf-overlay')
  if (!layer) return
  const pageEl = pair.querySelector('.pdf-page[data-side="zh"]') || pair.querySelector('.pdf-page')
  const page = Number(pair.dataset.page)
  const blocks = (state.text?.paragraphs || [])
    .filter((p) => p.page === page && typeof p.x === 'number' && !isFigureText(p))

  layer.innerHTML = ''
  for (const block of blocks) {
    const zh = translationOf(block)
    if (!zh) continue
    const left = block.x * scale
    const top = block.y * scale
    const width = Math.max(20, block.w * scale)
    const height = Math.max(8, block.h * scale)

    const patch = document.createElement('i')
    patch.className = 'pdf-ov-patch'
    patch.style.left = (left - 1) + 'px'
    patch.style.top = (top - 1) + 'px'
    patch.style.width = (width + 3) + 'px'
    patch.style.height = (height + 3) + 'px'
    patch.style.background = sampleBlockBg(pageEl, block, scale)

    const text = document.createElement('div')
    text.className = 'pdf-ov-text'
    text.style.left = left + 'px'
    text.style.top = top + 'px'
    text.style.width = (width + 2) + 'px'
    text.textContent = zh
    text.dataset.baseSize = String(Math.max(5.5, (block.size || 9) * scale * 0.96))
    text.dataset.maxHeight = String(height + 2)
    layer.append(patch, text)
  }

  // Second pass: shrink until the translation fits the original block.
  requestAnimationFrame(() => {
    for (const el of layer.querySelectorAll('.pdf-ov-text')) {
      let size = parseFloat(el.dataset.baseSize) || 9
      let line = size * 1.14
      const maxH = parseFloat(el.dataset.maxHeight) || 20
      for (let i = 0; i < 10; i++) {
        el.style.fontSize = size.toFixed(1) + 'px'
        el.style.lineHeight = line.toFixed(1) + 'px'
        if (el.scrollHeight <= maxH + line * 0.55) break
        size *= 0.93
        line *= 0.93
        if (size < 4.4) break
      }
    }
  })
}

function setPdfZoom(next) {
  const zoom = Math.max(0.5, Math.min(3, next))
  state.pdf.zoom = zoom
  STORE.set('pdfZoom', zoom)
  const anchor = captureScrollAnchor()
  renderPdfView({ anchor })
}

/** Drag to pan the PDF surface. */
function wirePdfPan() {
  const wrap = $('#pdf-wrap')
  const scroller = $('#reader-scroll')
  if (!wrap || !scroller || wrap.dataset.panWired) return
  wrap.dataset.panWired = '1'
  // No drag-to-pan: the mouse is for selecting text. Moving around the page is
  // zoom + the scrollbars (the horizontal one at the bottom of the reader).
  wrap.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    setPdfZoom((state.pdf.zoom || 1) * (e.deltaY < 0 ? 1.12 : 0.89))
  }, { passive: false })
}

function jumpToPage(page) {
  const printed = $(`.para[data-page="${page}"]`) || $(`.heading-para[data-page="${page}"]`)
  if (printed) {
    printed.scrollIntoView({ block: 'center', behavior: 'smooth' })
    printed.classList.add('hl')
    setTimeout(() => printed.classList.remove('hl'), 2200)
    return true
  }
  // PDF view: bring the page sheet into view instead.
  const sheet = $(`.pdf-pair[data-page="${page}"]`) || $(`.pdf-page[data-page="${page}"]`)
  if (sheet) {
    sheet.scrollIntoView({ block: 'start', behavior: 'smooth' })
    sheet.classList.add('flash')
    setTimeout(() => sheet.classList.remove('flash'), 1200)
    return true
  }
  return false
}

// ── 8. translation ────────────────────────────────────────────────────────

async function translateAll({ onlyMissing = false, ids: onlyIds = null, force = false } = {}) {
  const style = state.config?.translateStyle || 'academic'
  if (!hasText()) return
  // A second click never starts a second pass: it stops the running one.
  // Everything already translated is cached server-side, so a restart resumes.
  if (state.busy.translate) {
    state.translate.controller?.abort()
    return
  }
  state.busy.translate = true
  const controller = new AbortController()
  state.translate.controller = controller
  state.translate.done = 0
  state.translate.total = 0
  const button = $('#btn-translate-all')
  button.disabled = false
  button.textContent = '翻译中…'
  let done = 0
  let total = 0
  progress(onlyMissing ? '翻译未译段落…' : '翻译全文…')
  try {
    const ids = onlyIds
      ? onlyIds
      : onlyMissing
        ? state.text.paragraphs.filter((p) => !state.translations[p.i]?.text && (p.heading === 'h' || !isFigureText(p))).map((p) => p.i)
        : force
          ? state.text.paragraphs.filter((p) => p.heading === 'h' || !isFigureText(p)).map((p) => p.i)
          : undefined
    await streamApi(`/paper/${state.paper.id}/translate`, { target: 'zh', ids, force, style }, (event) => {
      if (event.type === 'start') {
        total = event.total
        state.translate.total = total
      }
      if (event.type === 'para') {
        done = event.done || done + 1
        if (event.text) {
          state.translations[event.i] = { text: event.text, at: Date.now() }
          paintTranslation(event.i, event.text)
          paintPdfNote(event.i, event.text)
          repaintOverlayFor(event.i)
        }
        state.translate.done = done
        setProgress(total ? done / total : 0)
        progress(`翻译中 ${done}/${total}（再点一次停止）`)
        button.textContent = done + '/' + total
      }
      if (event.type === 'done') {
        setProgress(1)
        progress(`翻译完成 · ${event.saved} 段`)
        setTimeout(() => progress(null), 1800)
        refreshPdfNotes()
      }
    }, controller.signal)
  } catch (err) {
    progress(null)
    if (String(err?.message || err).includes('abort')) toast('已停止翻译，已完成的段落会保存')
    else toast(`翻译中断：${err.message || err}`, 'error')
  } finally {
    state.busy.translate = false
    state.translate.controller = null
    button.disabled = false
    button.textContent = '全文翻译'
    setTimeout(() => { if (!state.busy.translate) progress(null) }, 2000)
    if (state.paper) {
      try {
        const fresh = await api(`/paper/${state.paper.id}`)
        state.paper = fresh.paper
        state.translationModels = fresh.translationModels || []
      } catch { /* keep the old summary */ }
    }
    refreshPdfNotes()
    await refreshLibrary()
  }
}

/** Patch one paragraph's Chinese into the PDF translation column, if shown. */
/** Repaint the translated page that owns this paragraph. */
function repaintOverlayFor(index) {
  if (state.view !== 'pdf' || state.mode === 'source') return
  const block = state.text?.paragraphs?.[index]
  if (!block || typeof block.page !== 'number') return
  const pair = $('.pdf-pair[data-page="' + block.page + '"]')
  if (pair?.querySelector('.pdf-overlay')) paintOverlay(pair, state.pdf.scale || 1)
}

function paintPdfNote(index, text) {
  const note = $(`.pdf-note[data-i="${index}"]`)
  if (note) note.innerHTML = `<p class="zh">${esc(text)}</p>`
}

function refreshPdfNotes() {
  if (state.view !== 'pdf' || !state.text) return
  for (const column of $$('.pdf-notes')) {
    const page = Number(column.dataset.page || column.closest('.pdf-spread')?.dataset.page || 0)
    if (page) column.innerHTML = notesColumnHtml(page)
  }
}

function paintTranslation(index, text) {
  const para = $(`.para[data-i="${index}"]`)
  if (!para) return
  const tr = $('.tr', para)
  if (!tr) return
  tr.textContent = text
  tr.hidden = state.mode === 'source'
}

async function translateSelection(text) {
  const para = state.selectionPara
  if (!text) return
  if (para) {
    const tr = $('.tr', para)
    if (tr) {
      tr.hidden = false
      tr.classList.add('loading')
      tr.textContent = '翻译中…'
    }
  }
  try {
    let out = ''
    await streamApi(`/paper/${state.paper.id}/translate-selection`, { text, target: 'zh' }, (event) => {
      void 0
      if (event.type === 'delta') {
        out += event.text
        if (para) {
          const tr = $('.tr', para)
          if (tr) { tr.classList.remove('loading'); tr.textContent = out }
        }
      }
    })
    if (para) {
      const index = Number(para.dataset.i)
      if (Number.isFinite(index)) state.translations[index] = { text: out, at: Date.now() }
    }
  } catch (err) {
    toast(`翻译失败：${err.message || err}`, 'error')
    if (para) { const tr = $('.tr', para); if (tr) tr.textContent = '' }
  }
}

function exportParallel() {
  if (!hasText()) return
  const lines = [`# ${state.paper.title || ''}`, '']
  for (const p of state.text.paragraphs) {
    if (p.heading === 'h') { lines.push(`\n## ${p.text}`, ''); continue }
    lines.push(`> ${p.text}`, '')
    const zh = state.translations[p.i]?.text
    if (zh) lines.push(zh, '')
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${(state.paper.title || 'paper').slice(0, 60)}-对照.md`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 3000)
}

// ── 9. chat / notes / figures ─────────────────────────────────────────────

function renderChat() {
  const log = $('#chat-log')
  if (!state.messages.length) {
    log.innerHTML = `<div class="chat-empty">
      <b>伴读</b> 已经读完这篇论文的 ${state.text?.paragraphs?.length ?? 0} 个段落。
      回答只依据原文，并给出页码——点「第 N 页」可以跳回那一行。
    </div>`
  } else {
    log.innerHTML = state.messages.map((m) => messageHtml(m)).join('')
  }
  log.scrollTop = log.scrollHeight
  renderStarters()
  $('#chat-send').disabled = state.busy.chat || !state.paper
}

function messageHtml(m) {
  const body = m.html ?? linkCitations(renderMarkdown(m.content || ''))
  const pages = [...new Set((m.citations || []).map((c) => c.page))].slice(0, 6)
  const cites = pages.map((page) => '<button class="cite" data-page="' + page + '">第 ' + page + ' 页</button>').join('')
  const actions = m.role === 'assistant' && !m.pending
    ? '<div class="msg-actions">'
      + '<button data-msg-act="copy" title="复制回答">复制</button>'
      + '<button data-msg-act="regen" title="用同样的问题重新回答">重写</button>'
      + '</div>'
    : ''
  return `<div class="msg ${m.role}">
    <div class="role">${m.role === 'user' ? '你' : '伴读'}${m.pending ? '<span class="caret"></span>' : ''}</div>
    <div class="bubble">${body}</div>
    ${cites ? '<div class="msg-cites"><span>依据</span>' + cites + '</div>' : ''}
    ${actions}
  </div>`
}

function renderStarters() {
  const box = $('#chat-starters')
  if (state.messages.length || !state.paper) { box.innerHTML = ''; return }
  const suggestions = state.suggestions || []
  box.innerHTML = suggestions.map((s) => `<button data-q="${esc(s.prompt)}">${esc(s.label)}</button>`).join('')
}

async function ask(question) {
  const text = String(question || '').trim()
  if (!text || !state.paper) return
  if (state.busy.chat) {
    toast('上一条还在生成：点「停止」可以中断，或等一下', 'error')
    return
  }
  if (!hasText()) { toast('先解析正文才能检索', 'error'); return }
  state.busy.chat = true
  $('#chat-send').disabled = true
  $('#chat-stop').hidden = false
  const controller = new AbortController()
  state.chatController = controller
  // Watchdog: a stalled stream must never lock the composer forever.
  let watchdog = setTimeout(() => controller.abort(), 120000)
  const bump = () => { clearTimeout(watchdog); watchdog = setTimeout(() => controller.abort(), 120000) }
  const useSelection = $('#chat-with-selection').checked && state.selectionText
  const assistant = { role: 'assistant', content: '', pending: true }
  state.messages.push({ role: 'user', content: text })
  state.messages.push(assistant)
  const log = $('#chat-log')
  log.innerHTML = state.messages.map((m) => messageHtml(m)).join('')
  log.scrollTop = log.scrollHeight
  renderStarters()
  const bubble = log.querySelector('.msg.assistant:last-child .bubble')
  const target = bubble?.closest('.msg')?.querySelector('.role')
  let answer = ''
  try {
    await streamApi(`/paper/${state.paper.id}/chat`, {
      question: text,
      mode: 'auto',
      history: state.messages.slice(-9, -2).map((m) => ({ role: m.role, content: m.content })),
      selection: useSelection ? state.selectionText : '',
      ...(state.chatModel ? (function () {
        const parts = state.chatModel.split('/')
        return { provider: parts[0], model: parts.slice(1).join('/') }
      })() : {}),
    }, (event) => {
      void 0
      if (event.type === 'delta') {
        answer += event.text
        bump()
        if (bubble) bubble.innerHTML = linkCitations(renderMarkdown(answer)) + '<span class="caret"></span>'
        log.scrollTop = log.scrollHeight
      }
      if (event.type === 'done') {
        answer = event.answer || answer
        assistant.content = answer
        assistant.citations = event.citations || []
        assistant.pending = false
        if (bubble) bubble.innerHTML = linkCitations(renderMarkdown(answer))
        if (target) target.querySelector('.caret')?.remove()
        // The answer is complete: release the composer even if the socket lingers.
        state.busy.chat = false
        $('#chat-send').disabled = false
        $('#chat-stop').hidden = true
      }
    }, controller.signal)
    assistant.pending = false
    saveThreads()
  } catch (err) {
    assistant.pending = false
    if (String(err?.name) === 'AbortError') {
      assistant.content = answer || '（已停止）'
      if (bubble) bubble.innerHTML = linkCitations(renderMarkdown(assistant.content))
      if (target) target.querySelector('.caret')?.remove()
      saveThreads()
      return
    }
    assistant.content = `生成失败：${err.message || err}`
    if (bubble) bubble.innerHTML = `<em>${esc(assistant.content)}</em>`
    toast(`对话失败：${err.message || err}`, 'error')
  } finally {
    clearTimeout(watchdog)
    state.busy.chat = false
    $('#chat-send').disabled = false
    $('#chat-stop').hidden = true
    state.chatController = null
    renderChat()
    refreshLibrary().catch(() => {})
  }
}

function saveThreads() {
  if (!state.paper) return
  const thread = {
    id: 'main',
    title: state.messages.find((m) => m.role === 'user')?.content?.slice(0, 40) || '新对话',
    updatedAt: Date.now(),
    messages: state.messages.filter((m) => !m.pending).map((m) => ({ role: m.role, content: m.content })),
  }
  const others = (state.threads || []).filter((t) => t.id !== 'main')
  state.threads = [thread, ...others]
  api(`/paper/${state.paper.id}/threads`, { method: 'POST', body: JSON.stringify({ threads: state.threads }) }).catch(() => {})
}

// notes -------------------------------------------------------------------

const saveNotes = debounce(async () => {
  if (!state.paper) return
  $('#notes-state').textContent = '保存中…'
  $('#notes-state').className = 'save-state saving'
  try {
    await api(`/paper/${state.paper.id}/notes`, { method: 'POST', body: JSON.stringify({ markdown: state.notes }) })
    $('#notes-state').textContent = '已保存'
    $('#notes-state').className = 'save-state'
    const paper = state.papers.find((p) => p.id === state.paper.id)
    if (paper) paper.noteUpdatedAt = Date.now()
  } catch {
    $('#notes-state').textContent = '保存失败'
    $('#notes-state').className = 'save-state error'
  }
}, 900)

function appendNote(text) {
  const quote = String(text || '').trim()
  if (!quote) return
  const block = `\n> ${quote.split('\n').join('\n> ')}\n\n`
  state.notes = `${state.notes}${state.notes && !state.notes.endsWith('\n') ? '\n' : ''}${block}`
  $('#notes-editor').value = state.notes
  saveNotes()
  switchTab('notes')
  toast('已记入笔记')
}

// figures -----------------------------------------------------------------

function switchTab(tab) {
  state.tab = tab
  STORE.set('tab', tab)
  $$('.side-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab))
  $$('.pane').forEach((p) => { p.hidden = p.dataset.pane !== tab })
  if (tab === 'discover' && !state.discover.loaded && !state.discover.loading) loadDiscover()
}

async function generateFigure(kind) {
  if (!state.paper || state.busy.figure) return
  if (!hasText()) { toast('先解析正文才能生成图', 'error'); return }
  state.busy.figure = true
  const body = $('#fig-body')
  body.innerHTML = `<p class="fig-hint">正在阅读方法与结构，生成${kind === 'concept' ? '论证地图' : kind === 'compare' ? '方法对照' : '框架图'}…（约 20–60 秒）</p>`
  try {
    const { figure } = await api(`/paper/${state.paper.id}/figure`, {
      method: 'POST',
      body: JSON.stringify({ kind }),
    })
    state.figures = [figure, ...(state.figures || [])]
    renderFigures()
  } catch (err) {
    body.innerHTML = `<p class="fig-hint">生成失败：${esc(err.message || err)}</p>`
    toast(`生成失败：${err.message || err}`, 'error')
  } finally {
    state.busy.figure = false
  }
}

function renderFigures() {
  const body = $('#fig-body')
  if (!state.figures?.length) {
    body.innerHTML = `<p class="fig-hint">模型先读懂方法再画图：从输入、核心模块到输出，生成可编辑、可导出的矢量图。</p>`
    return
  }
  const [latest, ...rest] = state.figures
  body.innerHTML = `
    <div class="fig-card">
      <h4>${esc(latest.title)}</h4>
      <div class="sub">${esc(latest.subtitle || '')}</div>
      <div class="fig-svg" id="fig-main">${renderFigureSvg(latest)}</div>
      <p class="fig-zoom-hint">点击图放大查看 · ${latest.nodes?.length ?? 0} 个节点 · ${(latest.groups || []).map((g) => g.label).join(' → ')}</p>
      <div class="fig-actions">
        <button class="ghost-btn sm" data-fig-export="svg">导出 SVG</button>
        <button class="ghost-btn sm" data-fig-export="png">导出 PNG</button>
        <button class="ghost-btn sm" data-fig-regen="${esc(latest.kind || 'framework')}">重画</button>
      </div>
    </div>
    ${rest.length ? `<div class="fig-history"><h5>历史</h5>${rest.map((f) => `
      <div class="fig-card" data-fig-id="${esc(f.id || '')}">
        <h4 style="font-size:13px">${esc(f.title)}</h4>
        <div class="sub">${esc(f.subtitle || '')} · ${timeAgo(f.createdAt)}</div>
        <div class="fig-svg">${renderFigureSvg(f, 0.82)}</div>
      </div>`).join('')}</div>` : ''}`
}

const KIND_STYLE = {
  data: { fill: '#eef3f8', stroke: '#b9cbdc', label: '#1f4e79' },
  module: { fill: '#fffdf8', stroke: '#c9bda9', label: '#2f2a24' },
  loss: { fill: '#fbf3e2', stroke: '#dcc08a', label: '#7a5612' },
  result: { fill: '#eef4ee', stroke: '#b9cfba', label: '#2f5a36' },
  problem: { fill: '#f7eaea', stroke: '#dcb6b4', label: '#7d2b33' },
  insight: { fill: '#f1eef8', stroke: '#c5bade', label: '#453564' },
  limit: { fill: '#f2f0ec', stroke: '#cdc7bd', label: '#5b564e' },
  note: { fill: '#fffdf8', stroke: '#c9bda9', label: '#2f2a24' },
}

/** Deterministic band layout: stages top-to-bottom, nodes left-to-right. */
function renderFigureSvg(spec, scale = 1) {
  const nodes = spec.nodes || []
  const groups = (spec.groups?.length ? spec.groups : [{ id: 'g1', label: '方法' }])
  const W = 680
  const pad = 18
  const gapX = 14
  const headerH = 20
  const nodeH = 62
  const bandGap = 26
  const byGroup = new Map(groups.map((g) => [g.id, []]))
  for (const n of nodes) {
    if (!byGroup.has(n.group)) byGroup.set(n.group, [])
    byGroup.get(n.group).push(n)
  }
  const positions = new Map()
  let y = 12
  const bands = []
  for (const g of groups) {
    const items = byGroup.get(g.id) || []
    if (!items.length) continue
    const cols = items.length <= 3 ? items.length : Math.ceil(items.length / 2)
    const rows = Math.ceil(items.length / cols)
    const innerW = W - pad * 2 - 16
    const nodeW = Math.max(110, Math.floor((innerW - gapX * (cols - 1)) / cols))
    const bandH = headerH + rows * nodeH + (rows - 1) * 10 + 10
    bands.push({ group: g, y, h: bandH, items, cols, rows, nodeW })
    for (let i = 0; i < items.length; i++) {
      const row = Math.floor(i / cols)
      const col = i % cols
      const inRow = Math.min(cols, items.length - row * cols)
      const rowPad = (innerW - (inRow * nodeW + (inRow - 1) * gapX)) / 2
      positions.set(items[i].id, {
        x: pad + 8 + rowPad + col * (nodeW + gapX),
        y: y + headerH + 4 + row * (nodeH + 10),
        w: nodeW,
        h: nodeH,
      })
    }
    y += bandH + bandGap
  }
  const H = y + 20

  const arrow = (a, b, style) => {
    const from = positions.get(a)
    const to = positions.get(b)
    if (!from || !to) return ''
    const dash = style === 'dashed' ? ' stroke-dasharray="4 4"' : ''
    const sameRow = Math.abs(from.y - to.y) < 8
    if (sameRow && from.x < to.x) {
      const x1 = from.x + from.w
      const y1 = from.y + from.h / 2
      const x2 = to.x - 4
      return `<path d="M${x1} ${y1} H${x2}" fill="none" stroke="#a2937c" stroke-width="1.3"${dash} marker-end="url(#arrow)"/>`
    }
    const x1 = from.x + from.w / 2
    const y1 = from.y + from.h
    const x2 = to.x + to.w / 2
    const y2 = to.y - 3
    if (y2 <= y1 + 4) {
      // Upward/back edge: route around the right side.
      const midX = Math.max(from.x + from.w, to.x + to.w) + 16
      return `<path d="M${x1} ${y1 - from.h / 2} H${midX} V${to.y + to.h / 2} H${to.x + to.w + 3}" fill="none" stroke="#a2937c" stroke-width="1.3"${dash} marker-end="url(#arrow)"/>`
    }
    const midY = (y1 + y2) / 2
    return `<path d="M${x1} ${y1 + 2} V${midY} H${x2} V${y2}" fill="none" stroke="#a2937c" stroke-width="1.3"${dash} marker-end="url(#arrow)"/>`
  }

  const wrapText = (text, maxChars, maxLines) => {
    const chars = [...String(text)]
    const lines = []
    for (let i = 0; i < chars.length && lines.length < maxLines; i += maxChars) {
      lines.push(chars.slice(i, i + maxChars).join(''))
    }
    if ([...String(text)].length > maxChars * maxLines) lines[maxLines - 1] = lines[maxLines - 1].slice(0, -1) + '…'
    return lines
  }

  const bandSvg = bands.map((band, index) => {
    const style = KIND_STYLE[band.items[0]?.kind] || KIND_STYLE.module
    return `<g>
      <rect x="${pad}" y="${band.y}" width="${W - pad * 2}" height="${band.h}" rx="10"
        fill="${style.fill}" fill-opacity="0.42" stroke="${style.stroke}" stroke-opacity="0.55" stroke-dasharray="3 3"/>
      <text x="${pad + 12}" y="${band.y + 14}" font-size="10.5" fill="#8a7f6d"
        letter-spacing="1.4" font-family="'Segoe UI','PingFang SC',sans-serif">${esc(String(band.group.label || '').toUpperCase())}</text>
    </g>`
  }).join('')

  const nodeSvg = nodes.map((n) => {
    const p = positions.get(n.id)
    if (!p) return ''
    const style = KIND_STYLE[n.kind] || KIND_STYLE.module
    const lines = wrapText(n.label, Math.max(7, Math.floor((p.w - 22) / 13)), 2)
    const descLines = n.desc ? wrapText(n.desc, Math.max(9, Math.floor((p.w - 22) / 10.6)), 2) : []
    const textY = p.y + 20 + (lines.length === 1 ? 8 : 0)
    const label = lines.map((line, i) => `<text x="${p.x + p.w / 2}" y="${textY + i * 15}" text-anchor="middle"
      font-size="12.4" font-weight="600" fill="${style.label}" font-family="'PingFang SC','Segoe UI',sans-serif">${esc(line)}</text>`).join('')
    const desc = descLines.map((line, i) => `<text x="${p.x + p.w / 2}" y="${textY + lines.length * 15 + 2 + i * 12}" text-anchor="middle"
      font-size="9.8" fill="#7d7364" font-family="'PingFang SC','Segoe UI',sans-serif">${esc(line)}</text>`).join('')
    return `<g class="fig-node" data-node="${esc(n.id)}">
      <rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="7" fill="#fffdf8" stroke="${style.stroke}" stroke-width="1.1"/>
      <rect x="${p.x}" y="${p.y}" width="3" height="${p.h}" rx="1.5" fill="${style.label}" opacity="0.55"/>
      ${label}${desc}
    </g>`
  }).join('')

  const edgeSvg = (spec.edges || []).map((e) => arrow(e.from, e.to, e.style)).join('')

  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" style="max-width:${Math.round(scale * 100)}%">
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M0 0 L10 5 L0 10 z" fill="#a2937c"/>
      </marker>
    </defs>
    <rect x="0" y="0" width="${W}" height="${H}" fill="#fdfbf6"/>
    ${bandSvg}
    ${edgeSvg}
    ${nodeSvg}
  </svg>`
}

function openFigureModal(svgEl, title) {
  if (!svgEl) return
  const body = $('#fig-modal-body')
  body.innerHTML = ''
  const clone = svgEl.cloneNode(true)
  clone.removeAttribute('style')
  body.appendChild(clone)
  $('#fig-modal-title').textContent = title || '框架图'
  $('#fig-modal').hidden = false
}

function exportFigure(kind, svgEl = null) {
  const svg = svgEl || $('#fig-main')?.querySelector('svg')
  if (!svg) return
  if (kind === 'svg') {
    const blob = new Blob([svg.outerHTML], { type: 'image/svg+xml' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${(state.paper?.title || 'figure').slice(0, 40)}-${state.figures[0]?.kind || 'framework'}.svg`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 3000)
    return
  }
  const data = new XMLSerializer().serializeToString(svg)
  const image = new Image()
  const url = URL.createObjectURL(new Blob([data], { type: 'image/svg+xml' }))
  image.onload = () => {
    const ratio = 2
    const canvas = document.createElement('canvas')
    canvas.width = image.width * ratio
    canvas.height = image.height * ratio
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fdfbf6'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    const a = document.createElement('a')
    a.href = canvas.toDataURL('image/png')
    a.download = `${(state.paper?.title || 'figure').slice(0, 40)}.png`
    a.click()
    URL.revokeObjectURL(url)
  }
  image.src = url
}

// ── 10. wiring + boot ─────────────────────────────────────────────────────

/** Two-step delete: the first click arms the button, the second removes. */
async function requestDeletePaper(id, button) {
  if (!id) return
  const paper = state.papers.find((p) => p.id === id)
  if (button.dataset.armed === '1') {
    button.disabled = true
    button.textContent = '…'
    try {
      await api('/paper/' + id, { method: 'DELETE' })
      state.papers = state.papers.filter((p) => p.id !== id)
      if (state.activeId === id) {
        state.paper = null
        state.activeId = null
        state.text = null
        state.translations = {}
        state.messages = []
        state.notes = ''
        state.figures = []
        renderReader()
        renderChat()
      }
      renderLibrary()
      toast('已删除：' + (paper?.title || id))
      refreshLibrary().catch(() => {})
    } catch (err) {
      toast('删除失败：' + (err.message || err), 'error')
      button.disabled = false
      button.textContent = '删除'
      delete button.dataset.armed
    }
    return
  }
  button.dataset.armed = '1'
  button.classList.add('confirm')
  const label = button.querySelector('span.arm')
  if (label) label.textContent = '确认删除？'
  else button.insertAdjacentHTML('beforeend', '<span class="arm">确认删除？</span>')
  clearTimeout(button._armTimer)
  button._armTimer = setTimeout(() => {
    delete button.dataset.armed
    button.classList.remove('confirm')
    button.querySelector('span.arm')?.remove()
  }, 3500)
}

async function openPaper(id) {
  state.activeId = id
  STORE.set('lastPaper', id)
  renderLibrary()
  const data = await api(`/paper/${id}`)
  state.paper = data.paper
  state.notes = data.notes || ''
  state.translationModels = data.translationModels || []
  state.babeldoc = data.babeldoc || null
  state.pdfVariant = 'source'
  state.figures = data.figures?.items || []
  state.threads = data.chats?.threads || []
  state.suggestions = data.suggestions || []
  state.messages = (state.threads.find((t) => t.id === 'main')?.messages || []).map((m) => ({ ...m }))
  $('#notes-editor').value = state.notes
  $('#notes-preview').innerHTML = renderMarkdown(state.notes)
  state.text = null
  state.translations = {}
  state.discover = { loading: false, loaded: false, related: [], trending: [], at: 0, error: null }
  if (data.hasText) {
    const [text, zh] = await Promise.all([
      api(`/paper/${id}/text`),
      api(`/paper/${id}/zh`).catch(() => ({ entries: {} })),
    ])
    state.text = text
    state.translations = zh.entries || {}
  }
  setMode(state.mode)
  renderReader()
  renderChat()
  renderFigures()
  switchTab(state.tab)
  if (!data.hasText) parsePaper(id)
}

function wire() {
  // top bar
  $('#btn-sidebar').onclick = () => {
    state.railHidden = !state.railHidden
    STORE.set('railHidden', state.railHidden)
    $('#rail').classList.toggle('collapsed', state.railHidden)
  }
  $$('#mode-switch button').forEach((b) => {
    b.onclick = () => { setMode(b.dataset.mode); applyModeVisibility() }
  })
  $('#btn-translate-all').onclick = () => translateAll()
  $('#btn-settings').onclick = () => openSettings()
  $('#settings-close').onclick = () => { $('#settings').hidden = true }
  $('#settings').onclick = (e) => { if (e.target.id === 'settings') $('#settings').hidden = true }

  // library
  $('#search').oninput = debounce((e) => { state.query = e.target.value; renderLibrary() }, 120)
  $('#btn-import').onclick = () => {
    $('#import-dialog').hidden = false
    setTimeout(() => $('#import-url-input')?.focus(), 40)
  }
  $('#import-dialog-close').onclick = () => { $('#import-dialog').hidden = true }
  $('#import-dialog').addEventListener('mousedown', (e) => {
    if (e.target.id === 'import-dialog') $('#import-dialog').hidden = true
  })
  $('#import-url-form').onsubmit = (e) => {
    e.preventDefault()
    const value = $('#import-url-input').value.trim()
    if (!value) return
    $('#import-dialog').hidden = true
    $('#import-url-input').value = ''
    importUrl(value)
  }
  $('#import-pick-file').onclick = () => {
    $('#import-dialog').hidden = true
    $('#file-input').click()
  }
  $('#btn-browse').onclick = () => $('#file-input').click()
  $('#file-input').onchange = (e) => { importFiles(e.target.files); e.target.value = '' }
  $('#btn-new-folder').onclick = () => {
    const form = $('#new-folder-form')
    form.hidden = !form.hidden
    if (!form.hidden) setTimeout(() => $('#new-folder-name')?.focus(), 30)
  }
  $('#new-folder-cancel').onclick = () => {
    $('#new-folder-form').hidden = true
    $('#new-folder-name').value = ''
  }
  $('#new-folder-form').onsubmit = async (e) => {
    e.preventDefault()
    const name = $('#new-folder-name').value.trim()
    if (!name) return
    try {
      await api('/folders', { method: 'POST', body: JSON.stringify({ name }) })
      $('#new-folder-form').hidden = true
      $('#new-folder-name').value = ''
      await refreshLibrary()
      toast('已创建专题：' + name)
    } catch (err) {
      toast('创建失败：' + (err.message || err), 'error')
    }
  }
  $('#url-form').onsubmit = (e) => { e.preventDefault(); importUrl($('#url-input').value); $('#url-input').value = '' }

  $('#library-list').onclick = async (e) => {
    const rename = e.target.closest('[data-folder-rename]')
    if (rename) {
      e.stopPropagation()
      const name = prompt('新名称')
      if (name) { await api(`/folders/${rename.dataset.folderRename}`, { method: 'POST', body: JSON.stringify({ name }) }); await refreshLibrary() }
      return
    }
    const toggle = e.target.closest('[data-folder-toggle]')
    if (toggle) {
      const id = toggle.dataset.folderToggle
      const set = new Set(state.collapsed)
      if (set.has(id)) set.delete(id); else set.add(id)
      state.collapsed = [...set]
      STORE.set('collapsedFolders', state.collapsed)
      renderLibrary()
      return
    }
    const del = e.target.closest('[data-del-paper]')
    if (del) {
      e.stopPropagation()
      requestDeletePaper(del.dataset.delPaper, del)
      return
    }
    const card = e.target.closest('[data-paper]')
    if (card) openPaper(card.dataset.paper)
  }

  // drop zone
  const drop = $('#drop')
  ;['dragenter', 'dragover'].forEach((type) => drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('over') }))
  ;['dragleave', 'drop'].forEach((type) => drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.remove('over') }))
  drop.addEventListener('drop', (e) => importFiles(e.dataTransfer.files))
  window.addEventListener('dragover', (e) => e.preventDefault())
  window.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer?.files?.length) importFiles(e.dataTransfer.files) })

  // reader toolbar (delegated: the reader is re-rendered constantly)
  $('#reader-scroll').addEventListener('click', (e) => {
    const zoomBtn = e.target.closest('[data-zoom]')
    if (zoomBtn) {
      const action = zoomBtn.dataset.zoom
      if (action === 'in') setPdfZoom((state.pdf.zoom || 1) * 1.2)
      else if (action === 'out') setPdfZoom((state.pdf.zoom || 1) / 1.2)
      else if (action === 'fit') setPdfZoom(1)
      else setPdfZoom(1 / (state.pdf.fit || 1))
      return
    }
    if (e.target.closest('[data-reparse]')) { parsePaper(state.paper.id); return }
    const pageBtn = e.target.closest('[data-translate-page]')
    if (pageBtn) {
      const page = Number(pageBtn.dataset.translatePage)
      const ids = pageParagraphs(page).filter((p) => !translationOf(p)).map((p) => p.i)
      if (ids.length) translateAll({ ids })
      return
    }
    const variantBtn = e.target.closest('[data-variant]')
    if (variantBtn) {
      state.pdfVariant = variantBtn.dataset.variant
      renderReader({ anchor: captureScrollAnchor() })
      return
    }
    if (e.target.closest('[data-retry-pdf]')) {
      pdfCache.doc = null
      pdfCache.paperId = null
      renderReader()
      return
    }
    if (e.target.id === 'btn-babeldoc') { runBabeldoc(); return }
    if (e.target.id === 'btn-retranslate') { translateAll({ force: true }); return }
    if (e.target.id === 'btn-translate-todo') { translateAll({ onlyMissing: true }); return }
    if (e.target.id === 'btn-export') { exportParallel(); return }
    if (e.target.id === 'btn-parse') { parsePaper(state.paper.id); return }
    const cite = e.target.closest('.cite')
    if (cite) { if (!jumpToPage(Number(cite.dataset.page))) toast(`第 ${cite.dataset.page} 页的段落不在当前视图里`) }
  })


  // chat
  $('#chat-form').onsubmit = (e) => {
    e.preventDefault()
    const value = $('#chat-input').value
    $('#chat-input').value = ''
    ask(value)
  }
  $('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      $('#chat-form').requestSubmit()
    }
  })
  $('#chat-input').addEventListener('input', (e) => {
    e.target.style.height = 'auto'
    e.target.style.height = `${Math.min(140, e.target.scrollHeight)}px`
  })
  $('#chat-starters').onclick = (e) => {
    const btn = e.target.closest('[data-q]')
    if (btn) ask(btn.dataset.q)
  }
  $('#chat-log').onclick = async (e) => {
    const action = e.target.closest('[data-msg-act]')?.dataset.msgAct
    if (!action) {
      const cite = e.target.closest('.cite')
      if (cite) jumpToPage(Number(cite.dataset.page))
      return
    }
    if (action === 'copy') {
      const index = [...$$('.msg.assistant')].indexOf(e.target.closest('.msg'))
      const message = $$('.msg.assistant')[index]
      const text = message?.querySelector('.bubble')?.innerText || ''
      try { await navigator.clipboard.writeText(text); toast('已复制') } catch { toast('复制失败', 'error') }
      return
    }
    if (action === 'regen') {
      if (state.busy.chat) return
      // Drop the last answer and ask the same question again.
      const lastUser = [...state.messages].reverse().find((m) => m.role === 'user')
      if (!lastUser) return
      while (state.messages.length && state.messages[state.messages.length - 1].role === 'assistant') state.messages.pop()
      const question = state.messages.pop()?.content || lastUser.content
      renderChat()
      ask(question)
    }
  }

  $('#chat-stop').onclick = () => {
    state.chatController?.abort()
    toast('已停止生成')
  }

  $('#chat-clear').onclick = () => {
    state.messages = []
    saveThreads()
    renderChat()
  }

  // notes
  $('#notes-editor').addEventListener('input', (e) => {
    state.notes = e.target.value
    saveNotes()
    if (!$('#notes-preview').hidden) $('#notes-preview').innerHTML = renderMarkdown(state.notes)
  })
  $('#notes-preview-toggle').onclick = () => {
    const preview = $('#notes-preview')
    const editor = $('#notes-editor')
    preview.hidden = !preview.hidden
    editor.hidden = !editor.hidden
    preview.innerHTML = renderMarkdown(state.notes)
  }
  $('#notes-export').onclick = () => {
    const blob = new Blob([state.notes], { type: 'text/markdown;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${(state.paper?.title || 'paper').slice(0, 50)}-笔记.md`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 3000)
  }

  // figures
  $('.fig-bar').onclick = (e) => {
    const btn = e.target.closest('[data-fig]')
    if (btn) generateFigure(btn.dataset.fig)
  }
  $('#fig-body').onclick = (e) => {
    const exportBtn = e.target.closest('[data-fig-export]')
    if (exportBtn) { exportFigure(exportBtn.dataset.figExport); return }
    const regen = e.target.closest('[data-fig-regen]')
    if (regen) { generateFigure(regen.dataset.figRegen); return }
    const svgHost = e.target.closest('.fig-svg')
    if (svgHost) {
      const svg = svgHost.querySelector('svg')
      const title = svgHost.closest('.fig-card')?.querySelector('h4')?.textContent || '框架图'
      openFigureModal(svg, title)
    }
  }

  // figure zoom modal
  $('#fig-modal-close').onclick = () => { $('#fig-modal').hidden = true }
  $('#fig-modal').onclick = (e) => { if (e.target.id === 'fig-modal') $('#fig-modal').hidden = true }
  $('#fig-modal-svg').onclick = () => exportFigure('svg', $('#fig-modal-body svg'))
  $('#fig-modal-png').onclick = () => exportFigure('png', $('#fig-modal-body svg'))

  // tabs
  $$('.side-tabs button').forEach((b) => { b.onclick = () => switchTab(b.dataset.tab) })

  // discovery
  $('#chat-model').onchange = (e) => {
    state.chatModel = e.target.value
    STORE.set('chatModel', state.chatModel)
  }
  $('#discover-refresh').onclick = () => loadDiscover(true)
  $('#discover-body').onclick = async (e) => {
    const btn = e.target.closest('[data-import]')
    if (!btn) return
    const id = btn.dataset.import
    btn.disabled = true
    const label = btn.textContent
    btn.textContent = '导入中…'
    try {
      await importUrl(`https://arxiv.org/pdf/${id}`)
    } finally {
      btn.disabled = false
      btn.textContent = label
    }
  }

  // keyboard
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const dialog = $('#import-dialog')
      if (dialog && !dialog.hidden) { dialog.hidden = true; return }
      if (document.activeElement?.id === 'search') { $('#search').value = ''; state.query = ''; renderLibrary(); return }
    }
    if ((e.key === 'Enter' || e.key === ' ') && document.activeElement?.classList?.contains('paper-card')) {
      e.preventDefault()
      openPaper(document.activeElement.dataset.paper)
      return
    }
    if (e.key === 'Escape') { $('#settings').hidden = true; $('#sel-card').hidden = true }
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); $('#search').focus() }
  })
}

// settings ---------------------------------------------------------------

async function openSettings() {
  const modal = $('#settings')
  modal.hidden = false
  $('#cfg-datadir').textContent = state.dataDir || '—'
  try {
    const data = await api('/state')
    state.config = data.config || {}
    state.selection = data.selection
  } catch { /* keep last */ }
  const cfg = state.config || {}
  const mode = ['auto', 'host', 'http'].includes(cfg.llm?.mode) ? cfg.llm.mode : 'auto'
  $$('#llm-mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode))
  $('#http-fields').hidden = mode === 'host'
  $('#cfg-baseurl').value = cfg.http?.baseUrl || ''
  $('#cfg-apikey').value = ''
  $('#cfg-apikey').placeholder = cfg.http?.hasKey
    ? (cfg.http?.fromEnv ? '已从环境变量读取，留空则继续使用' : '已保存，留空则不修改')
    : 'sk-…（只保存在本机，不会上传）'
  $('#cfg-model').value = cfg.http?.model || ''
  refreshBaiduLocal()
  $('#cfg-discipline').value = cfg.discipline || ''
  const style = ['academic', 'plain', 'concise'].includes(cfg.translateStyle) ? cfg.translateStyle : 'academic'
  $$('#translate-style button').forEach((b) => b.classList.toggle('on', b.dataset.style === style))
  $$('#translate-style button').forEach((b) => {
    b.onclick = () => $$('#translate-style button').forEach((x) => x.classList.toggle('on', x === b))
  })
  const version = cfg.version ? ' · v' + cfg.version : ''
  $('#llm-current').textContent = state.selection
    ? '当前使用：' + state.selection.provider + ' / ' + state.selection.model + version
    : '还没有可用的模型' + version
  $$('#llm-mode button').forEach((b) => {
    b.onclick = () => {
      $$('#llm-mode button').forEach((x) => x.classList.toggle('on', x === b))
      $('#http-fields').hidden = b.dataset.mode === 'host'
    }
  })
  const importKey = $('#settings-import-key')
  if (importKey) {
    importKey.onclick = async () => {
      const hint = $('#import-key-hint')
      hint.textContent = '正在查找…'
      try {
        const res = await api('/import-key', { method: 'POST' })
        hint.textContent = '已导入：' + res.http.baseUrl + ' / ' + res.http.model
        $('#cfg-baseurl').value = res.http.baseUrl
        $('#cfg-model').value = res.http.model
        $('#cfg-apikey').value = ''
        $('#cfg-apikey').placeholder = '已导入，留空则不修改'
        if (res.selection) {
          $('#llm-current').textContent = '当前使用：' + res.selection.provider + ' / ' + res.selection.model + version
        }
        toast('已从论文伴读导入 Key')
      } catch (err) {
        hint.textContent = String(err.message || err)
      }
    }
  }
  $('#settings-test').onclick = async () => {
    $('#settings-test').disabled = true
    try {
      const res = await api('/ping')
      toast(res.ok ? `模型就绪：${res.selection?.provider}/${res.selection?.model}` : `模型不可用：${res.error}`, res.ok ? '' : 'error')
    } catch (err) { toast(String(err.message || err), 'error') }
    finally { $('#settings-test').disabled = false }
  }
  $('#settings-save').onclick = async () => {
    const mode = $('#llm-mode button.on')?.dataset.mode || 'auto'
    const payload = {
      llm: { mode },
      http: {
        baseUrl: $('#cfg-baseurl').value.trim(),
        model: $('#cfg-model').value.trim(),
        ...(($('#cfg-apikey').value || '').trim() ? { apiKey: $('#cfg-apikey').value.trim() } : {}),
      },
      discipline: $('#cfg-discipline').value.trim(),
      translateStyle: $$('#translate-style button.on')[0]?.dataset.style || 'academic',
    }
    try {
      await saveSyncConfig()
      const res = await api('/config', { method: 'POST', body: JSON.stringify(payload) })
      state.config = res.config
      state.selection = res.selection
      renderLibrary()
      $('#llm-current').textContent = `当前使用：${res.selection.provider} / ${res.selection.model}`
      toast('设置已保存')
      modal.hidden = true
    } catch (err) { toast(String(err.message || err), 'error') }
  }
  wireSyncSettings()
  loadSyncStatus()
}

// sync settings ---------------------------------------------------------

function syncKind() {
  return $('#sync-kind button.on')?.dataset.kind || 'folder'
}

function syncTargetPayload() {
  const kind = syncKind()
  if (kind === 'folder') return { root: $('#sync-root').value.trim() }
  if (kind === 'webdav') {
    return {
      baseUrl: $('#sync-webdav-url').value.trim(),
      username: $('#sync-webdav-user').value.trim(),
      password: $('#sync-webdav-pass').value,
    }
  }
  if (kind === 'gdrive') {
    return {
      clientId: $('#sync-gdrive-id').value.trim(),
      clientSecret: $('#sync-gdrive-secret').value,
    }
  }
  return {
    appKey: $('#sync-baidu-key').value.trim(),
    appSecret: $('#sync-baidu-secret').value,
  }
}

function toggleSyncFields(kind) {
  for (const k of ['folder', 'webdav', 'gdrive', 'baidu']) {
    const block = $(`#sync-fields-${k}`)
    if (block) block.hidden = k !== kind
  }
  $$('#sync-kind button').forEach((b) => b.classList.toggle('on', b.dataset.kind === kind))
}

async function saveSyncConfig() {
  const kind = syncKind()
  const res = await api('/sync/config', {
    method: 'POST',
    body: JSON.stringify({ kind, includePdf: $('#sync-pdf')?.checked, target: syncTargetPayload() }),
  })
  state.sync.config = res.config
  return res.config
}

function wireSyncSettings() {
  $$('#sync-kind button').forEach((b) => {
    b.onclick = () => {
      toggleSyncFields(b.dataset.kind)
      const hint = $('#sync-hint')
      if (hint) {
        hint.textContent = b.dataset.kind === 'folder'
          ? '最省事的方式：指向 OneDrive / 坚果云 / iCloud 桌面端已经在同步的目录。'
          : b.dataset.kind === 'webdav'
            ? '坚果云、Nextcloud、群晖都支持：填 WebDAV 地址与应用密码即可。'
            : b.dataset.kind === 'gdrive'
              ? '用你自己的 Google Cloud 项目授权，数据只进你自己的 Drive。'
              : '用百度网盘开放平台的应用授权，数据进 /apps/<应用名>/paper-studio。'
      }
    }
  })

  const connect = async (kind) => {
    try {
      await saveSyncConfig()
      const res = await api('/sync/connect', { method: 'POST', body: JSON.stringify({ kind }) })
      window.open(res.url, '_blank', 'noopener')
      setSyncState('已打开授权页，完成授权后这里会自动显示结果…', true)
      pollAuth()
    } catch (err) {
      setSyncState(String(err.message || err), false)
      toast(String(err.message || err), 'error')
    }
  }
  $('#sync-connect-gdrive').onclick = () => connect('gdrive')
  $('#sync-connect-baidu').onclick = () => connect('baidu')

  $('#sync-test').onclick = async () => {
    setSyncState('正在测试连接…', true)
    try {
      await saveSyncConfig()
      const res = await api('/sync/test', { method: 'POST' })
      setSyncState(res.ok ? `连接正常：${res.detail}` : `连接失败：${res.detail}`, res.ok)
    } catch (err) {
      setSyncState(String(err.message || err), false)
    }
  }

  $('#sync-run').onclick = async () => {
    if (state.sync.running) return
    state.sync.running = true
    $('#sync-run').disabled = true
    setSyncState('正在同步…', true)
    try {
      await saveSyncConfig()
      let last = null
      await streamApi('/sync/run', {}, (event) => {
        if (event.type === 'phase') setSyncState(event.text, true)
        if (event.type === 'file') setSyncState(`${event.action} ${event.key} · ${event.done}/${event.total}`, true)
        if (event.type === 'warn') toast(event.message, 'error')
        if (event.type === 'done') last = event
      })
      if (last) {
        const s = last.summary
        setSyncState(`同步完成：上传 ${s.upload} · 下载 ${s.download} · 删除 ${s.deleted}${s.conflicts ? ` · 冲突 ${s.conflicts}` : ''}`, true)
        toast('同步完成')
        await refreshLibrary()
        if (state.activeId) await openPaper(state.activeId).catch(() => {})
      }
    } catch (err) {
      setSyncState(`同步失败：${err.message || err}`, false)
      toast(`同步失败：${err.message || err}`, 'error')
    } finally {
      state.sync.running = false
      $('#sync-run').disabled = false
    }
  }
}

function setSyncState(text, ok = true) {
  const el = $('#sync-state')
  if (!el) return
  el.textContent = text
  el.className = `save-state${ok ? '' : ' error'}`
}

let authPollTimer = null
function pollAuth() {
  clearInterval(authPollTimer)
  let tries = 0
  authPollTimer = setInterval(async () => {
    tries++
    try {
      const status = await api('/sync/status')
      if (status.auth?.status === 'done') {
        clearInterval(authPollTimer)
        setSyncState('授权完成，可以点「立即同步」了', true)
        await loadSyncStatus()
      } else if (status.auth?.status === 'error') {
        clearInterval(authPollTimer)
        setSyncState(`授权失败：${status.auth.error}`, false)
      } else if (tries > 90) {
        clearInterval(authPollTimer)
      }
    } catch { /* keep polling */ }
  }, 2000)
}

async function loadSyncStatus() {
  try {
    const status = await api('/sync/status')
    state.sync.status = status
    const cfg = status.config || {}
    const kind = cfg.kind || 'folder'
    toggleSyncFields(kind)
    $('#sync-root').value = cfg.target?.root || ''
    $('#sync-webdav-url').value = cfg.target?.baseUrl || ''
    $('#sync-webdav-user').value = cfg.target?.username || ''
    $('#sync-gdrive-id').value = cfg.target?.clientId || ''
    $('#sync-baidu-key').value = cfg.target?.appKey || ''
    $('#sync-pdf').checked = Boolean(cfg.includePdf)
    if (status.redirectUri) {
      $('#sync-redirect').textContent = status.redirectUri
      $('#sync-redirect-baidu').textContent = status.redirectUri
    }
    const oauthKind = kind === 'gdrive' || kind === 'baidu'
    const linkState = oauthKind ? (cfg.connected ? '已授权' : '待授权') : '已配置'
    const when = status.lastSyncAt ? `上次同步 ${timeAgo(status.lastSyncAt)}` : '还没同步过'
    if (!status.kind) setSyncState('未配置', true)
    else setSyncState(`${kind} · ${linkState} · ${when}`, true)
  } catch { /* settings still usable */ }
}

/** Two vertical splitters: library rail on the left, side panel on the right. */
function initSplitters() {
  const side = $('#side')
  const rail = $('#rail')
  const savedSide = STORE.get('sideWidth', 0)
  if (savedSide) side.style.width = savedSide + 'px'
  const savedRail = STORE.get('railWidth', 0)
  if (savedRail) rail.style.width = savedRail + 'px'

  const attach = (handle, target, { min, max, key, growLeft }) => {
    if (!handle || !target) return
    const apply = (w) => {
      const width = Math.max(min, Math.min(max, Math.round(w)))
      target.style.width = width + 'px'
      target.style.flex = '0 0 auto'
      return width
    }
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      const startX = e.clientX
      const startWidth = target.getBoundingClientRect().width
      handle.classList.add('dragging')
      try { handle.setPointerCapture?.(e.pointerId) } catch { /* synthetic events have no capture */ }
      const move = (ev) => {
        const delta = growLeft ? startX - ev.clientX : ev.clientX - startX
        apply(startWidth + delta)
      }
      const stop = () => {
        handle.classList.remove('dragging')
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', stop)
        handle.removeEventListener('pointercancel', stop)
        STORE.set(key, Math.round(target.getBoundingClientRect().width))
      }
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', stop)
      handle.addEventListener('pointercancel', stop)
    })
    handle.addEventListener('dblclick', () => {
      target.style.width = ''
      STORE.set(key, 0)
    })
    handle.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 48 : 16
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.preventDefault()
      const current = target.getBoundingClientRect().width
      const towards = e.key === 'ArrowRight' ? 1 : -1
      apply(current + (growLeft ? -towards : towards) * step)
      STORE.set(key, Math.round(target.getBoundingClientRect().width))
    })
  }

  attach($('#split-side'), side, { min: 280, max: Math.max(420, Math.round(window.innerWidth * 0.55)), key: 'sideWidth', growLeft: true })
  attach($('#split-rail'), rail, { min: 200, max: 420, key: 'railWidth', growLeft: false })
}

/** Selectable text over a rendered page — pdf.js's own text layer, so
    dragging across a line selects naturally instead of word by word. */
async function buildTextLayer(pageEl, page, scale) {
  pageEl.querySelector('.textLayer')?.remove()
  const pdfjs = await getPdfjs()
  const layer = document.createElement('div')
  layer.className = 'textLayer'
  layer.style.setProperty('--scale-factor', String(scale))
  pageEl.appendChild(layer)
  try {
    if (pdfjs.TextLayer) {
      const textContent = await page.getTextContent()
      const task = new pdfjs.TextLayer({
        textContentSource: textContent,
        container: layer,
        viewport: page.getViewport({ scale }),
      })
      await task.render()
      return
    }
  } catch { /* fall back to plain spans */ }
  // Fallback: one span per run, still contiguous enough to drag across.
  const content = await page.getTextContent()
  const viewport = page.getViewport({ scale: 1 })
  for (const item of content.items) {
    if (!item.str || !item.str.trim()) continue
    const [, b, c, , e, f] = item.transform
    if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01) continue
    const height = Math.hypot(c, item.transform[3]) || 10
    const span = document.createElement('span')
    span.textContent = item.str
    span.style.left = (e * scale).toFixed(1) + 'px'
    span.style.top = ((viewport.height - f - height) * scale).toFixed(1) + 'px'
    span.style.fontSize = (height * scale).toFixed(1) + 'px'
    layer.appendChild(span)
  }
}

let selCardTimer = null

/** Position the floating translation card next to the current selection. */
function placeSelCard(x, y) {
  const card = $('#sel-card')
  card.hidden = false
  const width = 340
  const left = Math.min(window.innerWidth - width - 12, Math.max(12, x + 14))
  const top = Math.min(window.innerHeight - 220, Math.max(58, y + 16))
  card.style.left = left + 'px'
  card.style.top = top + 'px'
}

async function translateSelectionCard(text) {
  const zh = $('#sel-card-zh')
  const cacheKey = text.slice(0, 160)
  state.selCache = state.selCache || new Map()
  if (state.selCache.has(cacheKey)) {
    const hit = state.selCache.get(cacheKey)
    zh.classList.remove('loading')
    zh.textContent = hit
    state.selectionText = text
    state.selectionTranslation = hit
    return
  }
  zh.textContent = '翻译中…'
  zh.classList.add('loading')
  let out = ''
  try {
    await streamApi(`/paper/${state.paper.id}/translate-selection`, { text, target: 'zh' }, (event) => {
      void 0
      if (event.type === 'delta') {
        out += event.text
        zh.classList.remove('loading')
        zh.textContent = out
      }
      if (event.type === 'done' && event.text) {
        out = event.text
        zh.textContent = out
      }
    })
  } catch (err) {
    zh.classList.remove('loading')
    zh.textContent = '翻译失败：' + (err.message || err)
  }
  state.selectionText = text
  state.selectionTranslation = out
  if (out) state.selCache.set(cacheKey, out)
}

/** Select text on the PDF → float a translation card. */
function wirePdfSelection() {
  document.addEventListener('mouseup', (e) => {
    if (e.target.closest('#sel-card') || e.target.closest('.side-tabs')) return
    clearTimeout(selCardTimer)
    selCardTimer = setTimeout(() => {
      const selection = window.getSelection()
      const text = selection?.toString().replace(/\s+/g, ' ').trim() || ''
      if (text.length < 2) { $('#sel-card').hidden = true; return }
      const node = selection.anchorNode
      const pageEl = (node?.nodeType === 1 ? node : node?.parentElement)?.closest?.('.pdf-page')
      if (!pageEl) { $('#sel-card').hidden = true; return }
      $('#sel-card-src').textContent = text.slice(0, 400) + (text.length > 400 ? '…' : '')
      placeSelCard(e.clientX, e.clientY)
      if (state.paper && hasText()) translateSelectionCard(text)
    }, 30)
  })

  $('#sel-card-close').onclick = () => { $('#sel-card').hidden = true }
  $('#sel-card').onclick = async (e) => {
    const act = e.target.closest('[data-sel-act]')?.dataset.selAct
    if (!act) return
    const text = state.selectionText || ''
    if (act === 'ask') {
      $('#sel-card').hidden = true
      switchTab('chat')
      $('#chat-with-selection').checked = true
      state.selectionText = text
      $('#chat-input').focus()
      toast('已带上选区，写下你的问题')
    } else if (act === 'note') {
      appendNote(text)
      $('#sel-card').hidden = true
    } else if (act === 'copy') {
      try {
        await navigator.clipboard.writeText(state.selectionTranslation || '')
        toast('已复制译文')
      } catch {
        toast('浏览器拒绝了剪贴板写入', 'error')
      }
    }
  }
}


async function boot() {
  wire()
  initSplitters()
  wirePdfSelection()
  // Debug hook: the probe scripts and the console rely on it.
  window.__ps = { state, renderReader, setPdfZoom, captureScrollAnchor, restoreScrollAnchor }
  // Deep links: /paper-studio/?tab=figures&mode=source
  const params = new URLSearchParams(location.search)
  const tabParam = params.get('tab')
  if (['chat', 'notes', 'figures', 'discover'].includes(tabParam)) state.tab = tabParam
  const modeParam = params.get('mode')
  if (['source', 'dual', 'target'].includes(modeParam)) state.mode = modeParam === 'source' ? 'source' : 'dual'
  const themeParam = params.get('theme')
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)')?.matches
  document.documentElement.dataset.theme = themeParam === 'dark' || (!themeParam && prefersDark) ? 'dark' : 'light'
  window.addEventListener('message', (event) => {
    if (event.data?.type !== 'ps:theme') return
    document.documentElement.dataset.theme = event.data.theme === 'dark' ? 'dark' : 'light'
  })
  setMode(state.mode)
  $('#rail').classList.toggle('collapsed', state.railHidden)
  switchTab(state.tab)
  try {
    await refreshLibrary()
    loadChatModels()
  } catch (err) {
    toast(`无法连接宿主：${err.message || err}`, 'error')
    return
  }
  const last = STORE.get('lastPaper', null)
  const target = last && state.papers.some((p) => p.id === last) ? last : state.papers[0]?.id
  if (target) {
    openPaper(target).then(() => {
      if (params.get('view') === 'pdf') { state.view = 'pdf'; renderReader() }
    }).catch((err) => toast(String(err.message || err), 'error'))
  }
}

boot()
