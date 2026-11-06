// End-to-end HTTP tests against a running dev server (node dev/server.mjs).
import { readFile } from 'node:fs/promises'

const BASE = process.env.BASE || 'http://127.0.0.1:7788/paper-studio/api'
let failures = 0
const ok = (name, extra = '') => console.log(`PASS  ${name}${extra ? '  ' + extra : ''}`)
const bad = (name, detail) => { failures++; console.log(`FAIL  ${name}  ${detail}`) }

async function get(path) {
  const res = await fetch(BASE + path)
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`)
  return res.json()
}
async function post(path, body, raw = false) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: raw ? { 'content-type': 'application/pdf' } : { 'content-type': 'application/json' },
    body: raw ? body : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`)
  return res.json()
}
async function* stream(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`)
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
      if (line) yield JSON.parse(line)
    }
  }
}

const state = await get('/state')
state.papers.length >= 1 ? ok('library state', `${state.papers.length} papers`) : bad('library state', 'empty')
const paperId = state.papers[0].id

const detail = await get(`/paper/${paperId}`)
detail.hasText ? ok('paper detail', `${detail.summary?.paragraphs} paragraphs`) : bad('paper detail', 'no text')

const text = await get(`/paper/${paperId}/text`)
text.paragraphs?.length > 10 ? ok('paper text', `${text.paragraphs.length}`) : bad('paper text', 'too short')

// notes round-trip
const originalNotes = detail.notes
await post(`/paper/${paperId}/notes`, { markdown: '# 测试笔记\n\n> 引用一段' })
const notes = await get(`/paper/${paperId}/notes`)
notes.notes.includes('测试笔记') ? ok('notes save/read') : bad('notes save/read', JSON.stringify(notes).slice(0, 120))
await post(`/paper/${paperId}/notes`, { markdown: originalNotes })

// translation stream — pick paragraphs the cache does not have yet
const zhBefore = await get(`/paper/${paperId}/zh`)
const fresh = text.paragraphs
  .filter((p) => p.heading !== 'h' && !zhBefore.entries?.[p.i])
  .slice(2, 4)
  .map((p) => p.i)
let paraEvents = 0
let doneEvent = null
for await (const event of stream(`/paper/${paperId}/translate`, { target: 'zh', ids: fresh })) {
  if (event.type === 'para') paraEvents++
  if (event.type === 'done') doneEvent = event
  if (event.type === 'error') bad('translate', event.message)
}
const zhAfter = await get(`/paper/${paperId}/zh`)
const cached = fresh.every((i) => zhAfter.entries?.[i]?.text)
paraEvents === fresh.length && doneEvent && cached
  ? ok('translation stream', `${paraEvents} paragraphs cached`)
  : bad('translation stream', `para=${paraEvents}/${fresh.length} done=${Boolean(doneEvent)} cached=${cached}`)

// chat stream with citations
let answer = ''
let citations = 0
for await (const event of stream(`/paper/${paperId}/chat`, { question: '这篇论文的核心贡献是什么？' })) {
  if (event.type === 'delta') answer += event.text
  if (event.type === 'done') citations = event.citations?.length ?? 0
  if (event.type === 'error') bad('chat', event.message)
}
answer.length > 50 ? ok('chat stream', `${answer.length} chars`) : bad('chat stream', answer.slice(0, 80))
citations > 0 ? ok('chat citations', `${citations} passages`) : bad('chat citations', 'none')

// figure
const figure = await post(`/paper/${paperId}/figure`, { kind: 'framework' })
figure.figure?.nodes?.length >= 4 ? ok('figure spec', `${figure.figure.nodes.length} nodes`) : bad('figure spec', JSON.stringify(figure).slice(0, 120))
;(await get(`/paper/${paperId}/figures`)).items.length >= 1 ? ok('figure history') : bad('figure history', 'empty')

// upload a real PDF, then delete it
const pdf = await readFile('D:/DESKTOP/[20261011] From Existing Methods to New Research Ideas.pdf')
const uploaded = await post('/import/upload', pdf, true)
uploaded.paper?.id ? ok('upload import', uploaded.paper.id) : bad('upload import', JSON.stringify(uploaded).slice(0, 120))
if (uploaded.paper?.id) {
  const after = await get('/state')
  after.papers.some((p) => p.id === uploaded.paper.id) ? ok('library reflects import') : bad('library reflects import', 'missing')
  const removed = await post(`/paper/${uploaded.paper.id}/delete`, {})
  removed.ok ? ok('delete paper') : bad('delete paper', JSON.stringify(removed))
}

// folders
const folder = await post('/folders', { name: '测试专题' })
folder.folder?.id ? ok('create folder') : bad('create folder', JSON.stringify(folder))
if (folder.folder?.id) {
  const res = await fetch(`${BASE}/folders/${folder.folder.id}`, { method: 'DELETE' })
  res.ok ? ok('delete folder') : bad('delete folder', String(res.status))
}

// bad input is rejected, not swallowed
const badRes = await fetch(`${BASE}/import/url`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'not-a-url' }) })
badRes.status === 400 ? ok('rejects bad url') : bad('rejects bad url', String(badRes.status))

const missing = await fetch(`${BASE}/paper/doesnotexist`)
missing.status === 404 ? ok('404 for missing paper') : bad('404 for missing paper', String(missing.status))

console.log(failures ? `\n${failures} FAILURES` : '\nall API checks passed')
process.exit(failures ? 1 : 0)
