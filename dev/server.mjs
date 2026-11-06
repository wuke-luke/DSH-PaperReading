// Dev server: boots the Paper Studio host handler outside DSH with a stub
// model, so the UI can be exercised in a plain browser (and screenshotted).
//
//   node dev/server.mjs            → http://127.0.0.1:7788/paper-studio/
//
// The stub model answers with canned academic Chinese so the reading,
// translation and chat surfaces are all live without a network call.

import http from 'node:http'
import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Store, writeJson } from '../lib/store.js'
import { createHandler } from '../lib/index.js'
import { detectAbstract, dropTitleEcho } from '../web/extract.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const DATA = join(ROOT, '.devdata', 'studio')
const PORT = Number(process.env.PORT || 7788)

const RSI_PDF = 'D:\\DESKTOP\\[20261011] From Existing Methods to New Research Ideas.pdf'
const DEXOPE_PDF = 'D:\\DESKTOP\\DexOPE_camera_ready.pdf'

// ── canned Chinese for the demo paper ────────────────────────────────────
const ZH_ABSTRACT = '递归自我改进（RSI）为 AI 系统参与自身持续发展提供了一条路径。近期的方法让语言智能体能够保留对参数、记忆、技能与代码所做的修改，并在后续执行与改进中加以利用。我们从两个互补的视角考察这些方法如何启发新的研究想法。首先，我们提出一个统一分类法，包含九个设计维度，归入四组：更新对象、更新组织方式、更新调度与范围、反馈与选择。该分类法将已有方法置于一个共享的设计空间中，考察单个维度及其相互作用能够启发新的研究想法。其次，我们考察已有 RSI 方法如何借鉴传统深度学习，例如通过优化、正则化、数据增强、持续学习与对抗学习。我们通过考察更具体的学习机制并借鉴进化计算，进一步发展出新的想法。我们还梳理了已有基准如何在在线、离线与离线转在线设置下评估自我改进。总体而言，这些视角帮助研究者从已有的设计与学习机制中发展出新的 RSI 研究思路。'
const ZH_INTRO = '递归自我改进（RSI）是一个 AI 系统参与修改自身、保留这些修改，并在后续执行与改进中使用修订后系统的过程。其吸引力在于：一次改进可能让系统更擅长产生进一步的改进。于是，越来越多的 AI 开发工作可以由正在被开发的系统本身承担。这一可能性正是 Good 那句判断的基础——足够强大的机器也许会是人类需要做出的最后一项发明 [1]。'

const DEMO_FIGURE = {
  kind: 'framework',
  title: '论文框架',
  subtitle: '从设计空间到研究机会：分类法如何被用来生成新想法',
  groups: [
    { id: 'g1', label: '输入与资源' },
    { id: 'g2', label: '统一分类法（九维四组）' },
    { id: 'g3', label: '研究机会' },
  ],
  nodes: [
    { id: 'n1', group: 'g1', label: '智能体资源', desc: '参数 / 记忆 / 技能 / 代码', kind: 'data' },
    { id: 'n2', group: 'g1', label: '执行轨迹与反馈', desc: '在线 / 离线 / 离线转在线', kind: 'data' },
    { id: 'n3', group: 'g2', label: '更新对象', desc: '改什么：参数、记忆、技能', kind: 'module' },
    { id: 'n4', group: 'g2', label: '更新组织', desc: '怎么改：自生成、自筛选', kind: 'module' },
    { id: 'n5', group: 'g2', label: '调度与范围', desc: '何时改、改多大', kind: 'module' },
    { id: 'n6', group: 'g2', label: '反馈与选择', desc: '什么算变好', kind: 'module' },
    { id: 'n7', group: 'g3', label: '借鉴深度学习机制', desc: '优化 / 正则 / 增强 / 对抗', kind: 'insight' },
    { id: 'n8', group: 'g3', label: '可检验的新想法', desc: '沿维度交叉处提出假设', kind: 'result' },
  ],
  edges: [
    { from: 'n1', to: 'n3', style: 'solid' },
    { from: 'n2', to: 'n6', style: 'solid' },
    { from: 'n3', to: 'n4', style: 'solid' },
    { from: 'n4', to: 'n5', style: 'solid' },
    { from: 'n5', to: 'n6', style: 'solid' },
    { from: 'n6', to: 'n7', style: 'solid' },
    { from: 'n7', to: 'n8', style: 'solid' },
  ],
}

