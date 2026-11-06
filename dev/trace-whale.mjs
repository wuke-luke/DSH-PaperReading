// Trace the official whale mark into clean line-art contours.
//
// The brand asset is a filled silhouette with internal cutouts, so stroking the
// path directly produces noise. Instead we rasterize it, walk the pixel
// boundary (interior on the right), simplify with Ramer–Douglas–Peucker, and
// emit closed loops in a 0..100 box — a faithful, smooth outline of the logo.
//
// Usage: node dev/trace-whale.mjs
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'file:///C:/Users/wuke/.dsh/profiles/desktop/node_modules/ws/index.js'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const whale = (await readFile('.devdata/fish-path.txt', 'utf8')).trim()

const page = `<!doctype html><html><body><canvas id="c" width="900" height="900"></canvas>
<script>
const D = ${JSON.stringify(whale)};
const W = 900, H = 900, PAD = 40;
const cv = document.getElementById('c');
const ctx = cv.getContext('2d');
ctx.fillStyle = '#000';
ctx.fillRect(0, 0, W, H);
ctx.globalCompositeOperation = 'destination-out';
const sx = (W - PAD * 2) / 23.16;
const sy = (H - PAD * 2) / 17.04;
const s = Math.min(sx, sy);
ctx.save();
ctx.translate((W - 23.16 * s) / 2, (H - 17.04 * s) / 2);
ctx.scale(s, s);
ctx.fill(new Path2D(D));
ctx.restore();

const data = ctx.getImageData(0, 0, W, H).data;
const mask = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) mask[i] = data[i * 4 + 3] < 128 ? 1 : 0; // transparent = whale

// Pixel-boundary edges (interior on the right).
const edges = new Map();
const key = (x, y) => x + ',' + y;
function addEdge(x1, y1, x2, y2) {
  const k = key(x1, y1);
  if (!edges.has(k)) edges.set(k, []);
  edges.get(k).push([x2, y2]);
}
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (!mask[y * W + x]) continue;
    const up = y === 0 || !mask[(y - 1) * W + x];
    const right = x === W - 1 || !mask[y * W + x + 1];
    const down = y === H - 1 || !mask[(y + 1) * W + x];
    const left = x === 0 || !mask[y * W + x - 1];
    if (up) addEdge(x, y, x + 1, y);
    if (right) addEdge(x + 1, y, x + 1, y + 1);
    if (down) addEdge(x + 1, y + 1, x, y + 1);
    if (left) addEdge(x, y + 1, x, y);
  }
}

// Chain edges into closed loops.
const loops = [];
const used = new Set();
for (const [startKey, targets] of edges) {
  for (const target of targets) {
    const edgeId = startKey + '>' + key(target[0], target[1]);
    if (used.has(edgeId)) continue;
    const loop = [];
    let currentKey = startKey;
    let next = target;
    let guard = 0;
    while (guard++ < 200000) {
      const id = currentKey + '>' + key(next[0], next[1]);
      if (used.has(id)) break;
      used.add(id);
      loop.push([Number(currentKey.split(',')[0]), Number(currentKey.split(',')[1])]);
      currentKey = key(next[0], next[1]);
      const candidates = edges.get(currentKey);
      if (!candidates || !candidates.length) break;
      // Prefer an unused edge.
      const pick = candidates.find((c) => !used.has(currentKey + '>' + key(c[0], c[1]))) || candidates[0];
      next = pick;
      if (currentKey === startKey && next === target) break;
    }
    if (loop.length > 12) loops.push(loop);
  }
}

// Ramer–Douglas–Peucker on a closed loop.
function rdp(points, eps) {
  if (points.length < 3) return points;
  const sq = (v) => v * v;
  const perp = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (!len) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
  };
  function simplify(pts) {
    if (pts.length < 3) return pts;
    let max = 0, index = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = perp(pts[i], pts[0], pts[pts.length - 1]);
      if (d > max) { max = d; index = i; }
    }
    if (max > eps) {
      const left = simplify(pts.slice(0, index + 1));
      const right = simplify(pts.slice(index));
      return left.slice(0, -1).concat(right);
    }
    return [pts[0], pts[pts.length - 1]];
  }
  const open = points.concat([points[0]]);
  const simplified = simplify(open);
  simplified.pop();
  void sq;
  return simplified;
}

const out = [];
for (const loop of loops) {
  const simplified = rdp(loop, 1.6);
  if (simplified.length < 4) continue;
  out.push(simplified.map(([x, y]) => [x, y]));
}
window.__traced = JSON.stringify(out);
</script></body></html>`

await writeFile('.devdata/trace.html', page, 'utf8')
const port = 9500 + Math.floor(Math.random() * 200)
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${port}`, `--user-data-dir=${process.env.TEMP}\\ps-trace-${port}`,
  '--window-size=1000,1000', 'file:///D:/DESKTOP/DeepPaperReading/.devdata/trace.html',
], { stdio: 'ignore' })

async function endpoint(pathname) {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${pathname}`)
      if (res.ok) return await res.json()
    } catch { /* not up */ }
    await delay(150)
  }
  throw new Error('devtools not up')
}

let target = null
for (let i = 0; i < 60 && !target; i++) {
  const list = await endpoint('/json/list').catch(() => null)
  target = list?.find?.((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null
  if (!target) await delay(150)
}
const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 })
await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
let id = 1
const pending = new Map()
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
  }
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = id++
  pending.set(mid, { resolve, reject })
  ws.send(JSON.stringify({ id: mid, method, params }))
})

let loops = null
for (let i = 0; i < 40 && !loops; i++) {
  await delay(400)
  const res = await send('Runtime.evaluate', { expression: 'window.__traced || null', returnByValue: true })
  if (res?.result?.value) loops = JSON.parse(res.result.value)
}
ws.close()
child.kill()
if (!loops) throw new Error('trace produced nothing')
await writeFile('.devdata/whale-loops.json', JSON.stringify(loops), 'utf8')
console.log('loops:', loops.length, 'points:', loops.reduce((n, l) => n + l.length, 0))
for (const loop of loops) console.log('  loop', loop.length, 'pts, bbox', JSON.stringify([
  Math.min(...loop.map((p) => p[0])), Math.min(...loop.map((p) => p[1])),
  Math.max(...loop.map((p) => p[0])), Math.max(...loop.map((p) => p[1])),
]))
process.exit(0)
