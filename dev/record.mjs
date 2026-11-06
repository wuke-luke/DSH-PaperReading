// Record the DeepPaperReading intro video: logo animation -> guided tour -> end card.
//
// Usage: node dev/record.mjs <appUrl> <out.mp4>
//
// Three scenes are captured frame by frame over CDP and stitched into one MP4:
//   1. dev/intro.html   — the whale+book mark draws itself, wordmark rises
//   2. the real panel   — scripted tour with a caption bar injected into the page
//   3. intro.html?end   — closing card

import { spawn, execFile } from 'node:child_process'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import WebSocket from 'file:///C:/Users/wuke/.dsh/profiles/desktop/node_modules/ws/index.js'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const FFMPEG = 'D:\\APPS\\anaconda\\Library\\bin\\ffmpeg.exe'
const [, , appUrl, out] = process.argv
if (!appUrl || !out) {
  console.error('usage: node dev/record.mjs <appUrl> <out.mp4>')
  process.exit(1)
}

const width = 1600
const height = 900
const fps = 8
const frameDir = resolve('.devdata', 'frames')
const introUrl = pathToFileURL(resolve('dev', 'intro.html')).href
const port = 9800 + Math.floor(Math.random() * 100)

await rm(frameDir, { recursive: true, force: true })
await mkdir(frameDir, { recursive: true })

const browser = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--allow-file-access-from-files',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${process.env.TEMP}\\ps-rec-${port}`,
  `--window-size=${width},${height}`,
  'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => delay(ms)

async function targetUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch { /* booting */ }
    await sleep(250)
  }
  throw new Error('no page target')
}

const ws = new WebSocket(await targetUrl())
await new Promise((r) => ws.on('open', r))
let seq = 1
const pending = new Map()
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  if (msg.id && pending.has(msg.id)) {
    const { resolve: ok, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(msg.error.message)) : ok(msg.result)
  }
})
const send = (method, params = {}) => new Promise((ok, reject) => {
  const id = seq++
  pending.set(id, { resolve: ok, reject })
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })

const rawDir = resolve('.devdata', 'frames-raw')
await rm(rawDir, { recursive: true, force: true })
await mkdir(rawDir, { recursive: true })

let rawNo = 0
const timeline = []
async function grab(atMs) {
  const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 86 })
  const file = join(rawDir, `raw-${String(rawNo).padStart(5, '0')}.jpg`)
  await writeFile(file, Buffer.from(shot.data, 'base64'))
  timeline.push({ file, at: atMs })
  rawNo += 1
}

/** Capture for a wall-clock span; the encoder will stretch frames to match. */
async function capture(ms) {
  const started = Date.now()
  const until = started + ms
  while (Date.now() < until) {
    await grab(Date.now() - started)
    await sleep(60)
  }
}

/* ── scene 1: logo animation, one frozen frame every 1/8 s ───────────── */
const introFrames = []
for (let t = 0; t <= 4.4 + 0.001; t += 1 / fps) {
  await send('Page.navigate', { url: introUrl + '?t=' + t.toFixed(3) })
  await sleep(120)
  const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 86 })
  const file = join(rawDir, `raw-${String(rawNo).padStart(5, '0')}.jpg`)
  await writeFile(file, Buffer.from(shot.data, 'base64'))
  introFrames.push({ file, at: Math.round(t * 1000) })
  rawNo += 1
}
timeline.push(...introFrames)
const introEnd = Math.round(4.4 * 1000)

/* ── scene 2: guided tour ────────────────────────────────────────────── */
await send('Page.navigate', { url: appUrl })
await sleep(1200)

