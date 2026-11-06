// Headless screenshot + console capture over the Chrome DevTools Protocol.
// Usage: node dev/shot.mjs <url> <out.png> [waitMs] [width] [height]
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'file:///C:/Users/wuke/.dsh/profiles/desktop/node_modules/ws/index.js'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const [, , url, out, waitArg, widthArg, heightArg] = process.argv
if (!url || !out) {
  console.error('usage: node dev/shot.mjs <url> <out.png> [waitMs] [width] [height]')
  process.exit(1)
}
const waitMs = Number(waitArg || 6000)
const width = Number(widthArg || 1600)
const height = Number(heightArg || 1000)
const port = 9300 + Math.floor(Math.random() * 200)

const child = spawn(EDGE, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${process.env.TEMP}\\ps-shot-${port}`,
  `--window-size=${width},${height}`,
  url,
], { stdio: 'ignore', detached: false })

async function endpoint(pathname) {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${pathname}`)
      if (res.ok) return await res.json()
    } catch { /* not up yet */ }
    await delay(150)
  }
  throw new Error('devtools endpoint never came up')
}

let target = null
for (let i = 0; i < 60 && !target; i++) {
  const list = await endpoint('/json/list').catch(() => null)
  target = list?.find?.((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null
  if (!target) await delay(150)
}
if (!target) throw new Error('no page target')
const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 })
await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })

let nextId = 1
const pending = new Map()
const logs = []
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(msg.error.message))
    else resolve(msg.result)
    return
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    logs.push(`[console.${msg.params.type}] ` + msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '))
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    logs.push('[exception] ' + (d.exception?.description || d.text))
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    logs.push('[log.error] ' + msg.params.entry.text)
  }
})

function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

await send('Page.enable')
await send('Runtime.enable')
await send('Log.enable')
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url })
await delay(waitMs)

const script = process.argv[7] || process.env.PS_SHOT_SCRIPT || ''
if (script) {
  try {
    const result = await send('Runtime.evaluate', { expression: script, awaitPromise: true, returnByValue: true })
    if (result?.result?.value !== undefined) console.log('eval →', JSON.stringify(result.result.value).slice(0, 300))
    if (result?.exceptionDetails) console.log('eval error:', result.exceptionDetails.text)
  } catch (err) {
    console.log('eval failed:', err.message)
  }
  await delay(1200)
}

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
await writeFile(out, Buffer.from(shot.data, 'base64'))

if (logs.length) {
  console.log('--- console ---')
  for (const line of logs.slice(0, 40)) console.log(line)
}
console.log('saved', out)

ws.close()
child.kill()
process.exit(0)
