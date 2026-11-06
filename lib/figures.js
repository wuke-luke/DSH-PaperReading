// Paper Studio — paper diagrams.
//
// Asking a model for an SVG produces prettier demos and unusable files. Instead
// the model returns a small, constrained *spec* (stages, boxes, arrows) and the
// browser renders it with a real layout: consistent typography, aligned boxes,
// arrowheads that cannot detach, and an exportable vector file.
//
// Three spec kinds share one renderer:
//   framework  the method pipeline (input → modules → output), grouped by stage
//   concept    the argument map (problem → insight → method → evidence → limits)
//   compare    two or three approaches side by side against the same axes

import { completeJson } from './llm.js'

const MAX_NODES = 12
const MAX_GROUPS = 5

const SYSTEM = `你是学术论文的可视化编辑。你只输出 JSON 规格，不写 SVG，不做解释。

规则：
- 节点标签用 8-20 个字（中文）或 3-6 个词（英文），是名词短语，不是句子。
- 每个节点只表达一个概念；不要把整个方法塞进一个框。
- 组（group）是横向的阶段带，2-4 个，顺序就是读者阅读顺序。
- 边（edge）只在数据流真实存在时才画；不要为了好看连线。
- 语言跟随论文标题的语言（中文论文用中文标签）。`

function specPrompt(kind, ctxText) {
  if (kind === 'concept') {
    return `请把这篇论文的论证结构画成一张「论证地图」。

${ctxText}

输出 JSON：
{
  "title": "论证地图",
  "subtitle": "一句话说明这张图回答什么",
  "groups": [{"id":"g1","label":"问题"},{"id":"g2","label":"洞察"},{"id":"g3","label":"方法"},{"id":"g4","label":"证据"}],
  "nodes": [{"id":"n1","group":"g1","label":"要解决的问题","desc":"可选的一行说明","kind":"problem"}],
  "edges": [{"from":"n1","to":"n2","label":"因此","style":"solid"}]
}
node.kind ∈ {"problem","insight","module","data","result","limit"}。8-12 个节点，2-4 个组。`
  }
  if (kind === 'compare') {
    return `请把论文与它对比的方法画成一张对照图（同一组轴上比较 2-3 个方案）。

${ctxText}

输出 JSON：
{
  "title": "方法对照",
  "subtitle": "一句话说明比较的维度",
  "groups": [{"id":"g1","label":"输入"},{"id":"g2","label":"机制"},{"id":"g3","label":"结果"}],
  "nodes": [{"id":"n1","group":"g1","label":"共享输入","kind":"data"}],
  "edges": [{"from":"n1","to":"n2","label":"","style":"dashed"}]
}
每个方案在 g2、g3 各有一个节点，标签以方案名开头，例如「本文：双流对齐」。6-10 个节点。`
  }
  return `请把这篇论文的方法画成一张「框架图」，读者看完应能说出整条数据流。

${ctxText}

输出 JSON：
{
  "title": "方法框架",
  "subtitle": "一句话概括这条流水线",
  "groups": [{"id":"g1","label":"输入"},{"id":"g2","label":"方法"},{"id":"g3","label":"输出"}],
  "nodes": [
    {"id":"n1","group":"g1","label":"论文输入","desc":"例如：单目视频 + 语言指令","kind":"data"},
    {"id":"n2","group":"g2","label":"核心模块","desc":"它的作用，一句话","kind":"module"}
  ],
  "edges": [{"from":"n1","to":"n2","label":"","style":"solid"}]
}
node.kind ∈ {"data","module","loss","result"}。6-10 个节点，2-4 个组，数据流必须连通。`
}

const PALETTE = ['#8c2f39', '#1f4e79', '#4f6228', '#6b4c3b', '#3f3a5c']

function slug(value, fallback) {
  const s = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || fallback
}

