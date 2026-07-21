/**
 * Regression coverage for routing SLICE-SETTINGS edits through the editor's undo history.
 *
 * The printer target lives in the host slice dialog rather than the editor's scene state, so
 * for a long time changing the printer/model could not be undone at all — it never reached the
 * history. These tests pin the wiring that fixes that: the wrapped controller records a
 * checkpoint before the edit, one per user gesture, and undo hands the pre-edit snapshot back
 * to the controller's `restoreConfig`.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'

installJsdomGlobals()

const { renderHook, act } = await import('@testing-library/react')
const { useEditorHistory } = await import('./useEditorHistory')
type SliceConfigSnapshot = import('../../components/library/SliceSettingsPanel').SliceConfigSnapshot
type SliceSettingsController = import('../../components/library/SliceSettingsPanel').SliceSettingsController

/** The fields these tests exercise; the rest of the snapshot is filled with inert defaults. */
interface FakeConfig {
  printerId: string
  targetMode: 'realPrinter' | 'manualProfile'
  manualPrinterModel: string
  nozzleDiameter: string
}

/**
 * A stand-in for `SliceFileModal`'s slice controller: it owns the config as plain mutable state
 * and exposes the same snapshot/restore/action surface the real one does. Only the members the
 * history hook touches are implemented — the rest of the (large) controller interface is inert.
 */
function makeController(initial: FakeConfig) {
  let config: FakeConfig = { ...initial }
  const restores: SliceConfigSnapshot[] = []
  const build = (): SliceSettingsController => ({
    configSnapshot: {
      selectedSlicerTargetId: 'slicer-1',
      targetMode: config.targetMode,
      printerId: config.printerId,
      printerProfileId: 'machine-1',
      manualPrinterModel: config.manualPrinterModel,
      manualPrinterModelTouched: false,
      nozzleDiameter: config.nozzleDiameter,
      nozzleFlow: 'standard',
      plateType: 'textured_plate',
      plateTypeTouched: false,
      removedFilamentIds: [],
      profileEditedFilamentIds: [],
      addedFilaments: [],
      addedFilamentSourceIndex: {},
      filamentColors: {},
      filamentMaterialOptionIds: {},
      filamentToolheadIds: {},
      filamentMaterialTypeFilters: {},
      filamentSettingOverridesById: {},
      objectProcessOverrides: {},
      processProfileId: 'process-1',
      processProfileSelectionTouched: false,
      processSettingOverrides: {}
    },
    restoreConfig: (snapshot: SliceConfigSnapshot) => {
      restores.push(snapshot)
      config = {
        printerId: snapshot.printerId,
        targetMode: snapshot.targetMode,
        manualPrinterModel: snapshot.manualPrinterModel,
        nozzleDiameter: snapshot.nozzleDiameter
      }
    },
    selectPrinter: (printer: { id: string } | null) => {
      config = { ...config, printerId: printer?.id ?? '', targetMode: printer ? 'realPrinter' : 'manualProfile' }
    },
    selectPrinterModel: (model: string) => { config = { ...config, manualPrinterModel: model } },
    setNozzleDiameter: (value: string) => { config = { ...config, nozzleDiameter: value } },
    retargetTarget: null,
    materialEditListenerRef: { current: null },
    processEditListenerRef: { current: null }
  } as unknown as SliceSettingsController)
  return { build, restores, read: () => config }
}

function renderHistory(controller: ReturnType<typeof makeController>) {
  const noop = () => {}
  const view = renderHook(
    (props: { sliceConfig: SliceSettingsController }) => useEditorHistory({
      stateRef: { current: null },
      setState: noop,
      setSelectedKey: noop,
      setActivePlateIndex: noop,
      setRebuildToken: noop,
      sliceConfig: props.sliceConfig,
      usedFilamentIds: new Set<number>(),
      supportOnlyFilamentIds: new Set<number>()
    }),
    { initialProps: { sliceConfig: controller.build() } }
  )
  // The hook reads the snapshot off the LATEST render, so re-render with a freshly built
  // controller after every edit — exactly what SliceFileModal's state updates do in the app.
  const refresh = () => act(() => { view.rerender({ sliceConfig: controller.build() }) })
  return { ...view, refresh }
}

