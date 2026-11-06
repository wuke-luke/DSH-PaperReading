// Dev tool: extract a PDF into the same text.json shape the browser produces.
// Usage: node dev/extract.mjs <input.pdf> <out.json>
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { extractDocument } from '../web/extract.js'

const PDFJS = 'D:/DESKTOP/DeepPaperReading/web/vendor/pdfjs/pdf.mjs'

const [, , input, output] = process.argv
if (!input || !output) {
  console.error('usage: node dev/extract.mjs <input.pdf> <out.json>')
  process.exit(1)
}

const pdfjs = await import(pathToFileURL(PDFJS).href)
const data = new Uint8Array(await readFile(input))
const doc = await pdfjs.getDocument({
  data,
  standardFontDataUrl: 'D:/DESKTOP/DeepPaperReading/web/vendor/pdfjs/standard_fonts/',
  cMapUrl: 'D:/DESKTOP/DeepPaperReading/web/vendor/pdfjs/cmaps/',
  cMapPacked: true,
  isEvalSupported: false,
  useSystemFonts: true,
}).promise
console.log('pages:', doc.numPages)
const text = await extractDocument(doc, (page, total) => {
  if (page % 5 === 0 || page === total) process.stdout.write(`  parsed ${page}/${total}\r`)
})
console.log('')
try { await doc.destroy?.() } catch { /* pdf.js v6 keeps destroy on the loading task */ }
await writeFile(output, JSON.stringify(text, null, 2), 'utf8')
console.log('paragraphs:', text.paragraphs.length, 'chars:', text.paragraphs.reduce((n, p) => n + p.text.length, 0))
console.log('abstract:', text.abstract.slice(0, 160))
console.log('sections:', text.sections.slice(0, 10).map((s) => s.title).join(' | '))
