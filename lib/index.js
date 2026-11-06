// Paper Studio — host half.
//
// One prefix route owns everything the reader needs:
//   GET  /paper-studio/                the study desk (single-page app)
//   GET  /paper-studio/<asset>         its css/js/fonts/pdf.js vendor
//   *    /paper-studio/api/...         library, import, translate, chat, figures
//
// The host half owns all disk and model access. The browser never sees a file
// path, an API key, or a provider credential — only paper ids.

import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

import { Store, defaultDataDir, ensureDir, newId, readJson, writeJson } from './store.js'
import {
  HttpError, json, ndjson, readBody, readJsonBody, serveFile,
} from './http.js'
import { downloadPdf, fetchArxivMeta, guessTitleFromText, parseArxiv } from './import.js'
import { listAvailableModels, resetSelection, resolveSelection, setUsageReporter, streamText } from './llm.js'
import { buildChatRequest, suggestQuestions } from './chat.js'
import { hashText, languageName, translateParagraphs } from './translate.js'
import { generateFigure } from './figures.js'
import { babeldocStatus, outputPaths, runBabeldoc } from './babeldoc.js'
import { detectBaiduLocal, targetPathFor } from './sync/local.js'
import { estimateTokens, formatTokens } from './usage.js'
import { buildGlossary } from './glossary.js'
import { Recommender } from './recommend.js'
import { SyncEngine } from './sync/engine.js'
import {
  baiduAuthorizeUrl, baiduExchange, CALLBACK_PATH, CALLBACK_PORT,
  googleAuthorizeUrl, googleExchange, startAuthorization,
} from './sync/oauth.js'