const START: FakeConfig = { printerId: 'printer-a', targetMode: 'realPrinter', manualPrinterModel: 'C11', nozzleDiameter: '0.4' }

test('choosing a different printer is undoable and restores the previous target', () => {
  const controller = makeController(START)
  const { result, refresh } = renderHistory(controller)
  assert.equal(result.current.canUndo, false)

  act(() => { result.current.sliceConfigForPanel!.selectPrinter({ id: 'printer-b' } as never) })
  refresh()
  assert.equal(result.current.canUndo, true, 'a printer pick must record a checkpoint')
  assert.equal(result.current.hasUnsavedChanges, true)
  assert.equal(controller.read().printerId, 'printer-b')

  act(() => { result.current.undo() })
  assert.equal(controller.read().printerId, 'printer-a', 'undo must put the previous printer back')
  assert.equal(result.current.hasUnsavedChanges, false, 'fully undone reads clean again')
})

test('changing the printer model is undoable and redoable', () => {
  const controller = makeController({ ...START, targetMode: 'manualProfile' })
  const { result, refresh } = renderHistory(controller)

  act(() => { result.current.sliceConfigForPanel!.selectPrinterModel('C13') })
  refresh()
  assert.equal(controller.read().manualPrinterModel, 'C13')

  act(() => { result.current.undo() })
  refresh()
  assert.equal(controller.read().manualPrinterModel, 'C11')
  assert.equal(result.current.canRedo, true)

  act(() => { result.current.redo() })
  assert.equal(controller.read().manualPrinterModel, 'C13', 'redo must reapply the model change')
})

test('one printer pick costs exactly one undo, not one per underlying setter', () => {
  // `selectPrinter` sets both the printer id and the target mode. It is a single controller
  // action precisely so it stays a single history frame — wrapping the two setters separately
  // would make the user press Ctrl+Z twice to reverse one pick.
  const controller = makeController({ ...START, targetMode: 'manualProfile', printerId: '' })
  const { result, refresh } = renderHistory(controller)

  act(() => { result.current.sliceConfigForPanel!.selectPrinter({ id: 'printer-b' } as never) })
  refresh()
  assert.equal(controller.read().targetMode, 'realPrinter')

  act(() => { result.current.undo() })
  assert.equal(result.current.canUndo, false, 'one gesture must leave exactly one frame')
  assert.equal(controller.read().targetMode, 'manualProfile', 'the mode reverts with the id')
  assert.equal(controller.read().printerId, '')
})

test('successive settings edits undo one at a time, newest first', () => {
  const controller = makeController(START)
  const { result, refresh } = renderHistory(controller)

  act(() => { result.current.sliceConfigForPanel!.selectPrinter({ id: 'printer-b' } as never) })
  refresh()
  act(() => { result.current.sliceConfigForPanel!.setNozzleDiameter('0.6') })
  refresh()

  act(() => { result.current.undo() })
  refresh()
  assert.equal(controller.read().nozzleDiameter, '0.4', 'the nozzle edit undoes first')
  assert.equal(controller.read().printerId, 'printer-b', 'the earlier printer pick still stands')

  act(() => { result.current.undo() })
  assert.equal(controller.read().printerId, 'printer-a')
})

test('a saved project is clean, and undoing a saved settings edit is dirty again', () => {
  const controller = makeController(START)
  const { result, refresh } = renderHistory(controller)

  act(() => { result.current.sliceConfigForPanel!.selectPrinter({ id: 'printer-b' } as never) })
  refresh()
  act(() => { result.current.markSaved() })
  assert.equal(result.current.hasUnsavedChanges, false)

  act(() => { result.current.undo() })
  assert.equal(result.current.hasUnsavedChanges, true, 'reverting a saved edit is unsaved work')
})
