import assert from 'node:assert/strict'
import test from 'node:test'
import { readEditorSvgSource } from './editorSvgSourceRead'
import { seedEmptyEditorState } from './editorModel'

test('an unsaved SVG reopens from session bytes without reading the archive', async () => {
  let archiveReads = 0
  const state = seedEmptyEditorState()
  state.svgSources = { '3D/art.svg': '<svg>session</svg>' }
  const markup = await readEditorSvgSource('3D/art.svg', state, async () => {
    archiveReads += 1
    throw new Error('missing')
  })
  assert.equal(markup, '<svg>session</svg>')
  assert.equal(archiveReads, 0)
})

test('a saved SVG reopens from the archive and names a missing artwork entry', async () => {
  const markup = await readEditorSvgSource('3D/saved.svg', null, async () =>
    new TextEncoder().encode('<svg>archive</svg>'))
  assert.equal(markup, '<svg>archive</svg>')
  await assert.rejects(
    readEditorSvgSource('3D/missing.svg', null, async () => { throw new Error('missing mesh') }),
    /The artwork 3D\/missing.svg is not in this project any more/
  )
})
