// Per-paper glossary: stable terminology is the difference between a readable
// Chinese version and one that calls the same concept three different things.

import { completeJson } from './llm.js'

const SYSTEM = (discipline) => `你是${discipline || '计算机科学与人工智能'}领域的翻译术语专家。
从给定的论文片段中抽取 20–40 个关键术语（方法名、任务名、指标、专有名词），给出该领域通行的中文译名。
要求：
- 只输出 JSON，格式 {"terms":[{"en":"...","zh":"..."}]}；
- 保留模型名、库名、缩写不译（如 RSI、LLM、Transformer）；
- 不要收录作者姓名、机构名、普通英文单词。`

/**
 * Build (once) a terminology table from the first page + title.
 * Never throws: a missing glossary just means the plain prompt.
 */
export async function buildGlossary(ctx, config, { title = '', paragraphs = [], discipline = '', signal }) {
  const opening = paragraphs
    .filter((p) => p.page === 1 && p.heading !== 'h')
    .slice(0, 4)
    .map((p) => p.text)
    .join('\n\n')
  const sample = `${title}\n\n${opening}`.trim().slice(0, 6000)
  if (sample.length < 80) return null
  const parsed = await completeJson(ctx, config, {
    system: SYSTEM(discipline),
    messages: [{ role: 'user', content: sample }],
    maxTokens: 1200,
    signal,
  })
  const list = Array.isArray(parsed?.terms) ? parsed.terms : Array.isArray(parsed) ? parsed : []
  const terms = list
    .map((item) => ({
      en: String(item?.en || item?.source || '').trim(),
      zh: String(item?.zh || item?.target || '').trim(),
    }))
    .filter((t) => t.en && t.zh && t.en.length < 60 && t.zh.length < 40)
    .slice(0, 48)
  return terms.length ? terms : null
}

/** Render the glossary into a compact prompt block. */
export function glossaryBlock(terms) {
  if (!Array.isArray(terms) || !terms.length) return ''
  const rows = terms.slice(0, 48).map((t) => `${t.en} → ${t.zh}`).join('\n')
  return `\n\n术语表（必须严格沿用，全文保持一致）：\n${rows}`
}
