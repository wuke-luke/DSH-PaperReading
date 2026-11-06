// Paper Studio — one thin model gateway.
//
// Two routes, tried in this order:
//   1. the host's own `llm` service (ctx.llm): the account the user already
//      signed into DSH with — no API key to paste, no extra billing setup;
//   2. an OpenAI-compatible endpoint configured in the app when the user wants
//      a different model (GLM / Kimi / a self-hosted gateway).
//
// Everything the rest of the plugin does — translation, paper chat, diagram
// specs, suggested questions — goes through `streamText`, so a provider can be
// swapped in exactly one place.

const DEFAULT_SELECTION = { provider: 'deepseek-official', model: 'deepseek-flash' }

let cachedSelection = null

function pickId(item) {
  if (typeof item === 'string') return item
  if (!item || typeof item !== 'object') return null
  return item.id ?? item.model ?? item.name ?? item.provider ?? null
}

/** Resolve which provider/model to talk to, remembering the winner. */
/** Cordis throws when reading an undeclared service, so ask defensively. */
function hostLlm(ctx) {
  try {
    return ctx?.llm ?? null
  } catch {
    return null
  }
}

export async function resolveSelection(ctx, config = {}) {
  const wanted = config?.llm ?? {}
  // An explicit provider/model always wins over a cached auto-detection: the
  // user picked it, or the model changed and the cache is stale.
  if (wanted.provider && wanted.model && wanted.mode !== 'http') {
    cachedSelection = { provider: wanted.provider, model: wanted.model, via: 'host' }
    return cachedSelection
  }
  if (cachedSelection) return cachedSelection
  const llm = hostLlm(ctx)
  if (llm && wanted.mode !== 'http') {
    try {
      const providers = (llm.listProviders?.() ?? []).map(pickId).filter(Boolean)
      for (const provider of providers) {
        try {
          const models = (await llm.listModels?.(provider)) ?? []
          const model = models.map(pickId).filter(Boolean)[0]
          if (model) {
            cachedSelection = { provider, model, via: 'host' }
            return cachedSelection
          }
        } catch { /* try the next provider */ }
      }
      if (providers.length) {
        cachedSelection = { provider: providers[0], model: DEFAULT_SELECTION.model, via: 'host' }
        return cachedSelection
      }
    } catch { /* fall through to the HTTP route */ }
  }
  const direct = httpConfig(config)
  if (direct) {
    cachedSelection = { provider: 'custom-http', model: direct.model, via: 'http' }
    return cachedSelection
  }
  cachedSelection = { ...DEFAULT_SELECTION, via: 'host' }
  return cachedSelection
}

/** Direct OpenAI-compatible endpoint, including a key from the environment. */
export function httpConfig(config) {
  const http = config?.http || {}
  const apiKey = http.apiKey || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || ''
  if (!apiKey) return null
  return {
    baseUrl: http.baseUrl || 'https://api.deepseek.com/v1',
    model: http.model || 'deepseek-chat',
    apiKey,
  }
}

/** Turn low-level failures into something a reader can act on. */
export function explainModelError(message) {
  const text = String(message || '')
  if (/without inject|inactive context|not available/i.test(text)) {
    return new Error('DSH 的模型服务在这个版本里不可用。打开「设置 → 模型来源」，选「API Key 直连」并填入 Key 即可，不需要重启。')
  }
  return new Error(text || '模型调用失败')
}

/** Every model this installation can actually call, for the chat picker. */
export async function listAvailableModels(ctx, config) {
  const items = []
  const llm = hostLlm(ctx)
  if (llm) {
    let providers = []
    try { providers = (llm.listProviders?.() ?? []).map(pickId).filter(Boolean) } catch { providers = [] }
    for (const provider of providers) {
      try {
        const models = (await llm.listModels?.(provider)) ?? []
        for (const model of models.map(pickId).filter(Boolean)) {
          items.push({ provider, model, via: 'host', label: provider + ' / ' + model })
        }
      } catch { /* provider without a catalogue */ }
    }
    if (!items.length && providers.length) {
      items.push({ provider: providers[0], model: DEFAULT_SELECTION.model, via: 'host', label: providers[0] + ' / ' + DEFAULT_SELECTION.model })
    }
  }
  const direct = httpConfig(config)
  if (direct) {
    items.push({ provider: 'custom-http', model: direct.model, via: 'http', label: '直连 / ' + direct.model })
  }
  return items
}

export function resetSelection() {
  cachedSelection = null
}

function normalizeMessages(system, messages) {
  const out = []
  if (system) out.push({ role: 'system', content: [{ type: 'text', text: String(system) }] })
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user'
    const content = typeof m.content === 'string'
      ? [{ type: 'text', text: m.content }]
      : Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }]
    out.push({ role, content })
  }
  return out
}

