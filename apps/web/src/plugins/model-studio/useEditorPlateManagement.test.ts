import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { SetStateAction } from 'react'
import type { TextPromptDialogOptions } from '../../components/PromptDialogProvider'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import { buildSceneEdit, INHERITED_PLATE_SETTINGS, seedEmptyEditorState, type EditorPlate, type EditorState } from './lib/editorModel'
import { shouldShowEditorPrimeTower } from './lib/editorPrimeTowerHeight'
import { moveEditorPrimeTower } from './lib/primeTowerReach'

const dom = installJsdomGlobals()
const { cleanup, renderHook } = await import('@testing-library/react')
const { useEditorPlateManagement } = await import('./useEditorPlateManagement')

afterEach(cleanup)
after(() => dom.window.close())

function fixture() {
  const stateRef = { current: seedEmptyEditorState() as EditorState | null }
  const edits: Array<'structure' | 'transform' | 'inert' | undefined> = []
  let activeIndex = 1
  let selectedKey: string | null = 'instance-1'
  let settingsId: number | null = 1
  let promptAnswer: string | null = null
  let promptOptions: TextPromptDialogOptions | null = null
  const { result } = renderHook(() => useEditorPlateManagement({
    stateRef,
    updatePlates: (updater, kind) => {
      edits.push(kind)
      const current = stateRef.current!
      stateRef.current = { ...current, plates: updater(current.plates) }
    },
    setActivePlateIndex: (next: SetStateAction<number>) => {
      activeIndex = typeof next === 'function' ? next(activeIndex) : next
    },
    setSelectedKey: (next: SetStateAction<string | null>) => {
      selectedKey = typeof next === 'function' ? next(selectedKey) : next
    },
    setPlateSettingsId: (next: SetStateAction<number | null>) => {
      settingsId = typeof next === 'function' ? next(settingsId) : next
    },
    promptText: async (options) => {
      promptOptions = options
      return promptAnswer
    }
  }))
  return {
    stateRef,
    edits,
    result,
    get activeIndex() { return activeIndex },
    get selectedKey() { return selectedKey },
    get settingsId() { return settingsId },
    get promptOptions() { return promptOptions },
    answer(value: string | null) { promptAnswer = value }
  }
}

/** Match a two-material project whose first plate already has a positioned tower. */
function enableTower(plate: EditorPlate): void {
  plate.bed = { minX: 0, maxX: 350, minY: 0, maxY: 320, maxZ: 325, excludeAreas: [] }
  plate.primeTower = {
    x: 50, y: 283, width: 60,
    sizing: { wipeVolume: 30, layerHeight: 0.16, infillGap: 1.5, ribWall: true, ribWidth: 8,
      extraRibLength: 0, extruderCount: 2, needWipeTower: false, spiralMode: false }
  }
}

test('an added plate exposes its purge tower before save and authors independent slice coordinates', () => {
  const editor = fixture()
  const first = editor.stateRef.current!.plates[0]!
  enableTower(first)
  editor.result.current.handleAddPlate()
  const state = editor.stateRef.current!
  const second = state.plates[1]!
  assert.equal(shouldShowEditorPrimeTower(second.primeTower, 2), true)
  assert.deepEqual(second.primeTower, first.primeTower)
  assert.notEqual(second.primeTower, first.primeTower)
  assert.notEqual(second.primeTower!.sizing, first.primeTower!.sizing)

  const moved = moveEditorPrimeTower(second, { x: 260, y: 20 }, { width: 30, depth: 30 })
  const edit = buildSceneEdit({ ...state, plates: [first, moved] })
  assert.deepEqual(edit.plates.map((plate) => plate.primeTower), [{ x: 50, y: 283 }, { x: 260, y: 20 }])
  assert.equal(first.primeTower!.x, 50, 'moving plate 2 must not move plate 1')
})

test('a pending last scene does not hide a tower already known elsewhere in the project', () => {
  const editor = fixture()
  const state = editor.stateRef.current!
  enableTower(state.plates[0]!)
  state.plates.push({ ...state.plates[0]!, index: 2, plateId: 200, primeTower: null, sourcePlateIndex: 2 })
  editor.result.current.handleAddPlate()
  assert.equal(shouldShowEditorPrimeTower(editor.stateRef.current!.plates[2]!.primeTower, 2), true)
})

test('adding a plate does not enable a disabled project tower', () => {
  const editor = fixture()
  editor.result.current.handleAddPlate()
  assert.equal(editor.stateRef.current!.plates[1]!.primeTower, null)
})

test('new plates inherit the bed but not plate overrides; removal keeps focus on a remaining plate', () => {
  const editor = fixture()
  const first = editor.stateRef.current!.plates[0]!
  first.bed.maxX = 300
  first.plateTypeOverride = 'textured'
  first.locked = true

  editor.result.current.handleAddPlate()
  const second = editor.stateRef.current!.plates[1]!
  assert.equal(second.index, 2)
  assert.notEqual(second.plateId, first.plateId)
  assert.equal(second.bed.maxX, 300)
  assert.equal(second.plateTypeOverride, null)
  assert.equal(second.locked, false)
  assert.equal(editor.activeIndex, 2)
  assert.equal(editor.selectedKey, null)

  editor.result.current.handleAddPlate()
  const thirdId = editor.stateRef.current!.plates[2]!.plateId
  editor.result.current.handleRemovePlate(2)
  assert.deepEqual(editor.stateRef.current!.plates.map((plate: EditorPlate) => plate.plateId), [first.plateId, thirdId])
  assert.equal(editor.activeIndex, 2)
  assert.equal(editor.stateRef.current!.plates[1]!.index, 2)
})

test('rename and settings are inert; no-op reorder never records history', async () => {
  const editor = fixture()
  editor.result.current.handleAddPlate()
  const firstId = editor.stateRef.current!.plates[0]!.plateId
  const secondId = editor.stateRef.current!.plates[1]!.plateId
  editor.edits.length = 0

  editor.answer('Plate 1')
  await editor.result.current.handleRenamePlate(1)
  assert.equal(editor.promptOptions?.initialValue, 'Plate 1')
  assert.deepEqual(editor.edits, [])

  editor.answer('  Sample plate  ')
  await editor.result.current.handleRenamePlate(1)
  assert.equal(editor.stateRef.current!.plates[0]!.name, 'Sample plate')
  assert.deepEqual(editor.edits, ['inert'])

  editor.result.current.handleApplyPlateSettings(secondId, {
    ...INHERITED_PLATE_SETTINGS,
    plateTypeOverride: 'smooth'
  })
  assert.equal(editor.stateRef.current!.plates[1]!.plateTypeOverride, 'smooth')
  assert.equal(editor.settingsId, null)
  assert.deepEqual(editor.edits, ['inert', 'inert'])

  editor.result.current.handleReorderPlate(1, 0)
  assert.equal(editor.edits.length, 2)
  editor.result.current.handleReorderPlate(1, 2)
  assert.deepEqual(editor.stateRef.current!.plates.map((plate: EditorPlate) => plate.plateId), [secondId, firstId])
  assert.equal(editor.activeIndex, 2)
  assert.equal(editor.edits.length, 3)
})
