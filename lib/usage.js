// Token accounting, per paper.
//
// The model gateways we talk to do not always report usage, so we keep two
// numbers: an estimate derived from the characters we sent and received, and
// the provider's own counts when a chunk carries them. The estimate is what the
// UI shows by default; `exact` tells whether the provider confirmed it.

/** Rough token estimate: CJK runs count per character, latin per ~4 chars. */
export function estimateTokens(text) {
  const value = String(text ?? '')
  if (!value) return 0
  const cjk = (value.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length
  const rest = value.length - cjk
  return Math.ceil(cjk * 1.05 + rest / 3.6)
}

export function emptyUsage() {
  return { prompt: 0, completion: 0, calls: 0, exact: false, byKind: {}, updatedAt: 0 }
}

export function addUsage(current, delta, kind = 'other') {
  const base = { ...emptyUsage(), ...(current || {}) }
  const next = {
    ...base,
    prompt: base.prompt + (delta.prompt || 0),
    completion: base.completion + (delta.completion || 0),
    calls: base.calls + 1,
    exact: Boolean(base.exact || delta.exact),
    updatedAt: Date.now(),
    byKind: { ...(base.byKind || {}) },
  }
  const bucket = next.byKind[kind] || { prompt: 0, completion: 0, calls: 0 }
  next.byKind[kind] = {
    prompt: bucket.prompt + (delta.prompt || 0),
    completion: bucket.completion + (delta.completion || 0),
    calls: bucket.calls + 1,
  }
  return next
}

export function usageTotal(usage) {
  if (!usage) return 0
  return (usage.prompt || 0) + (usage.completion || 0)
}

export function formatTokens(n) {
  const value = Number(n) || 0
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(1) + 'M'
  if (value >= 1000) return (value / 1000).toFixed(1) + 'k'
  return String(Math.round(value))
}
