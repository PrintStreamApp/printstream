import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { SvgPartRecord } from '@printstream/shared/three-mf'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import type { EditorProjectSource } from './lib/editorProjectSource'
import type { EditorState } from './lib/editorModel'

const dom = installJsdomGlobals()
;(globalThis as { DOMParser?: typeof DOMParser }).DOMParser = dom.window.DOMParser
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react')
const { useEditorSvgArtwork } = await import('./useEditorSvgArtwork')

afterEach(cleanup)
after(() => dom.window.close())

const markup = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="12" fill="black"/></svg>'
const record: SvgPartRecord = {
  entryPath: '3D/logo.svg', fileName: 'logo.svg', pieceIndex: 0,
  widthMm: 50, thickness: 3, includeBackground: false
}

test('reopen reads unsaved SVG bytes and leaving the tool clears its pending session', async () => {
  const calls: string[] = []
  const source = {
    listEntries: async () => { calls.push('list'); return [] },
    loadEntry: async () => { calls.push('archive'); throw new Error('archive was read') }
  } as unknown as EditorProjectSource
  const state = { plates: [], svgSources: { '3D/logo.svg': markup } } as unknown as EditorState
  const projectSourceRef = { current: source }
  const stateRef = { current: state }
  const busy: boolean[] = []
  const { result, rerender } = renderHook(
    ({ active }) => useEditorSvgArtwork({
      active, projectSourceRef, stateRef,
      setImporting: (value) => { if (typeof value === 'boolean') busy.push(value) }
    }),
    { initialProps: { active: true } }
  )

  await act(async () => { await result.current.reopenArtwork(record, 7, 'normal_part') })
  assert.deepEqual(calls, ['list'])
  assert.deepEqual(busy, [true, false])
  assert.equal(result.current.svgMarkup, markup)
  assert.equal(result.current.svgTool.widthMm, 50)
  assert.equal(result.current.svgTool.thickness, 3)
  assert.equal(result.current.reeditSvgRef.current?.hostId, 7)

  rerender({ active: false })
  await waitFor(() => assert.equal(result.current.svgArtwork, null))
  assert.equal(result.current.svgMarkup, null)
  assert.equal(result.current.reeditSvgRef.current, null)
})

test('a new file with no painted shape leaves a useful error instead of stale artwork', async () => {
  const source = { listEntries: async () => [] } as unknown as EditorProjectSource
  const { result } = renderHook(() => useEditorSvgArtwork({
    active: true,
    projectSourceRef: { current: source },
    stateRef: { current: null },
    setImporting: () => {}
  }))

  await act(async () => {
    await result.current.fileChosen({
      name: 'empty.svg', text: async () => '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'
    } as File)
  })
  assert.equal(result.current.svgArtwork, null)
  assert.match(result.current.svgEmptyReason ?? '', /Nothing in this file is painted/)
  assert.equal(result.current.svgFileName, 'empty.svg')
})