const tour = String.raw`(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const until = async (fn, ms = 20000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await wait(120) }
    return null
  }
  const cap = document.createElement('div')
  cap.id = '__cap'
  cap.style.cssText = [
    'position:fixed', 'left:50%', 'bottom:26px', 'transform:translateX(-50%)',
    'z-index:99999', 'background:rgba(20,18,15,.84)', 'color:#f4efe4',
    'font:14.5px/1.4 "PingFang SC","Microsoft YaHei",system-ui,sans-serif',
    'padding:9px 20px', 'border-radius:999px', 'letter-spacing:.06em',
    'box-shadow:0 10px 30px rgba(0,0,0,.28)', 'opacity:0', 'transition:opacity .28s ease',
    'pointer-events:none', 'white-space:nowrap',
  ].join(';')
  document.body.appendChild(cap)
  const say = (text) => {
    cap.style.opacity = '0'
    setTimeout(() => { cap.textContent = text; cap.style.opacity = '1' }, 140)
  }
  const clear = () => { cap.style.opacity = '0' }

  await until(() => document.querySelector('.paper-card'))
  await wait(700)

  say('文献库：导入 · 专题 · 删除')
  await wait(2600)

  const cards = [...document.querySelectorAll('.paper-card')]
  const paper = cards.find((c) => /From Existing Methods/.test(c.textContent)) || cards[0]
  paper.click()
  await until(() => document.querySelector('.pdf-page canvas'))
  await wait(1500)
  say('原版 PDF：缩放、翻页、选字')
  await wait(2400)

  document.querySelector('#mode-switch [data-mode="dual"]')?.click()
  await wait(2000)
  say('全文对照：左边中文页，右边原版页')
  await wait(1500)
  // Zoom in a little so the pages are readable in a 720p video.
  document.querySelector('[data-zoom="in"]')?.click()
  await wait(600)
  document.querySelector('[data-zoom="in"]')?.click()
  await wait(2200)

  const spans = [...document.querySelectorAll('.textLayer span')].filter((s) => {
    const b = s.getBoundingClientRect()
    return b.width > 60 && b.top > 170 && b.bottom < 620 && b.left > 300 && b.right < 1100 && /[A-Za-z]{4,}/.test(s.textContent)
  })
  if (spans.length > 4) {
    const first = spans[1]
    const r = first.getBoundingClientRect()
    const a = document.caretRangeFromPoint(r.left + 3, r.top + r.height / 2)
    const b = document.caretRangeFromPoint(Math.min(r.right - 3, r.left + r.width * 0.72), r.top + r.height / 2)
    if (a && b) {
      const range = document.createRange()
      range.setStart(a.startContainer, Math.min(a.startOffset, b.startOffset))
      range.setEnd(b.startContainer, Math.max(a.startOffset, b.startOffset))
      const sel = document.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
      first.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 640, clientY: 380 }))
    }
  }
  await wait(900)
  say('划词翻译：选中就在光标旁给出译文')
  await wait(2600)
  document.getSelection()?.removeAllRanges()
  await wait(600)

  document.querySelector('.side-tabs [data-tab="chat"]')?.click()
  await wait(500)
  const input = document.querySelector('#chat-input')
  input.value = '用一句话说清这篇论文做了什么'
  document.querySelector('#chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await wait(1500)
  say('伴读对话：全文概览 + 页码引用')
  await wait(3200)

  document.querySelector('.side-tabs [data-tab="notes"]')?.click()
  await wait(900)
  document.querySelector('.side-tabs [data-tab="figures"]')?.click()
  await wait(700)
  say('笔记与框架图：每篇论文独立保存')
  await wait(2200)

  document.querySelector('.side-tabs [data-tab="discover"]')?.click()
  await wait(1200)
  say('发现：相似论文与每日热点')
  await wait(2400)

  document.querySelector('.side-tabs [data-tab="chat"]')?.click()
  await wait(400)
  document.querySelector('#btn-import')?.click()
  await wait(1200)
  say('导入：arXiv 编号 · 链接 · 本地 PDF')
  await wait(2200)
  document.querySelector('#import-dialog-close')?.click()
  await wait(400)

  document.querySelector('#btn-settings')?.click()
  await wait(1200)
  say('设置：模型来源 · 翻译风格 · 同步目标')
  await wait(2400)
  document.querySelector('#settings-close')?.click()
  await wait(300)
  clear()
  await wait(200)
  window.__tourDone = true
})()`

const tourStart = Date.now()
evaluate(tour).catch(() => {})
let done = false
const deadline = Date.now() + 70000
while (!done && Date.now() < deadline) {
  await grab(introEnd + (Date.now() - tourStart))
  await sleep(60)
  const state = await evaluate('Boolean(window.__tourDone)').catch(() => null)
  done = Boolean(state?.result?.value)
}
const tourEnd = introEnd + (Date.now() - tourStart)
await sleep(300)

/* ── scene 3: end card ───────────────────────────────────────────────── */
await send('Page.navigate', { url: introUrl + '?end=1&t=9' })
await sleep(900)
for (let i = 0; i < 5; i++) {
  await grab(tourEnd + 300 + i * (1000 / fps))
  await sleep(60)
}

try { browser.kill() } catch { /* gone */ }
ws.close()

// Expand the timeline so the video runs in real time even though screenshots
// are slower than the target frame rate.
const seqDir = resolve('.devdata', 'frames')
await rm(seqDir, { recursive: true, force: true })
await mkdir(seqDir, { recursive: true })
let outIndex = 0
for (let i = 0; i < timeline.length; i++) {
  const current = timeline[i]
  const next = timeline[i + 1]
  const gap = Math.max(20, (next ? next.at : current.at + 400) - current.at)
  const copies = Math.max(1, Math.round((gap / 1000) * fps))
  for (let k = 0; k < copies; k++) {
    await copyFile(current.file, join(seqDir, `frame-${String(outIndex).padStart(5, '0')}.jpg`))
    outIndex += 1
  }
}
const frameNo = outIndex
console.log(`captured ${timeline.length} shots -> ${frameNo} frames (${(frameNo / fps).toFixed(1)}s)`)

await new Promise((ok, fail) => {
  execFile(FFMPEG, [
    '-y', '-framerate', String(fps), '-i', join(frameDir, 'frame-%05d.jpg'),
    '-c:v', process.env.FF_ENCODER || 'h264_mf', '-b:v', '3M',
    '-pix_fmt', 'yuv420p', '-vf', `scale=${width}:${height}:flags=lanczos`,
    '-movflags', '+faststart', out,
  ], { maxBuffer: 8 * 1024 * 1024 }, (err, _o, stderr) => {
    if (err) fail(new Error(String(stderr || err.message).slice(-500)))
    else ok()
  })
})
console.log('wrote', out)
