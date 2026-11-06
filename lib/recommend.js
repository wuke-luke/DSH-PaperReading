// Paper Studio — discovery: papers like this one, and what the field is reading.
//
// Two public sources, no API keys:
//   related   alphaXiv `/papers/v3/{arxivId}/similar-papers`, falling back to
//             Semantic Scholar's recommendations endpoint.
//   trending  Hugging Face's daily-papers feed (the same list the community
//             upvotes), falling back to alphaXiv search over the library's topics.
//
// Results are cached on disk: a reading desk should not hit three APIs every
// time a panel is opened.

import { join } from 'node:path'
import { readJson, writeJson } from './store.js'
import { fetchJson, firstOk } from './net.js'

const TRENDING_TTL = 3 * 3600 * 1000
const RELATED_TTL = 12 * 3600 * 1000

const ALPHAXIV = 'https://api.alphaxiv.org'
const HF_DAILY = 'https://huggingface.co/api/daily_papers'
const S2 = 'https://api.semanticscholar.org/graph/v1'
const S2_RECS = 'https://api.semanticscholar.org/recommendations/v1'

function clean(text, max = 600) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function arxivIdOf(value) {
  const raw = String(value || '').trim()
  const m = raw.match(/(\d{4}\.\d{4,5})(v\d+)?/)
  return m ? m[1] : null
}

function yearOf(value) {
  if (!value) return null
  if (typeof value === 'number') return value
  const m = String(value).match(/(19|20)\d{2}/)
  return m ? Number(m[0]) : null
}

function nameList(input) {
  if (!Array.isArray(input)) return []
  return input
    .map((a) => (typeof a === 'string' ? a : a?.name || a?.full_name || a?.authorName || ''))
    .filter(Boolean)
    .slice(0, 12)
}

export function normalizeArxivItems(items, source, reason) {
  const out = []
  const seen = new Set()
  for (const item of items || []) {
    const arxiv = arxivIdOf(item?.canonical_id || item?.id || item?.paperId || item?.link)
    if (!arxiv || seen.has(arxiv)) continue
    seen.add(arxiv)
    out.push({
      id: arxiv,
      title: clean(item?.title, 240),
      abstract: clean(item?.abstract || item?.summary || item?.snippet, 700),
      authors: nameList(item?.full_authors || item?.authors || item?.author_info),
      year: yearOf(item?.publication_date || item?.publishedAt || item?.published),
      url: `https://arxiv.org/abs/${arxiv}`,
      source,
      reason,
      stars: Number(item?.github_stars || 0) || undefined,
      topics: Array.isArray(item?.topics) ? item.topics.slice(0, 4).map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean) : [],
    })
  }
  return out
}

export function normalizeDailyPapers(payload) {
  const out = []
  const seen = new Set()
  for (const entry of payload || []) {
    const paper = entry?.paper || entry
    const arxiv = arxivIdOf(paper?.id)
    if (!arxiv || seen.has(arxiv)) continue
    seen.add(arxiv)
    out.push({
      id: arxiv,
      title: clean(paper?.title, 240),
      abstract: clean(paper?.summary, 700),
      authors: nameList(paper?.authors),
      year: yearOf(entry?.publishedAt || paper?.publishedAt),
      url: `https://arxiv.org/abs/${arxiv}`,
      source: 'hf-daily',
      reason: '今日热门',
      upvotes: Number(entry?.upvotes ?? paper?.upvotes ?? 0) || undefined,
      topics: Array.isArray(paper?.tags) ? paper.tags.slice(0, 3) : [],
    })
  }
  return out
}

export function normalizeS2(payload) {
  return (payload?.recommendedPapers || payload?.data || []).map((paper) => {
    const arxiv = arxivIdOf(paper?.externalIds?.ArXiv)
    if (!arxiv) return null
    return {
      id: arxiv,
      title: clean(paper?.title, 240),
      abstract: clean(paper?.abstract, 700),
      authors: nameList(paper?.authors),
      year: paper?.year || null,
      url: `https://arxiv.org/abs/${arxiv}`,
      source: 'semantic-scholar',
      reason: '引文相近',
      topics: [],
    }
  }).filter(Boolean)
}