/** Coerce whatever the model produced into a spec the renderer can trust. */
export function normalizeSpec(raw, fallbackTitle = '框架图') {
  const spec = raw && typeof raw === 'object' ? raw : {}
  const groupsRaw = Array.isArray(spec.groups) ? spec.groups : []
  const groups = []
  const groupIds = new Set()
  groupsRaw.slice(0, MAX_GROUPS).forEach((g, index) => {
    const id = slug(g?.id ?? `g${index + 1}`, `g${index + 1}`)
    if (groupIds.has(id)) return
    groupIds.add(id)
    groups.push({
      id,
      label: String(g?.label ?? `阶段 ${index + 1}`).slice(0, 24),
      accent: PALETTE[index % PALETTE.length],
    })
  })
  if (groups.length === 0) groups.push({ id: 'g1', label: '方法', accent: PALETTE[0] })

  const nodesRaw = Array.isArray(spec.nodes) ? spec.nodes : []
  const nodes = []
  const nodeIds = new Set()
  const KINDS = new Set(['data', 'module', 'loss', 'result', 'problem', 'insight', 'limit', 'note'])
  nodesRaw.slice(0, MAX_NODES).forEach((n, index) => {
    const id = slug(n?.id ?? `n${index + 1}`, `n${index + 1}`)
    if (nodeIds.has(id)) return
    let group = slug(n?.group ?? '', '')
    if (!groupIds.has(group)) group = groups[Math.min(groups.length - 1, Math.floor((index / Math.max(1, nodesRaw.length)) * groups.length))].id
    const label = String(n?.label ?? '').trim().slice(0, 46)
    if (!label) return
    nodeIds.add(id)
    nodes.push({
      id,
      group,
      label,
      desc: String(n?.desc ?? '').trim().slice(0, 80),
      kind: KINDS.has(n?.kind) ? n.kind : 'module',
    })
  })
  if (nodes.length === 0) throw new Error('模型没有给出可用的节点')

  const edgesRaw = Array.isArray(spec.edges) ? spec.edges : []
  const seen = new Set()
  const edges = []
  for (const e of edgesRaw) {
    const from = slug(e?.from ?? '', '')
    const to = slug(e?.to ?? '', '')
    if (!nodeIds.has(from) || !nodeIds.has(to) || from === to) continue
    const key = `${from}->${to}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({
      from,
      to,
      label: String(e?.label ?? '').slice(0, 20),
      style: e?.style === 'dashed' ? 'dashed' : 'solid',
    })
  }
  // Guarantee a readable flow: consecutive groups get a spine edge when the
  // model forgot to connect them.
  if (edges.length === 0) {
    for (let i = 0; i < nodes.length - 1; i++) {
      edges.push({ from: nodes[i].id, to: nodes[i + 1].id, label: '', style: 'solid' })
    }
  }

  return {
    kind: ['framework', 'concept', 'compare'].includes(spec.kind) ? spec.kind : 'framework',
    title: String(spec.title ?? fallbackTitle).slice(0, 40) || fallbackTitle,
    subtitle: String(spec.subtitle ?? '').slice(0, 90),
    groups,
    nodes,
    edges,
    createdAt: Date.now(),
  }
}

export function buildContext(meta, text, { maxChars = 7000 } = {}) {
  const paragraphs = text?.paragraphs ?? []
  const abstract = text?.abstract || paragraphs.slice(0, 3).map((p) => p.text).join(' ')
  const headings = (text?.sections ?? []).slice(0, 14).map((s) => `${s.title}（第 ${s.page} 页）`)
  const methodish = paragraphs
    .filter((p) => /method|approach|model|framework|architect|pipeline|方法|框架|模型/i.test(p.text))
    .slice(0, 10)
  const body = [
    `标题：${meta?.title || '未知'}`,
    `摘要：${String(abstract).slice(0, 1400)}`,
    headings.length ? `章节：\n${headings.join('\n')}` : '',
    methodish.length ? `方法相关段落：\n${methodish.map((p) => `[p.${p.page}] ${p.text}`).join('\n').slice(0, maxChars)}` : '',
  ].filter(Boolean).join('\n\n')
  return body.slice(0, maxChars)
}

export async function generateFigure(ctx, config, { kind = 'framework', meta, text, note = '' }) {
  const context = buildContext(meta, text)
  const raw = await completeJson(ctx, config, {
    system: SYSTEM,
    messages: [{ role: 'user', content: `${specPrompt(kind, context)}${note ? `\n\n补充要求：${note}` : ''}` }],
    maxTokens: 3000,
  })
  const spec = normalizeSpec(raw, kind === 'concept' ? '论证地图' : kind === 'compare' ? '方法对照' : '方法框架')
  spec.kind = kind
  return spec
}
