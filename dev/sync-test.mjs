// Sync engine round-trip across two simulated devices sharing one folder target.
// Usage: node dev/sync-test.mjs
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Store } from '../lib/store.js'
import { SyncEngine } from '../lib/sync/engine.js'

let failures = 0
const ok = (name, extra = '') => console.log(`PASS  ${name}${extra ? '  ' + extra : ''}`)
const bad = (name, detail) => { failures++; console.log(`FAIL  ${name}  ${detail}`) }

const root = await mkdtemp(join(tmpdir(), 'ps-sync-'))
const shared = join(root, 'cloud')
const dirA = join(root, 'device-a')
const dirB = join(root, 'device-b')

async function makeStore(dir) {
  const store = new Store(dir)
  await store.init()
  return store
}

async function addPaper(store, id, title, notes) {
  const dir = store.paperDir(id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'paper.pdf'), Buffer.from('%PDF-1.4 fake pdf bytes'))
  const meta = {
    id, title, authors: ['A. Author'], year: 2026, arxivId: null, folderId: null,
    sizeBytes: 21, pages: 1, paragraphs: 1, indexed: true, progress: 0,
    addedAt: Date.now(), updatedAt: Date.now(),
  }
  await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
  await writeFile(join(dir, 'text.json'), JSON.stringify({ paragraphs: [{ i: 0, page: 1, text: 'hello world' }] }))
  await writeFile(join(dir, 'notes.md'), notes)
  await store.upsertPaper(meta)
  return meta
}

function engine(store, includePdf = true) {
  return new SyncEngine({
    store,
    config: { sync: { kind: 'folder', includePdf, target: { root: shared } } },
    onTokens: () => {},
  })
}

async function drain(gen) {
  const events = []
  for await (const event of gen) events.push(event)
  return events
}

const storeA = await makeStore(dirA)
const storeB = await makeStore(dirB)
await addPaper(storeA, 'p-alpha', 'Alpha Paper', '# alpha notes\nfirst version')

// 1. A uploads
let events = await drain(engine(storeA).run())
let done = events.find((e) => e.type === 'done')
done ? ok('A uploads', `${done.summary.upload} up / ${done.summary.download} down`) : bad('A uploads', JSON.stringify(events.at(-1)))
existsSync(join(shared, 'p-p-alpha__notes.md')) ? ok('cloud has note file') : bad('cloud has note file', shared)
existsSync(join(shared, 'library.json')) ? ok('cloud has library') : bad('cloud has library', 'missing')

// 2. B downloads
events = await drain(engine(storeB).run())
done = events.find((e) => e.type === 'done')
done && done.summary.download > 0 ? ok('B downloads', `${done.summary.download}`) : bad('B downloads', JSON.stringify(events.at(-1)))
const libB = await storeB.library()
libB.papers.length === 1 ? ok('B library merged') : bad('B library merged', `${libB.papers.length}`)
const notesB = await storeB.notes('p-alpha')
notesB.includes('first version') ? ok('B notes content') : bad('B notes content', notesB.slice(0, 40))
await storeB.text('p-alpha') ? ok('B text synced') : bad('B text synced', 'missing')

// 3. B edits notes, A picks it up
await storeB.saveNotes('p-alpha', '# alpha notes\nedited on B')
await drain(engine(storeB).run())
events = await drain(engine(storeA).run())
const notesA = await storeA.notes('p-alpha')
notesA.includes('edited on B') ? ok('A gets B edit') : bad('A gets B edit', notesA.slice(0, 60))

// 4. no-op sync transfers nothing
events = await drain(engine(storeA).run())
done = events.find((e) => e.type === 'done')
done.summary.upload === 0 && done.summary.download === 0 && done.summary.deleted === 0
  ? ok('idempotent second sync')
  : bad('idempotent second sync', JSON.stringify(done.summary))

// 5. conflicting edits preserve the loser
await storeA.saveNotes('p-alpha', '# alpha notes\nedited on A again')
await storeB.saveNotes('p-alpha', '# alpha notes\nedited on B again')
await new Promise((r) => setTimeout(r, 20))
await drain(engine(storeB).run())
await drain(engine(storeA).run())
await drain(engine(storeB).run())
const conflictsA = await engine(storeA).countConflicts()
const conflictsB = await engine(storeB).countConflicts()
conflictsA + conflictsB > 0 ? ok('conflict copy kept', `A=${conflictsA} B=${conflictsB}`) : bad('conflict copy kept', 'no conflict files')

// 6. deletion propagates through the tombstone
await storeA.removePaper('p-alpha')
await drain(engine(storeA).run())
await drain(engine(storeB).run())
const libB2 = await storeB.library()
libB2.papers.length === 0 ? ok('deletion propagates') : bad('deletion propagates', `${libB2.papers.length} papers left`)
libB2.deleted?.['p-alpha'] ? ok('tombstone kept in library') : bad('tombstone kept in library', JSON.stringify(libB2.deleted))
!existsSync(join(shared, 'p-p-alpha__notes.md')) ? ok('cloud files removed') : bad('cloud files removed', 'still there')

// 7. library merge keeps the newest metadata
const storeC = await makeStore(join(root, 'device-c'))
await addPaper(storeA, 'p-beta', 'Beta', 'b')
await drain(engine(storeA).run())
await drain(engine(storeC).run())
const libC = await storeC.library()
libC.papers.some((p) => p.id === 'p-beta') ? ok('new paper reaches third device') : bad('new paper reaches third device', 'missing')

await rm(root, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILURES` : '\nsync engine OK')
process.exit(failures ? 1 : 0)
