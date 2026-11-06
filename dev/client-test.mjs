// Contract test for the browser half: run lib/client.js against a fake module
// loader and assert the two slot registrations the DSH shell expects.
import { pathToFileURL } from 'node:url'

const registrations = []
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useRef: (value) => ({ current: value }),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
}

let loadedId = null

globalThis.window = {
  innerHeight: 900,
  addEventListener() {},
  removeEventListener() {},
  __ModuleLoader__: {
    load({ id, factory }) {
      loadedId = id
      const api = factory((name) => {
        if (name === 'react') return fakeReact
        throw new Error(`unexpected require("${name}") — client bundles may only use the platform seed`)
      })
      const ctx = {
        slots: {
          inject(name, cb) { cb(name) },
          register(def, component) {
            registrations.push({ def, component })
            return () => {}
          },
        },
      }
      api.apply(ctx)
      globalThis.__api = api
    },
  },
}
globalThis.document = { addEventListener() {}, querySelector() { return null } }

await import(pathToFileURL('D:/DESKTOP/DeepPaperReading/lib/client.js').href)

const problems = []
if (loadedId !== 'dsh-paper-studio') problems.push(`loader id is ${loadedId}`)
const api = globalThis.__api
if (!Array.isArray(api?.inject) || !api.inject.includes('slots')) problems.push('inject does not declare slots')

const panel = registrations.find((r) => r.def.name === 'sidebar.panellist')
const main = registrations.find((r) => r.def.name === 'main')
if (!panel) problems.push('no sidebar.panellist registration')
if (!main) problems.push('no main registration')
if (panel) {
  if (panel.def.id !== 'paper-studio') problems.push(`panel id is ${panel.def.id}`)
  if (!panel.def.label) problems.push('panel has no label')
  const icon = panel.component({ size: 18, active: true })
  if (icon?.type !== 'svg') problems.push('panel component does not render an svg')
}
if (main) {
  if (main.def.key !== 'paper-studio') problems.push(`main key is ${main.def.key}`)
  const tree = main.component({})
  if (tree?.type !== 'div') problems.push('main panel does not render a wrapper div')
  const frame = tree?.children?.find?.((c) => c?.type === 'iframe')
  if (!frame) problems.push('main panel has no iframe')
  else if (!String(frame.props?.src || '').startsWith('/paper-studio/')) problems.push(`iframe src is ${frame.props?.src}`)
}

if (problems.length) {
  console.error('FAIL')
  for (const p of problems) console.error(' -', p)
  process.exit(1)
}
console.log('PASS  client bundle registers sidebar.panellist + main (key "paper-studio")')
