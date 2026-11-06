// Model gateway tests: prove that a broken/absent host llm service falls back
// to a directly configured API key, and that the error message is actionable.
//
// Usage: node dev/llm-test.mjs
import http from 'node:http'
import { streamText, resolveSelection, resetSelection } from '../lib/llm.js'

let failures = 0
const ok = (name, extra = '') => console.log(`PASS  ${name}${extra ? '  ' + extra : ''}`)
const bad = (name, detail) => { failures++; console.log(`FAIL  ${name}  ${detail}`) }

// A tiny OpenAI-compatible SSE endpoint.
const server = http.createServer((req, res) => {
  if (!req.url.startsWith('/v1/chat/completions')) { res.writeHead(404).end(); return }
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    if (!String(req.headers.authorization || '').includes('test-key')) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'bad key' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const piece of ['这是', '直连端点', '的回答']) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`)
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const httpConfig = {
  http: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'mock-model' },
  llm: { mode: 'auto' },
}

// A context that traps `llm` exactly like cordis does for undeclared services.
const brokenCtx = {
  get llm() {
    throw new Error('cannot get property "llm" without inject')
  },
}
const emptyCtx = {}

async function collect(ctx, config) {
  let out = ''
  for await (const delta of streamText(ctx, config, {
    system: 'test',
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 32,
  })) out += delta
  return out
}

resetSelection()
try {
  const answer = await collect(brokenCtx, httpConfig)
  answer.includes('直连端点')
    ? ok('falls back to the direct endpoint when the host service throws')
    : bad('fallback output', JSON.stringify(answer))
} catch (err) {
  bad('falls back to the direct endpoint when the host service throws', String(err.message))
}

resetSelection()
try {
  await collect(emptyCtx, { llm: { mode: 'auto' } })
  bad('explains a missing key', 'no error thrown')
} catch (err) {
  /API Key|模型服务/.test(err.message)
    ? ok('explains a missing key', err.message.slice(0, 40) + '…')
    : bad('explains a missing key', err.message)
}

resetSelection()
const selection = await resolveSelection(emptyCtx, httpConfig)
selection.via === 'http' ? ok('selection reports the direct route') : bad('selection reports the direct route', JSON.stringify(selection))

resetSelection()
try {
  await collect(emptyCtx, {
    llm: { mode: 'http' },
    http: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'wrong-key', model: 'mock-model' },
  })
  bad('surfaces an HTTP auth failure', 'no error thrown')
} catch (err) {
  /401|bad key/.test(err.message) ? ok('surfaces an HTTP auth failure', err.message.slice(0, 40)) : bad('surfaces an HTTP auth failure', err.message)
}

server.close()
console.log(failures ? `\n${failures} FAILURES` : '\nmodel gateway OK')
process.exit(failures ? 1 : 0)
