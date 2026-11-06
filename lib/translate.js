// Paper Studio — paragraph-level bilingual translation.
//
// The unit is one paragraph, not one page: a failed call costs one paragraph,
// the cache is addressable per paragraph, and the reader can show a translation
// directly under the original it belongs to (the "immersive" reading mode).
//
// Quality comes from three things, in order of impact:
//   1. a terminology table built once per paper (same concept, same word);
//   2. a prompt that says what "good Chinese academic prose" means, not just
//      "translate faithfully";
//   3. structure hints (section title of the paragraph) so pronouns resolve.

import { createHash } from 'node:crypto'
import { completeJson, streamText } from './llm.js'
import { glossaryBlock } from './glossary.js'

export function hashText(text) {
  return createHash('sha1').update(String(text)).digest('hex').slice(0, 16)
}

const LANG_NAMES = {
  zh: '简体中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  de: 'Deutsch',
  fr: 'Français',
  ru: 'Русский',
}

export function languageName(code) {
  return LANG_NAMES[code] || '简体中文'
}

export const STYLES = {
  academic: { label: '学术', hint: '学术译法：术语用领域通行译名，句式贴近原文的论证结构，适合精读与引用。' },
  plain: { label: '通俗', hint: '通俗译法：用大白话讲清楚，像给非本专业的同事解释；长句可以拆短，术语首次出现保留英文原词。' },
  concise: { label: '简洁', hint: '简洁译法：只保留核心信息，能省的字都省掉；不解释、不展开，适合快速扫读。' },
}

const SYSTEM = (target, discipline, style = 'academic', glossary = []) => `你是一位资深的学术论文译者，长期翻译${discipline || '计算机科学与人工智能'}方向的论文。把下面的段落译成${languageName(target)}。

翻译风格：${(STYLES[style] || STYLES.academic).hint}

硬性规则：
1. 忠实原意：不增删、不概括、不加「译者注」；段落要完整，不许漏句，也不许把两段并成一段。
2. 术语：一律采用术语表中的译法；表里没有的，用该领域通行译名；确无通行译法时首次出现写成「中文（English）」。
3. 原样保留：数学公式与变量符号、数字与单位、引用编号 [12]、图表编号（Fig. 2 / Table 1）、URL、邮箱、代码标识符、模型与库的专名。
4. 不翻译：作者姓名、机构名、参考文献条目里的作者与标题。
5. 可读性：要像中文论文那样写，不要逐词直译。长难句按语义拆成两到三句；避免连续多个「的」、避免欧化倒装；标点用「，。；：」，不要中途出现英文标点。
6. 逻辑连接词（however / therefore / in contrast / while）必须译出转折、因果、对照关系，不能省略成一个逗号。
7. 代词（it / they / this approach）在没有明确指代时必须还原成具体名词，不能直译成「它」「这一方法」。
8. 只输出 JSON，不要 markdown 代码块，不要任何额外文字。

输出格式：{"translations":[{"id":<段落 id>,"text":"<译文>"}]}${glossaryBlock(glossary)}`

function buildPrompt(items, section = '') {
  const payload = { paragraphs: items.map((p) => ({ id: p.i, text: p.text })) }
  if (section) payload.section = section
  return JSON.stringify(payload)
}

/** Group paragraphs into calls that fit comfortably in one response. */
export function buildBatches(paragraphs, { maxItems = 4, maxChars = 2600 } = {}) {
  const batches = []
  let current = []
  let chars = 0
  for (const p of paragraphs) {
    const len = p.text.length
    if (current.length && (current.length >= maxItems || chars + len > maxChars)) {
      batches.push(current)
      current = []
      chars = 0
    }
    current.push(p)
    chars += len
  }
  if (current.length) batches.push(current)
  return batches
}

/** Nearest heading above a paragraph, so the model knows which section it is in. */
export function sectionOf(paragraphs, index) {
  for (let i = index - 1; i >= 0; i--) {
    const p = paragraphs[i]
    if (p.heading === 'h') return String(p.text || '').slice(0, 80)
  }
  return ''
}

/**
 * Translate one batch. Falls back to per-paragraph calls when the model's JSON
 * does not line up with what we asked for, so one malformed response never
 * strands a whole range of paragraphs.
 */
async function translateBatch(ctx, config, batch, { target, discipline, signal, style, glossary, section }) {
  try {
    const parsed = await completeJson(ctx, config, {
      system: SYSTEM(target, discipline, style, glossary),
      messages: [{ role: 'user', content: buildPrompt(batch, section) }],
      maxTokens: 4096,
      signal,
    })
    const list = Array.isArray(parsed) ? parsed : parsed?.translations
    if (!Array.isArray(list)) throw new Error('模型返回结构不对')
    const byId = new Map()
    for (const item of list) {
      const id = Number(item?.id ?? item?.index)
      if (Number.isFinite(id) && typeof item?.text === 'string' && item.text.trim()) {
        byId.set(id, item.text.trim())
      }
    }
    if (byId.size === 0) throw new Error('模型返回空译文')
    const out = batch.map((p) => ({ i: p.i, text: byId.get(p.i) ?? null })).filter((x) => x.text)
    if (out.length === 0) throw new Error('译文与段落对不上')
    return out
  } catch (err) {
    if (batch.length === 1) return [{ i: batch[0].i, error: String(err?.message || err) }]
    const out = []
    for (const p of batch) {
      try {
        let text = ''
        for await (const delta of streamText(ctx, config, {
          system: SYSTEM(target, discipline, style, glossary),
          messages: [{
            role: 'user',
            content: `把下面这段论文原文译成${languageName(target)}，只输出译文本身：\n\n${p.text}`,
          }],
          maxTokens: 2048,
          signal,
        })) text += delta
        if (text.trim()) out.push({ i: p.i, text: text.trim() })
      } catch (inner) {
        out.push({ i: p.i, error: String(inner?.message || inner) })
      }
    }
    return out
  }
}

/**
 * Translate the given paragraphs, `concurrency` batches at a time; yields each
 * finished paragraph so the HTTP layer can stream progress into the reader.
 */
export async function* translateParagraphs(ctx, config, {
  paragraphs,
  target = 'zh',
  discipline = '',
  concurrency = 3,
  signal,
  cache = {},
  modelKey = '',
  force = false,
  style = 'academic',
  glossary = [],
  sectionOf: sectionLookup = null,
}) {
  // A cached paragraph is reused when the source text is unchanged and it was
  // produced by the model now in use. Switching models invalidates it; so does
  // an explicit "translate again".
  const todo = paragraphs.filter((p) => {
    if (force) return true
    const hit = cache[p.i]
    if (!hit || hit.src !== hashText(p.text)) return true
    if (hit.model && modelKey && hit.model !== modelKey) return true
    return false
  })
  const total = todo.length
  if (!total) return
  const batches = buildBatches(todo)
  const width = Math.max(1, Math.min(concurrency, batches.length))
  let done = 0
  for (let i = 0; i < batches.length; i += width) {
    if (signal?.aborted) return
    const slice = batches.slice(i, i + width)
    const groups = await Promise.all(slice.map((batch) => translateBatch(ctx, config, batch, {
      target,
      discipline,
      signal,
      style,
      glossary,
      section: sectionLookup ? sectionLookup(batch[0].i) : '',
    })))
    for (const group of groups) {
      for (const item of group) {
        done++
        yield { ...item, done, total }
      }
    }
  }
}
