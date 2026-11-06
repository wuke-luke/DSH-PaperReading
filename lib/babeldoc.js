// BabelDOC bridge — layout-preserving PDF translation.
//
// BabelDOC (funstory-ai/BabelDOC) is the engine behind Immersive Translate's
// PDF mode: it re-typesets the *whole PDF* — formulas, figures and two-column
// layout included — and can emit a bilingual PDF where each translated page
// faces its original. That is a different league from painting text over the
// rendered page, which is what the built-in overlay does.
//
// We treat it as an optional external tool: detect it, run it, serve its output.
// Nothing is downloaded or installed behind the user's back.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const CANDIDATES = () => [
  process.env.BABELDOC_BIN,
  join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'babeldoc.exe' : 'babeldoc'),
  join(homedir(), '.local', 'bin', 'babeldoc'),
  'babeldoc',
].filter(Boolean)

function which(cmd) {
  return new Promise((resolve) => {
    const child = spawn(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('error', () => resolve(null))
    child.on('close', (code) => resolve(code === 0 ? out.split(/\r?\n/).find(Boolean) || cmd : null))
  })
}

export async function resolveBabeldoc() {
  for (const candidate of CANDIDATES()) {
    if (candidate.includes('\\') || candidate.includes('/')) {
      if (existsSync(candidate)) return candidate
      continue
    }
    const found = await which(candidate)
    if (found) return found
  }
  return null
}

export const INSTALL_HINT = process.platform === 'win32'
  ? 'winget install --id astral-sh.uv -e  然后  uv tool install --python 3.12 BabelDOC'
  : 'curl -LsSf https://astral.sh/uv/install.sh | sh  然后  uv tool install --python 3.12 BabelDOC'

/** Where BabelDOC's output for this paper lives. */
export function outputPaths(paperDir) {
  return {
    dir: join(paperDir, 'babeldoc'),
    dual: join(paperDir, 'babeldoc', 'paper.dual.pdf'),
    mono: join(paperDir, 'babeldoc', 'paper.zh.pdf'),
  }
}

export async function babeldocStatus(paperDir) {
  const bin = await resolveBabeldoc()
  const paths = outputPaths(paperDir)
  const has = (file) => existsSync(file)
  return {
    installed: Boolean(bin),
    bin: bin || null,
    hint: INSTALL_HINT,
    dual: has(paths.dual),
    mono: has(paths.mono),
  }
}

/**
 * Translate one PDF and normalise the output names.
 * @returns {AsyncGenerator<{type:string, text?:string, dual?:string, mono?:string}>}
 */
export async function* runBabeldoc({ paperDir, sourcePdf, endpoint, apiKey, model, signal }) {
  const bin = await resolveBabeldoc()
  if (!bin) throw new Error('没有找到 babeldoc，请先安装：' + INSTALL_HINT)
  if (!apiKey) throw new Error('BabelDOC 需要一个 OpenAI 兼容的 API Key（设置 → API Key 直连）')

  const paths = outputPaths(paperDir)
  await rm(paths.dir, { recursive: true, force: true })
  await mkdir(paths.dir, { recursive: true })

  const args = [
    '--openai',
    '--openai-model', model || 'deepseek-chat',
    '--openai-base-url', endpoint || 'https://api.deepseek.com/v1',
    '--openai-api-key', apiKey,
    '--files', sourcePdf,
    '--output-dir', paths.dir,
  ]

  yield { type: 'log', text: '启动 BabelDOC：' + bin }
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } })
  const kill = () => { try { child.kill() } catch { /* already gone */ } }
  signal?.addEventListener?.('abort', kill)

  let buffer = ''
  const onData = (chunk) => { buffer += chunk.toString('utf8') }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)

  let exitCode = null
  const done = new Promise((resolve) => {
    child.on('error', (err) => resolve({ error: err }))
    child.on('close', (code) => resolve({ code }))
  })

  // Stream progress lines while the process runs.
  let closed = false
  done.then(() => { closed = true })
  while (!closed) {
    await new Promise((resolve) => setTimeout(resolve, 400))
    if (!buffer) continue
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ''
    for (const line of lines) {
      const text = line.trim()
      if (!text) continue
      yield { type: 'log', text: text.slice(0, 300) }
    }
  }
  const result = await done
  signal?.removeEventListener?.('abort', kill)
  if (result.error) throw result.error
  exitCode = result.code
  if (exitCode !== 0) throw new Error(`BabelDOC 退出码 ${exitCode}`)

  // BabelDOC names outputs after the input file; normalise to paper.*.pdf.
  const names = await readdir(paths.dir).catch(() => [])
  const pick = (patterns) => names.find((name) => patterns.some((re) => re.test(name)))
  const dualName = pick([/dual/i])
  const monoName = pick([/\.(zh|mono|translated)\.pdf$/i, /zh/i]) || names.find((n) => n.endsWith('.pdf') && n !== dualName)
  if (dualName) await rename(join(paths.dir, dualName), paths.dual)
  if (monoName && monoName !== dualName) await rename(join(paths.dir, monoName), paths.mono)

  const out = {}
  if (existsSync(paths.dual)) out.dual = paths.dual
  if (existsSync(paths.mono)) out.mono = paths.mono
  if (!out.dual && !out.mono) throw new Error('BabelDOC 没有产出 PDF，请看上面的日志')
  const size = out.dual ? (await stat(out.dual)).size : (await stat(out.mono)).size
  yield { type: 'done', ...out, size }
}
