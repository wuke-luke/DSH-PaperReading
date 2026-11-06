// Paper Studio — the reading companion behind the chat rail.
//
// Retrieval is deliberately small and dependency-free: paragraphs are scored
// with an IDF-weighted keyword overlap over the paper itself, then trimmed to
// whole pages. The answer prompt then forces page-anchored citations, which is
// what makes the chat feel like it belongs to *this* paper instead of being a
// generic chatbot with a long paste.

const STOP = new Set(`
a an the and or but if then else of in on at to for from by with without into over under
is are was were be been being do does did done can could should would may might must will
this that these those it its they them their we our you your i he she his her as such than
not no nor so very more most much many few some any each every all both either neither
paper papers work works results result method methods approach approaches show shows shown
using used use also however therefore thus which what when where who whom whose how why
`.split(/\s+/).filter(Boolean))

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .slice(0, 400)
}

function buildIndex(paragraphs) {
  const df = new Map()
  const docs = paragraphs.map((p) => {
    const tokens = tokenize(p.text)
    const tf = new Map()
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
    for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1)
    return { p, tf, len: tokens.length || 1 }
  })
  return { docs, df, n: docs.length || 1 }
}

/** Top paragraphs for a question, ranked by IDF-weighted overlap. */
export function retrieve(paragraphs, question, { k = 8, maxChars = 9000 } = {}) {
  const q = [...new Set(tokenize(question))]
  if (!q.length) return paragraphs.slice(0, k)
  const { docs, df, n } = buildIndex(paragraphs)
  const idf = (t) => Math.log(1 + n / (1 + (df.get(t) ?? 0)))
  const scored = []
  for (const d of docs) {
    let score = 0
    for (const t of q) {
      const f = d.tf.get(t)
      if (f) score += (1 + Math.log(f)) * idf(t)
    }
    if (score > 0) {
      // Normalize a little by length so one enormous paragraph cannot dominate.
      score /= Math.sqrt(d.len / 120 + 1)
      if (d.p.heading) score *= 1.08
      scored.push({ ...d.p, score })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  const picked = []
  let chars = 0
  const seenPages = new Map()
  for (const p of scored) {
    if (picked.length >= k || chars >= maxChars) break
    // At most three excerpts from any single page keeps the context diverse.
    const onPage = seenPages.get(p.page) ?? 0
    if (onPage >= 3) continue
    seenPages.set(p.page, onPage + 1)
    picked.push(p)
    chars += p.text.length
  }
  if (picked.length === 0) return paragraphs.slice(0, Math.min(k, paragraphs.length))
  return picked.sort((a, b) => a.page - b.page || a.i - b.i)
}

const BASE_SYSTEM = (meta) => `你是 DeepPaperReading 的伴读助手，正在和用户一起读同一篇论文。

论文信息：
- 标题：${meta.title || '（未知）'}
- 作者：${meta.authors?.join(', ') || '（未知）'}
- 年份 / 来源：${meta.year || '未知'}${meta.arxivId ? ` / arXiv:${meta.arxivId}` : ''}

回答规则：
1. 依据下面给出的「全文概览」判断论文结构与章节，依据「原文片段」回答细节；两者都没有的信息，明确说「论文里没有提到」，不要凭常识补全。
2. 每个具体论断后面用页码标注来源，格式严格写 [p.12]；多个来源写 [p.12][p.14]。不要用别的引用格式。
3. 用中文回答（若用户用英文提问则用英文）。学术、简洁、分点，先给结论再给依据。
4. 涉及公式时用 LaTeX（行内 $...$，独立 $$...$$），不要改符号。
5. 不要复述用户的问题，不要写「根据提供的片段」这类铺垫，直接进入内容。`

const MODE_HINTS = {
  overview: '用户要的是一篇论文的全局把握：从「解决什么问题 / 关键洞察 / 怎么做 / 结果如何 / 局限在哪」五个角度组织回答。',
  method: '用户关注方法细节：讲清输入输出、关键模块、训练或推理流程，以及每个设计选择解决什么问题。',
  experiment: '用户关注实验：数据集、基线、指标、消融，以及作者用来支撑结论的关键数字。',
  critique: '用户要审稿人视角：指出假设是否成立、实验是否充分、结论是否被数据支撑，给出可执行的改进方向。',
  math: '用户关注公式与推导：逐个符号解释，说明公式在方法中的位置，必要时给出直觉解释。',
  relate: '用户想把这篇文章放进领域脉络：相关工作、与前作的关系、可能的新方向。',
}

/** A compact map of the whole paper so answers are anchored beyond the excerpts. */
export function buildOutline(paragraphs) {
  const heads = paragraphs.filter((p) => p.heading === 'h').slice(0, 48)
  const lines = heads.map((p) => '- 第 ' + p.page + ' 页 · ' + String(p.text).slice(0, 60))
  const opening = paragraphs.filter((p) => p.page === 1 && p.heading !== 'h').map((p) => p.text).join(' ').slice(0, 700)
  const parts = []
  if (lines.length) parts.push('章节结构：\n' + lines.join('\n'))
  if (opening) parts.push('首页摘要/导言：\n' + opening)
  return parts.join('\n\n')
}

export function buildChatRequest({ meta, paragraphs, question, history = [], mode = 'auto', selection = '' }) {
  const excerpts = retrieve(paragraphs, selection ? `${selection}\n${question}` : question, { k: 12, maxChars: 14000 })
  const context = excerpts
    .map((p) => `【第 ${p.page} 页${p.heading ? ` · ${p.heading}` : ''}】\n${p.text}`)
    .join('\n\n')
  const hint = MODE_HINTS[mode] ? `\n\n本次回答侧重：${MODE_HINTS[mode]}` : ''
  const outline = buildOutline(paragraphs)
  const system = `${BASE_SYSTEM(meta)}${hint}${outline ? `\n\n全文概览（用于定位，不是全部内容）：\n${outline}` : ''}\n\n与问题最相关的原文片段：\n${context}`
  const messages = []
  for (const turn of history.slice(-8)) {
    if (!turn?.content) continue
    messages.push({ role: turn.role === 'assistant' ? 'assistant' : 'user', content: String(turn.content) })
  }
  const asked = selection
    ? `我选中了这段原文：\n"""${selection}"""\n\n我的问题：${question}`
    : question
  messages.push({ role: 'user', content: asked })
  return { system, messages, excerpts }
}

export const SUGGESTED = [
  { id: 'tldr', label: '一句话总结', prompt: '用一句话说清这篇论文做了什么，再用三句话展开核心贡献。' },
  { id: 'problem', label: '它要解决什么问题', prompt: '这篇论文针对的是哪个具体问题？为什么这个问题重要、别人没解决好？' },
  { id: 'insight', label: '关键洞察', prompt: '作者最核心的那个洞察或假设是什么？它为什么能让方法奏效？' },
  { id: 'method', label: '方法拆解', prompt: '把方法拆成清晰的几步讲给我听，说明每一步的输入、输出和作用。' },
  { id: 'experiment', label: '实验与证据', prompt: '作者用什么实验支撑结论？关键数字是多少？哪些消融最能说明问题？' },
  { id: 'limits', label: '局限与质疑', prompt: '以审稿人的视角指出这篇论文最薄弱的地方，并给出可执行的改进方向。' },
]

/** Deterministic opener questions: they always work, even before any model call. */
export function suggestQuestions() {
  return SUGGESTED
}