const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url))
const PLUGIN_VERSION = JSON.parse(await readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const MAX_TEXT_BYTES = 24 * 1024 * 1024

export const name = 'paper-studio'

export function apply(ctx, config = {}) {
  const store = new Store(config.dataDir || defaultDataDir())

  // `llm` must be declared, not merely read: cordis traps every property access
  // on an undeclared service ("cannot get property 'llm' without inject"), which
  // is what broke translation, chat and diagrams at runtime.
  ctx.inject(['webServer', 'connection', 'llm'], (rctx) => {
    const connection = rctx.connection
    const webServer = rctx.webServer
    const handler = createHandler({ ctx: rctx, store, config })
    const dispose = webServer.register({
      kind: 'prefix',
      path: '/paper-studio',
      handler: (req, res) => {
        // Plugin routes live outside the host's own /api authorization path, so
        // they must repeat the same Origin/Host guard themselves.
        try {
          const rejection = connection?.requestRejection?.(req)
          if (rejection !== undefined && rejection !== null) {
            json(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
            return
          }
        } catch { /* an older host without the guard: continue */ }
        handler(req, res).catch((err) => {
          if (res.headersSent) { try { res.end() } catch {} ; return }
          const status = err instanceof HttpError ? err.status : 500
          json(res, status, { error: String(err?.message || err), code: err?.code || 'error' })
        })
      },
    })
    rctx.effect(() => () => dispose(), 'paper-studio: routes')
    console.log('[paper-studio] ready at /paper-studio/')
  })
}

export function createHandler({ ctx, store, config = {} }) {
  /** Settings edited in the app, reloaded from disk at first use. */
  let appConfig = {}
  // Shape matters: services read `config.llm` for the model and `config.http`
  // for the direct endpoint. A flat object silently disabled both.
  const llmConfig = () => ({
    llm: { ...(config?.llm ?? {}), ...(appConfig?.llm ?? {}) },
    http: appConfig?.http,
  })

  /** Tokens are persisted into config.json, never returned to the browser. */
  const persistTokens = async (kind, tokens) => {
    const sync = { ...(appConfig?.sync || {}) }
    sync.target = { ...(sync.target || {}), ...tokens }
    appConfig = { ...appConfig, sync }
    await store.saveConfig({ sync })
  }
  const syncEngine = () => new SyncEngine({
    store,
    config: appConfig,
    onTokens: (tokens) => persistTokens(appConfig?.sync?.kind, tokens).catch(() => {}),
  })
  const recommender = new Recommender({ store, getLibrary: () => store.library() })
  /** Last OAuth attempt, polled by the settings panel. */
  let authState = { status: 'idle', error: null, at: 0 }

  /** The model an explicit config names, if any (beats auto-detection). */
  const explicitModel = () => {
    const wanted = llmConfig().llm || {}
    if (wanted.mode === 'http') return null
    if (!wanted.provider || !wanted.model) return null
    return { provider: wanted.provider, model: wanted.model, via: 'host' }
  }

  // Every model call reports here; tokens are attributed to the paper it served.
  setUsageReporter((entry) => {
    if (!entry?.paperId) return
    const prompt = estimateTokens(entry.promptText)
    const completion = estimateTokens(entry.completionText)
    if (!prompt && !completion) return
    store.addUsage(entry.paperId, { prompt, completion }, entry.kind)
      .catch((err) => ctx?.logger?.warn?.("paper-studio usage", err))
  })

  let initialized = null
  const ready = async () => {
    if (!initialized) {
      initialized = (async () => {
        await store.init()
        appConfig = await store.config()
      })()
    }
    return initialized
  }

  const handle = async function handle(req, res) {
    await ready()
    const url = new URL(req.url || '/', 'http://paper-studio.local')
    const sub = url.pathname.slice('/paper-studio'.length) || '/'
    const method = req.method || 'GET'

    if (!sub.startsWith('/api/')) {
      return serveStatic(req, res, sub)
    }

    const api = sub.slice('/api'.length)

    // ---- library -------------------------------------------------------
    if (api === '/state' && method === 'GET') {
      const [papers, folders, cfg] = await Promise.all([store.listPapers(), store.folders(), store.config()])
      let selection = explicitModel()
      if (!selection) {
        try { selection = await resolveSelection(ctx, llmConfig()) } catch { selection = null }
      }
      return json(res, 200, {
        papers,
        folders,
        config: publicConfig(cfg),
        selection,
        dataDir: store.root,
      })
    }

    if (api === '/import/upload' && method === 'POST') {
      const fileName = decodeURIComponent(req.headers['x-ps-name'] || 'paper.pdf')
      const folderId = req.headers['x-ps-folder'] ? String(req.headers['x-ps-folder']) : null
      const bytes = await readBody(req)
      if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
        throw new HttpError(400, '这不是一个 PDF 文件', 'not-pdf')
      }
      const paper = await createPaper(store, {
        bytes,
        fileName,
        folderId,
        source: 'upload',
        sourceUrl: null,
      })
      return json(res, 200, { paper })
    }

    if (api === '/import/url' && method === 'POST') {
      const body = await readJsonBody(req)
      const raw = String(body.url || '').trim()
      if (!raw) throw new HttpError(400, '请填写链接', 'bad-url')
      const folderId = body.folderId || null
      const arxiv = parseArxiv(raw)
      const target = arxiv ? arxiv.pdfUrl : raw
      if (!/^https?:\/\//i.test(target)) throw new HttpError(400, '只支持 http(s) 链接或 arXiv 编号', 'bad-url')
      const { bytes, finalUrl } = await downloadPdf(target)
      const meta = arxiv ? await fetchArxivMeta(arxiv.id) : null
      const paper = await createPaper(store, {
        bytes,
        fileName: arxiv ? `arXiv-${arxiv.id}.pdf` : guessFileName(finalUrl),
        folderId,
        source: arxiv ? 'arxiv' : 'url',
        sourceUrl: finalUrl,
        arxivId: arxiv?.id ?? null,
        prefill: meta,
      })
      return json(res, 200, { paper })
    }

    // ---- one paper ------------------------------------------------------
    const paperMatch = api.match(/^\/paper\/([a-zA-Z0-9_-]+)(\/[a-z-]+)?$/)
    if (paperMatch) {
      const id = paperMatch[1]
      const leaf = paperMatch[2] || ''
      const paper = await store.getPaper(id)
      if (!paper) throw new HttpError(404, '论文不存在', 'not-found')

      if (leaf === '' && method === 'GET') {
        const [notes, chats, figures, text, zh] = await Promise.all([
          store.notes(id), store.chats(id), store.figures(id), store.text(id), store.translations(id),
        ])
        return json(res, 200, {
          paper,
          notes,
          chats,
          figures,
          hasText: Boolean(text),
          summary: text ? { pages: text.pages?.length ?? 0, paragraphs: text.paragraphs?.length ?? 0, abstract: text.abstract ?? '' } : null,
          translated: Object.keys(zh?.entries ?? {}).length,
          translationModels: [...new Set(Object.values(zh?.entries ?? {}).map((e) => e.model).filter(Boolean))],
          usage: await store.usage(id),
          babeldoc: (() => {
            const paths = outputPaths(store.paperDir(id))
            return { dual: existsSync(paths.dual), mono: existsSync(paths.mono) }
          })(),
          suggestions: suggestQuestions(),
        })
      }

      if (leaf === '/pdf' && method === 'GET') {
        return serveFile(res, store.paperDir(id), 'paper.pdf', { cache: 'private, max-age=300' })
      }

      if (leaf === '/text' && method === 'GET') {
        const text = await store.text(id)
        if (!text) throw new HttpError(404, '这篇论文还没有解析文本', 'no-text')
        return json(res, 200, text)
      }

      if (leaf === '/zh' && method === 'GET') {
        return json(res, 200, await store.translations(id))
      }

      if (leaf === '/index' && method === 'POST') {
        const body = await readJsonBody(req, MAX_TEXT_BYTES)
        const text = sanitizeText(body)
        if (!text.paragraphs.length) throw new HttpError(400, '没有解析到正文段落', 'empty-text')
        await store.saveText(id, text)
        const patch = {
          pages: text.pages.length,
          paragraphs: text.paragraphs.length,
          indexed: true,
          chars: text.paragraphs.reduce((n, p) => n + p.text.length, 0),
        }
        if (!paper.title || paper.title === paper.fileName?.replace(/\.pdf$/i, '')) {
          const guessed = guessTitleFromText(text.paragraphs.map((p) => p.text).join('\n'))
          if (guessed) patch.title = guessed
        }
        if (text.abstract && !paper.abstract) patch.abstract = text.abstract.slice(0, 1200)
        const updated = await store.patchPaper(id, patch)
        return json(res, 200, { paper: updated })
      }

      if (leaf === '/meta' && method === 'POST') {
        const body = await readJsonBody(req)
        const allowed = ['title', 'authors', 'year', 'venue', 'tags', 'folderId', 'progress']
        const patch = {}
        for (const key of allowed) if (body[key] !== undefined) patch[key] = body[key]
        const updated = await store.patchPaper(id, patch)
        return json(res, 200, { paper: updated })
      }

      if (leaf === '/notes' && method === 'GET') {
        return json(res, 200, { notes: await store.notes(id), updatedAt: paper.noteUpdatedAt ?? null })
      }

      if (leaf === '/notes' && method === 'POST') {
        const body = await readJsonBody(req, 4 * 1024 * 1024)
        await store.saveNotes(id, String(body.markdown ?? ''))
        return json(res, 200, { ok: true, updatedAt: Date.now() })
      }

      if (leaf === '/threads' && method === 'POST') {
        const body = await readJsonBody(req, 8 * 1024 * 1024)
        const data = { version: 1, threads: Array.isArray(body.threads) ? body.threads : [] }
        await store.saveChats(id, data)
        return json(res, 200, { ok: true })
      }

      if (leaf === '/figures' && method === 'GET') {
        return json(res, 200, await store.figures(id))
      }

      if (leaf === '/delete' && method === 'POST') {
        const ok = await store.removePaper(id)
        return json(res, 200, { ok })
      }
    }

    if (method === 'DELETE') {
      const m = api.match(/^\/paper\/([a-zA-Z0-9_-]+)$/)
      if (m) return json(res, 200, { ok: await store.removePaper(m[1]) })
    }

    // ---- translation ----------------------------------------------------
    const trMatch = api.match(/^\/paper\/([a-zA-Z0-9_-]+)\/(translate|translate-selection)$/)
    if (trMatch && method === 'POST') {
      const id = trMatch[1]
      const paper = await store.getPaper(id)
      if (!paper) throw new HttpError(404, '论文不存在', 'not-found')
      const body = await readJsonBody(req, 4 * 1024 * 1024)
      const target = String(body.target || 'zh')
      const text = await store.text(id)
      if (!text && trMatch[2] === 'translate') throw new HttpError(400, '还没有解析文本', 'no-text')
      const stream = ndjson(res)
      const controller = new AbortController()
      res.on('close', () => controller.abort())
      try {
        if (trMatch[2] === 'translate-selection') {
          const src = String(body.text || '').trim()
          if (!src) throw new HttpError(400, '没有选中文本', 'empty')
          let out = ''
          for await (const delta of streamText(ctx, llmConfig(), {
            // Low effort on purpose: selection feedback must feel instant.
            system: `把下面这段论文文字译成${languageName(target)}，只输出译文，不要解释。`,
            messages: [{ role: 'user', content: src }],
            maxTokens: 480,
            signal: controller.signal,
            usage: { paperId: id, kind: 'selection' },
          })) {
            out += delta
            if (!stream.send({ type: 'delta', text: delta })) break
          }
          stream.send({ type: 'done', text: out.trim() })
          return stream.end()
        }
        const zh = await store.translations(id)
        const entries = zh.entries || (zh.entries = {})
        const all = text.paragraphs
        const wanted = Array.isArray(body.ids) && body.ids.length
          ? all.filter((p) => body.ids.includes(p.i))
          : all
        const style = String(body.style || appConfig?.translateStyle || 'academic')
        // Terminology is shared by every paragraph: build it once, reuse it.
        let glossary = await store.glossary(id).catch(() => null)
        if (!glossary && wanted.length > 25) {
          stream.send({ type: 'phase', text: '正在整理术语表…' })
          glossary = await buildGlossary(ctx, { ...llmConfig(), usage: { paperId: id, kind: 'glossary' } }, {
            title: paper.title,
            paragraphs: text.paragraphs,
            discipline: paper.discipline || appConfig?.discipline || '',
            signal: controller.signal,
          }).catch(() => null)
          if (glossary) await store.saveGlossary(id, glossary).catch(() => {})
        }
        const sectionMap = new Map()
        let currentSection = ''
        for (const p of text.paragraphs) {
          if (p.heading === 'h') currentSection = String(p.text || '').slice(0, 80)
          sectionMap.set(p.i, currentSection)
        }
        const selection = explicitModel() ?? await resolveSelection(ctx, llmConfig()).catch(() => null)
        const modelKey = selection ? selection.provider + '/' + selection.model : 'unknown'
        stream.send({ type: 'start', total: wanted.length, model: modelKey })
        let saved = 0
        for await (const item of translateParagraphs(ctx, { ...llmConfig(), usage: { paperId: id, kind: 'translate' } }, {
          paragraphs: wanted,
          target,
          discipline: paper.discipline || '',
          concurrency: Math.max(1, Math.min(6, Number(body.concurrency) || 3)),
          signal: controller.signal,
          cache: entries,
          modelKey,
          force: Boolean(body.force),
          style,
          glossary: glossary || [],
          sectionOf: (i) => sectionMap.get(i) || '',
        })) {
          if (item.error) {
            stream.send({ type: 'para', i: item.i, error: item.error, done: item.done, total: item.total })
            continue
          }
          const src = all.find((p) => p.i === item.i)?.text ?? ''
          entries[item.i] = { src: hashText(src), text: item.text, at: Date.now(), target, model: modelKey }
          saved++
          stream.send({ type: 'para', i: item.i, text: item.text, done: item.done, total: item.total })
          if (item.done % 12 === 0) await store.saveTranslations(id, zh)
        }
        await store.saveTranslations(id, zh)
        await store.patchPaper(id, { translatedAt: Date.now(), translatedCount: Object.keys(entries).length })
        stream.send({ type: 'done', saved, total: wanted.length })
        // Fire-and-forget: keep the cloud copy current after a translation run.
        if (appConfig?.sync?.kind) {
          void (async () => {
            try {
              for await (const _event of syncEngine().run()) { /* drain */ }
            } catch (err) {
              ctx?.logger?.warn?.('paper-studio sync after translate', err)
            }
          })()
        }
        return stream.end()
      } catch (err) {
        stream.fail(String(err?.message || err))
        return
      }
    }

    // ---- chat -----------------------------------------------------------
    const chatMatch = api.match(/^\/paper\/([a-zA-Z0-9_-]+)\/chat$/)
    if (chatMatch && method === 'POST') {
      const id = chatMatch[1]
      const paper = await store.getPaper(id)
      if (!paper) throw new HttpError(404, '论文不存在', 'not-found')
      const body = await readJsonBody(req, 4 * 1024 * 1024)
      const question = String(body.question || '').trim()
      if (!question) throw new HttpError(400, '问题为空', 'empty')
      const text = await store.text(id)
      if (!text) throw new HttpError(400, '还没有解析文本，无法检索', 'no-text')
      const request = buildChatRequest({
        meta: paper,
        paragraphs: text.paragraphs,
        question,
        history: Array.isArray(body.history) ? body.history : [],
        mode: String(body.mode || 'auto'),
        selection: String(body.selection || ''),
      })
      const stream = ndjson(res)
      const controller = new AbortController()
      // A closed socket means the reader went away; a *finished* response also
      // fires close on some hosts, so only abort while we are still streaming.
      let finished = false
      res.on('close', () => { if (!finished) controller.abort() })
      let answer = ''
      try {
        const override = body.model
          ? {
            provider: String(body.provider || 'deepseek-official'),
            model: String(body.model),
            via: body.provider === 'custom-http' ? 'http' : 'host',
          }
          : null
        for await (const delta of streamText(ctx, llmConfig(), {
          system: request.system,
          messages: request.messages,
          signal: controller.signal,
          maxTokens: 3000,
          usage: { paperId: id, kind: 'chat' },
        }, override)) {
          answer += delta
          if (!stream.send({ type: 'delta', text: delta })) break
        }
        stream.send({
          type: 'done',
          answer,
          citations: request.excerpts.map((p) => ({ page: p.page, i: p.i, heading: p.heading ?? '' })),
        })
        finished = true
        return stream.end()
      } catch (err) {
        stream.fail(String(err?.message || err))
        return
      }
    }

    // ---- figures --------------------------------------------------------
    const figMatch = api.match(/^\/paper\/([a-zA-Z0-9_-]+)\/figure$/)
    if (figMatch && method === 'POST') {
      const id = figMatch[1]
      const paper = await store.getPaper(id)
      if (!paper) throw new HttpError(404, '论文不存在', 'not-found')
      const body = await readJsonBody(req)
      const text = await store.text(id)
      if (!text) throw new HttpError(400, '还没有解析文本，无法生成框架图', 'no-text')
      const kind = ['framework', 'concept', 'compare'].includes(body.kind) ? body.kind : 'framework'
      const spec = await generateFigure(ctx, llmConfig(), {
        kind, meta: paper, text, note: String(body.note || ''),
      })
      const figures = await store.figures(id)
      spec.id = randomUUID().slice(0, 8)
      figures.items = [spec, ...(figures.items || [])].slice(0, 24)
      await store.saveFigures(id, figures)
      await store.patchPaper(id, { figureAt: Date.now() })
      return json(res, 200, { figure: spec })
    }

    // ---- discovery -----------------------------------------------------
    if (api === '/discover' && method === 'GET') {
      const paperId = url.searchParams.get('paperId')
      const force = url.searchParams.get('force') === '1'
      const paper = paperId ? await store.getPaper(paperId) : null
      const data = await recommender.discover(paper, { force })
      const library = (await store.listPapers()).map((p) => ({ id: p.id, title: p.title, arxivId: p.arxivId }))
      return json(res, 200, { ...data, library })
    }

    // ---- sync ----------------------------------------------------------
    if (api === '/sync/status' && method === 'GET') {
      const status = await syncEngine().status()
      return json(res, 200, {
        ...status,
        config: publicSyncConfig(appConfig?.sync),
        auth: authState,
        redirectUri: `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`,
      })
    }

    // Local Baidu Netdisk folder: the desktop client keeps it in sync, so we
    // only have to write into it.
    if (api === '/sync/baidu-local' && method === 'GET') {
      const dirs = (await detectBaiduLocal()).map((dir) => ({ ...dir, target: targetPathFor(dir.path) }))
      const current = appConfig?.sync?.kind === 'folder' ? appConfig.sync.target?.root || null : null
      return json(res, 200, { dirs, current })
    }

    if (api === '/sync/config' && method === 'POST') {
      const body = await readJsonBody(req)
      const prev = appConfig?.sync || {}
      const prevTarget = prev.target || {}
      const incoming = body.target && typeof body.target === 'object' ? body.target : {}
      const target = { ...prevTarget, ...incoming }
      // Blank secret fields mean "keep the stored one" rather than "clear it".
      for (const key of ['clientSecret', 'password', 'appSecret']) {
        if (!incoming[key]) {
          if (prevTarget[key]) target[key] = prevTarget[key]
          else delete target[key]
        }
      }
      if (target.refreshToken === '' || target.refreshToken === undefined) {
        if (prevTarget.refreshToken) target.refreshToken = prevTarget.refreshToken
        else delete target.refreshToken
      }
      const kind = body.kind ?? prev.kind ?? null
      if (kind !== prev.kind) delete target.refreshToken
      // A new destination starts from scratch: the old snapshot describes a
      // different cloud, so keeping it would suppress the first full upload.
      const moved = kind !== prev.kind
        || (target.root || '') !== (prevTarget.root || '')
        || (target.baseUrl || '') !== (prevTarget.baseUrl || '')
        || (target.rootDir || '') !== (prevTarget.rootDir || '')
      if (moved) {
        await rm(join(store.root, '.sync', 'state.json'), { force: true }).catch(() => {})
      }
      const sync = { kind, includePdf: body.includePdf === undefined ? Boolean(prev.includePdf) : Boolean(body.includePdf), target }
      appConfig = { ...appConfig, sync }
      await store.saveConfig({ sync })
      authState = { status: 'idle', error: null, at: Date.now() }
      return json(res, 200, { config: publicSyncConfig(sync) })
    }

    if (api === '/sync/test' && method === 'POST') {
      try {
        const provider = syncEngine().provider()
        const detail = await provider.test()
        return json(res, 200, { ok: true, detail })
      } catch (err) {
        return json(res, 200, { ok: false, detail: String(err?.message || err) })
      }
    }

    if (api === '/sync/connect' && method === 'POST') {
      const body = await readJsonBody(req)
      const kind = body.kind || appConfig?.sync?.kind
      const target = { ...(appConfig?.sync?.target || {}), ...(body.target || {}) }
      if (kind === 'gdrive' && (!target.clientId || !target.clientSecret)) {
        throw new HttpError(400, '请先填写 Google 的 Client ID 与 Client Secret', 'need-credentials')
      }
      if (kind === 'baidu' && (!target.appKey || !target.appSecret)) {
        throw new HttpError(400, '请先填写百度开放平台的 AppKey 与 SecretKey', 'need-credentials')
      }
      if (!['gdrive', 'baidu'].includes(kind)) throw new HttpError(400, '这个同步目标不需要网页授权', 'no-oauth')
      const flow = await startAuthorization({
        provider: kind,
        buildUrl: ({ redirectUri, state }) => (kind === 'gdrive'
          ? googleAuthorizeUrl({ clientId: target.clientId, redirectUri, state })
          : baiduAuthorizeUrl({ appKey: target.appKey, redirectUri, state })),
      })
      authState = { status: 'pending', error: null, at: Date.now(), kind }
      flow.wait().then(async ({ code, redirectUri }) => {
        try {
          const tokens = kind === 'gdrive'
            ? await googleExchange({ code, clientId: target.clientId, clientSecret: target.clientSecret, redirectUri })
            : await baiduExchange({ code, appKey: target.appKey, appSecret: target.appSecret, redirectUri })
          const sync = {
            kind,
            includePdf: Boolean(appConfig?.sync?.includePdf),
            target: { ...target, ...tokens },
          }
          appConfig = { ...appConfig, sync }
          await store.saveConfig({ sync })
          authState = { status: 'done', error: null, at: Date.now(), kind }
        } catch (err) {
          authState = { status: 'error', error: String(err?.message || err), at: Date.now(), kind }
        }
      }).catch((err) => {
        authState = { status: 'error', error: String(err?.message || err), at: Date.now(), kind }
      })
      return json(res, 200, { url: flow.url, redirectUri: flow.redirectUri })
    }

    if (api === '/sync/run' && method === 'POST') {
      const stream = ndjson(res)
      try {
        for await (const event of syncEngine().run()) {
          if (!stream.send(event)) break
        }
        return stream.end()
      } catch (err) {
        stream.fail(String(err?.message || err))
        return
      }
    }

    // ---- meta: folders & config ----------------------------------------
    if (api === '/folders' && method === 'POST') {
      const body = await readJsonBody(req)
      return json(res, 200, { folder: await store.addFolder(body.name) })
    }
    const folderMatch = api.match(/^\/folders\/([a-zA-Z0-9_-]+)$/)
    if (folderMatch) {
      if (method === 'POST') {
        const body = await readJsonBody(req)
        return json(res, 200, { folder: await store.renameFolder(folderMatch[1], body.name) })
      }
      if (method === 'DELETE') return json(res, 200, { ok: await store.removeFolder(folderMatch[1]) })
    }

    if (api === '/config' && method === 'POST') {
      const body = await readJsonBody(req)
      const patch = {}
      if (body.llm && typeof body.llm === 'object') {
        const mode = ['auto', 'host', 'http'].includes(body.llm.mode) ? body.llm.mode : 'auto'
        patch.llm = {
          mode,
          provider: body.llm.provider || undefined,
          model: body.llm.model || undefined,
        }
      }
      if (body.http && typeof body.http === 'object') {
        patch.http = {
          baseUrl: String(body.http.baseUrl || '').trim() || undefined,
          apiKey: String(body.http.apiKey || '').trim() || undefined,
          model: String(body.http.model || '').trim() || undefined,
        }
      }
      if (body.translateStyle !== undefined) {
        patch.translateStyle = ['academic', 'plain', 'concise'].includes(body.translateStyle) ? body.translateStyle : 'academic'
      }
      if (body.discipline !== undefined) patch.discipline = String(body.discipline).slice(0, 40)
      const saved = await store.saveConfig(patch)
      appConfig = saved
      resetSelection()
      return json(res, 200, { config: publicConfig(saved), selection: explicitModel() ?? await resolveSelection(ctx, llmConfig()) })
    }

    // Move the key over from the older paper-reading plugin, so a user who
    // already paid for translations does not have to find it again.
    if (api === '/import-key' && method === 'POST') {
      const candidates = [
        join(homedir(), '.dsh', '.dsh-paper-reader', 'translate.json'),
        join(homedir(), '.dsh-paper-reader', 'translate.json'),
      ]
      for (const file of candidates) {
        const data = await readJson(file, null).catch(() => null)
        if (!data) continue
        const apiKey = String(data.apiKey || data.key || '').trim()
        if (!apiKey) continue
        const http = {
          baseUrl: String(data.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
          model: String(data.model || 'deepseek-chat'),
          apiKey,
        }
        const saved = await store.saveConfig({ http, llm: { mode: 'auto' } })
        appConfig = saved
        resetSelection()
        return json(res, 200, {
          ok: true,
          source: file,
          http: { baseUrl: http.baseUrl, model: http.model, hasKey: true },
          selection: await resolveSelection(ctx, llmConfig()),
        })
      }
      throw new HttpError(404, '没有找到论文伴读的 translate.json（也可以手动填 Key）', 'no-key')
    }

    const usageMatch = api.match(/^\/paper\/([a-zA-Z0-9_-]+)\/usage$/)
    if (usageMatch && method === 'GET') {
      const usage = await store.usage(usageMatch[1])
      return json(res, 200, { usage, total: formatTokens((usage?.prompt || 0) + (usage?.completion || 0)) })
    }

    if (api === '/models' && method === 'GET') {
      const items = await listAvailableModels(ctx, llmConfig())
      let current = null
      const configured = explicitModel()
      if (configured) current = configured.provider + '/' + configured.model
      else {
        try {
          const selection = await resolveSelection(ctx, llmConfig())
          if (selection) current = selection.provider + '/' + selection.model
        } catch { /* no selection */ }
      }
      return json(res, 200, { items, current })
    }

    if (api === '/babeldoc' && method === 'GET') {
      const paperId = url.searchParams.get('paperId')
      const paper = paperId ? await store.getPaper(paperId) : null
      const status = await babeldocStatus(paper ? store.paperDir(paper.id) : join(store.root, 'papers', 'none'))
      const http = llmConfig().http || {}
      const apiKey = http.apiKey || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || ''
      return json(res, 200, {
        ...status,
        ready: Boolean(apiKey),
        endpoint: http.baseUrl || 'https://api.deepseek.com/v1',
        model: http.model || 'deepseek-chat',
      })
    }

    const bbRun = api.match(/^\/paper\/([a-zA-Z0-9_-]+)\/babeldoc$/)
    if (bbRun && method === 'POST') {
      const paper = await store.getPaper(bbRun[1])
      if (!paper) throw new HttpError(404, '论文不存在', 'not-found')
      const pdf = join(store.paperDir(paper.id), 'paper.pdf')
      const http = llmConfig().http || {}
      const apiKey = http.apiKey || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || ''
      const body = await readJsonBody(req).catch(() => ({}))
      const stream = ndjson(res)
      const controller = new AbortController()
      res.on('close', () => controller.abort())
      try {
        for await (const event of runBabeldoc({
          paperDir: store.paperDir(paper.id),
          sourcePdf: pdf,
          endpoint: body.endpoint || http.baseUrl || 'https://api.deepseek.com/v1',
          model: body.model || http.model || 'deepseek-chat',
          apiKey,
          signal: controller.signal,
        })) {
          if (!stream.send(event)) break
        }
        if (stream.closed) {
          stream.end()
          return
        }
        const paths = outputPaths(store.paperDir(paper.id))
        await store.patchPaper(paper.id, { babeldocAt: Date.now() })
        stream.send({ type: 'ready', dual: paths.dual, mono: paths.mono })
        return stream.end()
      } catch (err) {
        stream.fail(String(err?.message || err))
        return
      }
    }

    const bbFile = api.match(/^\/paper\/([a-zA-Z0-9_-]+)\/babeldoc\/(dual|mono)$/)
    if (bbFile && method === 'GET') {
      const paper = await store.getPaper(bbFile[1])
      if (!paper) throw new HttpError(404, '论文不存在', 'not-found')
      const paths = outputPaths(store.paperDir(paper.id))
      const target = bbFile[2] === 'dual' ? 'paper.dual.pdf' : 'paper.zh.pdf'
      return serveFile(res, paths.dir, target, { cache: 'private, max-age=300' })
    }

    if (api === '/ping' && method === 'GET') {
      let selection = null
      let error = null
      try { selection = await resolveSelection(ctx, llmConfig()) } catch (err) { error = String(err?.message || err) }
      return json(res, 200, { ok: !error, selection, error })
    }

    throw new HttpError(404, `未知接口 ${sub}`, 'unknown-route')
  }

  async function serveStatic(req, res, sub) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed')
    const rel = sub === '/' || sub === '' ? 'index.html' : sub.replace(/^\/+/, '')
    return serveFile(res, WEB_ROOT, rel, { cache: rel === 'index.html' ? 'no-cache' : 'public, max-age=600' })
  }

  // One place turns HttpError into a status code; without it a bad URL or a
  // missing paper would surface as an opaque 500.
  return async function dispatched(req, res) {
    try {
      return await handle(req, res)
    } catch (err) {
      if (res.headersSent) {
        try { res.end() } catch { /* already gone */ }
        return
      }
      const status = err instanceof HttpError ? err.status : 500
      if (status >= 500) console.error('[paper-studio]', err)
      json(res, status, { error: String(err?.message || err), code: err?.code || 'error' })
    }
  }
}

function publicConfig(cfg) {
  return {
    version: PLUGIN_VERSION,
    discipline: cfg?.discipline || '',
    translateStyle: cfg?.translateStyle || 'academic',
    llm: { mode: cfg?.llm?.mode || 'auto', ...(cfg?.llm || {}) },
    http: {
      baseUrl: cfg?.http?.baseUrl || '',
      model: cfg?.http?.model || '',
      hasKey: Boolean(cfg?.http?.apiKey || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY),
      fromEnv: Boolean(!cfg?.http?.apiKey && (process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY)),
    },
    sync: publicSyncConfig(cfg?.sync),
  }
}

/** Everything the settings panel needs, with every secret stripped. */
function publicSyncConfig(sync) {
  const target = sync?.target || {}
  return {
    kind: sync?.kind || null,
    includePdf: Boolean(sync?.includePdf),
    target: {
      root: target.root || '',
      baseUrl: target.baseUrl || '',
      username: target.username || '',
      clientId: target.clientId || '',
      folderName: target.folderName || 'DSH Paper Studio',
      appKey: target.appKey || '',
      rootDir: target.rootDir || '',
    },
    secrets: {
      webdav: Boolean(target.password),
      gdrive: Boolean(target.clientSecret),
      baidu: Boolean(target.appSecret),
    },
    connected: Boolean(target.refreshToken),
  }
}

function guessFileName(url) {
  try {
    const u = new URL(url)
    const last = u.pathname.split('/').filter(Boolean).pop() || 'paper.pdf'
    return /\.pdf$/i.test(last) ? decodeURIComponent(last) : `${decodeURIComponent(last)}.pdf`
  } catch {
    return 'paper.pdf'
  }
}

async function createPaper(store, { bytes, fileName, folderId, source, sourceUrl, arxivId, prefill }) {
  const id = newId()
  await ensureDir(store.paperDir(id))
  await store.importBytes(id, bytes)
  const size = bytes.length
  const meta = {
    id,
    title: prefill?.title || paperTitle(fileName),
    fileName,
    authors: Array.isArray(prefill?.authors) && prefill.authors.length
      ? prefill.authors.slice(0, 24)
      : guessAuthors(fileName),
    year: prefill?.year ?? null,
    venue: '',
    arxivId: arxivId ?? null,
    source,
    sourceUrl: sourceUrl ?? null,
    folderId: folderId ?? null,
    tags: [],
    abstract: prefill?.abstract ? String(prefill.abstract).slice(0, 1600) : '',
    sizeBytes: size,
    pages: 0,
    paragraphs: 0,
    indexed: false,
    progress: 0,
    addedAt: Date.now(),
    updatedAt: Date.now(),
  }
  await writeJson(join(store.paperDir(id), 'meta.json'), meta)
  await store.upsertPaper(meta)
  return meta
}

function paperTitle(fileName) {
  return String(fileName || 'paper.pdf')
    .replace(/\.pdf$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 200) || '未命名论文'
}

function guessAuthors(fileName) {
  const base = String(fileName || '').replace(/\.pdf$/i, '')
  const m = base.match(/^([A-Z][a-zA-Z.\-']+(?:\s+(?:and|&)\s+[A-Z][a-zA-Z.\-']+)*)/)
  return m ? m[1].split(/\s+(?:and|&)\s+/).slice(0, 6) : []
}

/** Keep only the fields the reader needs, and bound their sizes. */
function sanitizeText(body) {
  const pages = Array.isArray(body?.pages) ? body.pages : []
  const paragraphs = Array.isArray(body?.paragraphs) ? body.paragraphs : []
  const clean = []
  let i = 0
  for (const p of paragraphs) {
    const text = String(p?.text ?? '').replace(/\u0000/g, '').trim()
    if (text.length < 2) continue
    const box = {}
    for (const key of ['x', 'y', 'w', 'h', 'size']) {
      const value = Number(p?.[key])
      if (Number.isFinite(value)) box[key] = Math.round(value * 10) / 10
    }
    clean.push({
      i: i++,
      page: Number(p?.page) || 1,
      text: text.slice(0, 8000),
      heading: p?.heading ? String(p.heading).slice(0, 160) : '',
      ...box,
    })
  }
  return {
    version: 1,
    pages: pages.map((p) => ({ page: Number(p?.page) || 1, chars: Number(p?.chars) || 0, w: Number(p?.w) || 0, h: Number(p?.h) || 0 })),
    paragraphs: clean,
    abstract: String(body?.abstract ?? '').slice(0, 2000),
    sections: Array.isArray(body?.sections)
      ? body.sections.slice(0, 60).map((s) => ({ title: String(s?.title ?? '').slice(0, 160), page: Number(s?.page) || 1 }))
      : [],
    extractedAt: Date.now(),
  }
}
