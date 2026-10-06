import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import type { JSDOM } from 'jsdom'
import { installJsdomGlobals } from '../../../test-utils/jsdom'
import type { EditorImportStore } from './editorImportStore'
import type { EditorState } from './editorModel'

let dom: JSDOM
let parseSvgShapes: typeof import('./svgGeometry').parseSvgShapes
let commitEditorSvgArtwork: typeof import('./editorSvgCommit').commitEditorSvgArtwork

before(async () => {
  dom = installJsdomGlobals()
  Object.assign(globalThis, { DOMParser: dom.window.DOMParser })
  parseSvgShapes = (await import('./svgGeometry')).parseSvgShapes
  commitEditorSvgArtwork = (await import('./editorSvgCommit')).commitEditorSvgArtwork
})

after(() => dom.window.close())

test('standalone SVG staging failure leaves the editor scene and history untouched', async () => {
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40">
    <circle cx="20" cy="20" r="12" fill="black"/>
    <circle cx="70" cy="20" r="10" fill="black"/>
  </svg>`
  const state = { plates: [], svgSources: {}, addedParts: {} } as unknown as EditorState
  const stages: string[] = []
  const store = {
    stageFile: async (file: File) => {
      stages.push(file.name)
      if (stages.length === 2) throw new Error('staging failed')
      return { importId: 'body' }
    }
  } as unknown as EditorImportStore
  let checkpoints = 0
  let additions = 0
  const busy: boolean[] = []
  const oldWarn = console.warn
  const warnings: unknown[][] = []
  console.warn = (...args: unknown[]) => { warnings.push(args) }
  try {
    await commitEditorSvgArtwork({
      artwork: parseSvgShapes(markup),
      settings: { widthMm: 40, thickness: 2, operation: 'normal_part', includeBackground: false },
      fileName: 'two-shapes.svg', markup, archiveEntries: [], reedit: null,
      stateRef: { current: state }, activePlateIndex: 1, selectedKey: null,
      groupByKey: new Map(), importStore: store,
      projectFilamentCount: () => 1,
      recordHistory: () => { checkpoints += 1 },
      addInstance: () => { additions += 1; return true },
      publishBakedState: () => {},
      refreshAddedPartMeshes: () => {},
      regenerateThumbnail: () => {},
      closeTool: () => {},
      setImporting: (value) => { busy.push(value) }
    })
  } finally {
    console.warn = oldWarn
  }

  assert.equal(stages.length, 2)
  assert.equal(checkpoints, 0)
  assert.equal(additions, 0)
  assert.deepEqual(state.svgSources, {})
  assert.deepEqual(state.addedParts, {})
  assert.deepEqual(busy, [true, false])
  assert.equal(warnings.length, 1)
})