async function* streamHost(ctx, selection, { system, messages, maxTokens, signal }) {
  const options = {
    provider: selection.provider,
    model: selection.model,
    messages: normalizeMessages(system, messages),
  }
  if (Number.isFinite(maxTokens) && maxTokens > 0) options.maxTokens = maxTokens
  if (signal) options.signal = signal
  const stream = ctx.llm.stream(options)
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text) {
      yield chunk.text
    } else if (chunk.type === 'error' || chunk.type === 'failure') {
      throw new Error(chunk.message || chunk.error?.message || '模型调用失败')
    }
  }
}

async function* streamHttp(http, { system, messages, maxTokens, signal }) {
  const base = String(http.baseUrl).replace(/\/+$/, '')
  const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`
  const body = {
    model: http.model,
    messages: normalizeMessages(system, messages).map((m) => ({
      role: m.role,
      content: m.content.map((c) => c.text ?? '').join(''),
    })),
    stream: true,
  }
  if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${http.apiKey || ''}`,
    },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    throw new Error(`模型端点返回 ${res.status}：${detail.slice(0, 300)}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') return
      try {
        const parsed = JSON.parse(payload)
        const delta = parsed.choices?.[0]?.delta?.content
        const classic = parsed.choices?.[0]?.text
        if (typeof delta === 'string' && delta) yield delta
        else if (typeof classic === 'string' && classic) yield classic
      } catch { /* keep-alive or partial frame */ }
    }
  }
}

/**
 * Stream plain text from the configured model.
 * @returns async generator of string deltas
 */
let usageReporter = null

/** index.js installs a sink so every call can be billed to its paper. */
export function setUsageReporter(fn) { usageReporter = typeof fn === 'function' ? fn : null }

function reportUsage(request, config, promptText, completionText, exactUsage) {
  if (!usageReporter) return
  const meta = request?.usage || config?.usage || {}
  try {
    usageReporter({
      paperId: meta.paperId || null,
      kind: meta.kind || "other",
      promptText,
      completionText,
      exactUsage: exactUsage || null,
    })
  } catch { /* never break a reply over bookkeeping */ }
}

async function* streamRaw(ctx, config, request, override = null) {
  const mode = config?.llm?.mode || 'auto'
  const direct = httpConfig(config)
  const llm = hostLlm(ctx)

  if (override?.via === 'http') {
    const directConfig = {
      baseUrl: direct?.baseUrl || 'https://api.deepseek.com/v1',
      apiKey: direct?.apiKey,
      model: override.model,
    }
    if (!directConfig.apiKey) throw explainModelError('还没有配置直连 API Key')
    yield* streamHttp(directConfig, request)
    return
  }

  if (mode !== 'http' && llm) {
    const selection = override ?? await resolveSelection(ctx, config)
    let produced = false
    try {
      for await (const delta of streamHost(ctx, selection, request)) {
        produced = true
        yield delta
      }
      return
    } catch (err) {
      // Nothing streamed yet: a direct endpoint may still save the request.
      if (mode === 'host' || produced || !direct) throw explainModelError(err?.message || err)
    }
  }

  if (direct) {
    yield* streamHttp(direct, request)
    return
  }
  throw explainModelError(
    'DSH 的模型服务不可用，而且还没有配置 API Key。打开「设置 → 模型来源 → API Key 直连」，填一个 DeepSeek（或任意 OpenAI 兼容）Key。',
  )
}

/** Public gateway: identical stream, plus per-call token accounting. */
export async function* streamText(ctx, config, request, override = null) {
  const promptText = String(request?.system || '') + '\n'
    + (request?.messages || []).map((m) => String(m.content || '')).join('\n')
  let completionText = ''
  try {
    for await (const delta of streamRaw(ctx, config, request, override)) {
      completionText += delta
      yield delta
    }
  } finally {
    reportUsage(request, config, promptText, completionText, null)
  }
}

/** Collect a full completion (non-streaming callers). */
export async function complete(ctx, config, request) {
  let out = ''
  for await (const delta of streamText(ctx, config, request)) out += delta
  return out.trim()
}

/** Collect a completion that should be JSON, tolerating fenced code blocks. */
export async function completeJson(ctx, config, request) {
  const raw = await complete(ctx, config, request)
  return parseJsonLoose(raw)
}

export function parseJsonLoose(raw) {
  const text = String(raw ?? '').trim()
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = [fenced?.[1], text]
  for (const candidate of candidates) {
    if (!candidate) continue
    const start = candidate.search(/[[{]/)
    if (start < 0) continue
    const slice = candidate.slice(start)
    for (let end = slice.length; end > 0; end--) {
      const ch = slice[end - 1]
      if (ch !== '}' && ch !== ']') continue
      try {
        return JSON.parse(slice.slice(0, end))
      } catch { /* shrink */ }
    }
  }
  throw new Error('模型没有返回可解析的 JSON')
}