export class Recommender {
  constructor({ store, getLibrary }) {
    this.store = store
    this.getLibrary = getLibrary
    this.cacheFile = join(store.root, 'recommendations.json')
  }

  async cache() {
    return readJson(this.cacheFile, { version: 1, trending: null, related: {} })
  }

  async saveCache(cache) {
    await writeJson(this.cacheFile, cache)
  }

  async libraryArxivIds() {
    const lib = await this.getLibrary()
    return new Set((lib?.papers || []).map((p) => arxivIdOf(p.arxivId)).filter(Boolean))
  }

  async related(paper, { force = false } = {}) {
    const arxiv = arxivIdOf(paper?.arxivId || paper?.title)
    if (!arxiv) return { items: [], reason: '这篇论文没有 arXiv 编号，无法按引文网络找相似工作' }
    const cache = await this.cache()
    const entry = cache.related?.[arxiv]
    if (!force && entry && Date.now() - entry.at < RELATED_TTL) {
      return { items: entry.items, at: entry.at, cached: true }
    }
    const libIds = await this.libraryArxivIds()
    let items = []
    let source = null
    try {
      const payload = await fetchJson(`${ALPHAXIV}/papers/v3/${arxiv}/similar-papers`, { timeout: 25000 })
      items = normalizeArxivItems(payload, 'alphaxiv', '相似主题')
      source = 'alphaxiv'
    } catch {
      try {
        const payload = await fetchJson(`${S2_RECS}/papers/forpaper/arXiv:${arxiv}?limit=20&fields=title,abstract,year,authors,externalIds`, { timeout: 20000 })
        items = normalizeS2(payload)
        source = 'semantic-scholar'
      } catch (err) {
        return { items: [], error: String(err?.message || err) }
      }
    }
    items = items.filter((item) => !libIds.has(item.id)).slice(0, 14)
    cache.related = cache.related || {}
    cache.related[arxiv] = { at: Date.now(), items, source }
    await this.saveCache(cache)
    return { items, at: cache.related[arxiv].at, source }
  }

  async trending({ force = false } = {}) {
    const cache = await this.cache()
    if (!force && cache.trending && Date.now() - cache.trending.at < TRENDING_TTL) {
      return { items: cache.trending.items, at: cache.trending.at, cached: true }
    }
    const libIds = await this.libraryArxivIds()
    let items = []
    let source = null
    try {
      const payload = await fetchJson(`${HF_DAILY}?limit=40`, { timeout: 20000 })
      items = normalizeDailyPapers(payload)
      source = 'huggingface-daily'
    } catch {
      const lib = await this.getLibrary()
      const topic = lib?.papers?.find((p) => p.tags?.length)?.tags?.[0] || 'large language model agent'
      const payload = await fetchJson(`${ALPHAXIV}/search/v2/paper/fast?q=${encodeURIComponent(topic)}&includePrivate=false`, { timeout: 20000 })
      items = normalizeArxivItems(
        (payload || []).map((row) => ({ ...row, canonical_id: row.paperId || row.link })),
        'alphaxiv-search',
        `近期 ${topic} 方向`,
      )
      source = 'alphaxiv-search'
    }
    items = items.filter((item) => !libIds.has(item.id)).slice(0, 16)
    cache.trending = { at: Date.now(), items, source }
    await this.saveCache(cache)
    return { items, at: cache.trending.at, source }
  }

  /** One call for the Discover panel. */
  async discover(paper, { force = false } = {}) {
    const [trending, related] = await Promise.all([
      this.trending({ force }).catch((err) => ({ items: [], error: String(err?.message || err) })),
      paper ? this.related(paper, { force }).catch((err) => ({ items: [], error: String(err?.message || err) })) : Promise.resolve({ items: [] }),
    ])
    return {
      trending: { items: trending.items || [], at: trending.at || 0, source: trending.source || null, error: trending.error || null },
      related: { items: related.items || [], at: related.at || 0, source: related.source || null, error: related.error || null },
    }
  }
}