const DEMO_ANSWER = `这篇论文做的不是提出某个 RSI 方法，而是给整个方向**搭一张设计空间的地图**，再从地图的缝隙里指出可以做的研究。

**核心贡献**
- 提出一个九维、四组的统一分类法：更新对象（参数 / 记忆 / 技能 / 代码）、更新组织方式、更新调度与范围、反馈与选择 [p.1]。
- 把已有方法放进同一个设计空间，单看某一维或看维度之间的交叉，都能长出新问题 [p.1]。
- 第二条线索是把 RSI 与**传统深度学习**对齐：优化、正则化、数据增强、持续学习、对抗学习，再延伸到进化计算 [p.1]。

**它为什么有用**
分类法的价值不在「分类得漂亮」，而在于它把「还能怎么改」变成可枚举的问题。比如把「更新对象」和「调度」交叉，就能问：技能更新是否应该比参数更新更频繁？作者在正文里正是沿这类交叉点展开 [p.3]。

**需要注意的边界**
- 这是一篇综述 / 观点文章，结论是研究议程，不是实验结果，因此没有可复现的指标 [p.3]。
- 设计维度的划分依赖作者对文献的归纳，维度之间的独立性没有被验证。`

// ── stub model ───────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function* chunked(text, size = 24) {
  for (let i = 0; i < text.length; i += size) {
    await sleep(12)
    // Mirror the host llm service's chunk shape, not bare strings.
    yield { type: 'text-delta', index: 0, text: text.slice(i, i + size) }
  }
}

async function* stubStream(options) {
  const messages = options.messages || []
  const flatten = (m) => (Array.isArray(m.content) ? m.content.map((c) => c.text || '').join('') : String(m.content || ''))
  const system = messages.filter((m) => m.role === 'system').map(flatten).join('\n')
  const user = messages.filter((m) => m.role === 'user').map(flatten).join('\n')

  if (system.includes('只输出译文')) {
    yield* chunked('（示例译文）作者提出一个统一的九维分类法，把已有的递归自我改进方法放进同一个设计空间，并据此推导新的研究方向；同时把 RSI 与优化、正则化、数据增强、持续学习等传统机制对齐，用来生成可检验的新想法。')
    return
  }
  if (system.includes('译者')) {
    if (user.includes('"paragraphs"')) {
      const ids = [...user.matchAll(/"id":(\d+)/g)].map((m) => Number(m[1]))
      const translations = ids.map((id) => ({
        id,
        text: `（示例译文）第 ${id} 段：真实运行时由模型逐段翻译并缓存到这篇论文的 .zh.json，演示模式只保留固定样例。`,
      }))
      yield* chunked(JSON.stringify({ translations }), 60)
      return
    }
    yield* chunked('（示例译文）这一段在演示模式下没有预置译文。')
    return
  }
  if (system.includes('可视化编辑')) {
    yield* chunked(JSON.stringify(DEMO_FIGURE), 80)
    return
  }
  if (system.includes('伴读助手')) {
    yield* chunked(DEMO_ANSWER, 18)
    return
  }
  yield* chunked('（演示模式）这里是模型的回答。')
}

const ctx = {
  llm: {
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
    listModels: async () => [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }],
    stream: (options) => stubStream(options),
  },
  logger: { info: () => {} },
}

