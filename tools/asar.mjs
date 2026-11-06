// Minimal Electron ASAR reader: list / extract files from an .asar archive.
// Usage:
//   node asar.mjs list <asar> [prefix]
//   node asar.mjs sizes <asar> [prefix]
//   node asar.mjs extract <asar> <dest> [prefix]
import fs from 'node:fs';
import path from 'node:path';

function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  const sizeBuf = Buffer.alloc(16);
  fs.readSync(fd, sizeBuf, 0, 16, 0);
  const headerSize = sizeBuf.readUInt32LE(4);
  const strLen = sizeBuf.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(strLen);
  fs.readSync(fd, jsonBuf, 0, strLen, 16);
  fs.closeSync(fd);
  const header = JSON.parse(jsonBuf.toString('utf8'));
  const baseOffset = 8 + headerSize;
  return { header, baseOffset };
}

function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name;
    if (entry.files) walk(entry, p, out);
    else out.push({ path: p, size: entry.size || 0, offset: entry.offset, unpacked: entry.unpacked });
  }
}

const [, , cmd, asar, a, b] = process.argv;
const { header, baseOffset } = readHeader(asar);
const files = [];
walk(header, '', files);

if (cmd === 'list') {
  const prefix = a || '';
  for (const f of files) if (f.path.startsWith(prefix)) console.log(f.size + '\t' + f.path);
} else if (cmd === 'sizes') {
  const prefix = a || '';
  const agg = new Map();
  for (const f of files) {
    if (!f.path.startsWith(prefix)) continue;
    const key = f.path.split('/').slice(0, prefix ? prefix.split('/').length + 1 : 2).join('/');
    agg.set(key, (agg.get(key) || 0) + f.size);
  }
  for (const [k, v] of [...agg].sort((x, y) => y[1] - x[1])) console.log((v / 1e6).toFixed(2) + 'MB\t' + k);
} else if (cmd === 'extract') {
  const prefix = b || '';
  const fd = fs.openSync(asar, 'r');
  let n = 0;
  for (const f of files) {
    if (!f.path.startsWith(prefix)) continue;
    if (f.unpacked) continue;
    const dest = path.join(a, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const buf = Buffer.alloc(f.size);
    fs.readSync(fd, buf, 0, f.size, baseOffset + Number(f.offset));
    fs.writeFileSync(dest, buf);
    n++;
  }
  fs.closeSync(fd);
  console.log('extracted', n);
}