// ── seed ─────────────────────────────────────────────────────────────────
async function seed(store) {
  const lib = { version: 1, folders: [{ id: 'f-rsi', name: 'RSI 方向', createdAt: Date.now() }], papers: [] }

  const rsiId = 'p-rsi-2026'
  const dir = store.paperDir(rsiId)
  await mkdir(dir, { recursive: true })
  if (existsSync(RSI_PDF)) await copyFile(RSI_PDF, join(dir, 'paper.pdf'))
  const rsiTitle = 'From Existing Methods to New Research Ideas: Two Perspectives on Recursive Self-Improvement'
  const raw = JSON.parse(await readFile(join(ROOT, '.devdata', 'text-demo.json'), 'utf8'))
  const deduped = dropTitleEcho(raw, rsiTitle)
  const text = { ...deduped, abstract: detectAbstract(deduped.paragraphs) }
  await writeJson(join(dir, 'text.json'), text)

  const rsiMeta = {
    id: rsiId,
    title: rsiTitle,
    authors: ['Leijun Zhou', 'Yanke Yu', 'Zhihao Liu', 'Qu Xiang', 'Tiancheng Hu', 'Yiru Dong'],
    year: 2026,
    venue: 'arXiv preprint',
    arxivId: '2610.14625',
    source: 'arxiv',
    sourceUrl: 'https://arxiv.org/abs/2610.14625',
    folderId: 'f-rsi',
    tags: ['RSI', 'survey'],
    abstract: text.abstract.slice(0, 900),
    sizeBytes: 0,
    pages: text.pages.length,
    paragraphs: text.paragraphs.length,
    indexed: true,
    progress: 0.18,
    translatedCount: 2,
    addedAt: Date.now() - 86400000,
    updatedAt: Date.now() - 3600000,
    noteUpdatedAt: Date.now() - 7200000,
    translatedAt: Date.now() - 3600000,
  }
  lib.papers.push(rsiMeta)
  const entries = {}
  const { createHash } = await import('node:crypto')
  const putZh = (prefix, zh) => {
    const index = text.paragraphs.findIndex((p) => p.text.startsWith(prefix))
    if (index < 0) return
    const src = text.paragraphs[index].text
    entries[index] = { src: createHash('sha1').update(src).digest('hex').slice(0, 16), text: zh, at: Date.now(), target: 'zh' }
  }
  putZh('Recursive self-improvement (RSI) offers a route', ZH_ABSTRACT)
  putZh('Recursive self-improvement (RSI) is a process', ZH_INTRO)
  await writeJson(join(dir, 'zh.json'), { version: 1, target: 'zh', entries })
  await writeFile(join(dir, 'notes.md'), [
    '# 阅读笔记',
    '',
    '## 一句话',
    '把 RSI 的已有方法压进一个九维四组的设计空间，再从维度的交叉处推新想法。',
    '',
    '## 可复用的想法',
    '- 「更新对象 × 调度」这一格值得单独做实验：技能更新频率 > 参数更新频率，是否有稳定收益？',
    '- 反馈信号是否也能被自我改进？现在的分类里反馈是外生给定的。',
    '',
    '> 分类法的价值不在分类得漂亮，而在于它把「还能怎么改」变成可枚举的问题。',
  ].join('\n'), 'utf8')
  await writeJson(join(dir, 'meta.json'), rsiMeta)
  await writeJson(join(dir, 'chats.json'), {
    version: 1,
    threads: [{
      id: 'main',
      title: '这篇论文到底贡献了什么？',
      updatedAt: Date.now() - 1800000,
      messages: [
        { role: 'user', content: '这篇论文到底贡献了什么？和一般的 RSI 综述有什么不同？' },
        { role: 'assistant', content: DEMO_ANSWER },
      ],
    }],
  })
  await writeJson(join(dir, 'figures.json'), {
    version: 1,
    items: [{ ...DEMO_FIGURE, id: 'demo-fig', createdAt: Date.now() - 900000 }],
  })

  const extra = [
    { id: 'p-dexope', title: 'DexOPE: Dexterous Open-Ended Policy Evolution', folderId: 'f-rsi', year: 2026, pdf: DEXOPE_PDF },
    { id: 'p-q0', title: '[code2paper] Q0-Preview', folderId: null, year: 2026, pdf: 'D:\\DESKTOP\\[code2paper]Q0-Preview.pdf' },
  ]
  for (const item of extra) {
    const d = store.paperDir(item.id)
    await mkdir(d, { recursive: true })
    if (existsSync(item.pdf)) await copyFile(item.pdf, join(d, 'paper.pdf'))
    lib.papers.push({
      id: item.id,
      title: item.title,
      authors: [],
      year: item.year,
      venue: '',
      arxivId: null,
      source: 'upload',
      sourceUrl: null,
      folderId: item.folderId,
      tags: [],
      abstract: '',
      sizeBytes: 0,
      pages: 0,
      paragraphs: 0,
      indexed: false,
      progress: 0,
      addedAt: Date.now() - 86400000 * 3,
      updatedAt: Date.now() - 86400000 * 2,
    })
  }

  lib.papers.sort((a, b) => b.updatedAt - a.updatedAt)
  await writeJson(store.libraryFile, lib)
  await writeJson(store.configFile, { discipline: '人工智能 / 智能体系统' })
}

const store = new Store(DATA)
await store.init()
const existing = await readFile(store.libraryFile, 'utf8').then((raw) => JSON.parse(raw)).catch(() => null)
if (!existing?.papers?.length || process.env.RESEED === '1') {
  await seed(store)
  console.log('seeded demo library at', DATA)
}

const handler = createHandler({ ctx, store, config: {} })
const server = http.createServer((req, res) => {
  handler(req, res).catch((err) => {
    if (res.headersSent) { try { res.end() } catch {} ; return }
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: String(err?.message || err) }))
  })
})
server.listen(PORT, '127.0.0.1', () => {
  console.log(`paper-studio dev server → http://127.0.0.1:${PORT}/paper-studio/`)
})
