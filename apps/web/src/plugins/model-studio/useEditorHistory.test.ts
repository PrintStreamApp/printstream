/**
 * Regression coverage for routing SLICE-SETTINGS edits through the editor's undo history.
 *
 * The printer target lives in the host slice dialog rather than the editor's scene state, so
 * for a long time changing the printer/model could not be undone at all, it never reached the
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
const { remapBaseMaterialPaint } = await import('./lib/materialReplacement')
type SliceConfigSnapshot = import('../../components/library/SliceSettingsPanel').SliceConfigSnapshot
type SliceSettingsController = import('../../components/library/SliceSettingsPanel').SliceSettingsController

/** The fields these tests exercise; the rest of the snapshot is filled with inert defaults. */
interface FakeConfig {
  printerId: string
  targetMode: 'realPrinter' | 'manualProfile'
  manualPrinterModel: string
  nozzleDiameter: string
  sessionSlots?: SessionFilamentSlot[] | null
}

type SessionFilamentSlot = import('../../components/library/useMaterialSlots').SessionFilamentSlot

/** A session slot: the id it is keyed by, and the base slot its slicer settings clone from. */
const slot = (projectFilamentId: number, sourceIndex: number | null, pickedColor?: string): SessionFilamentSlot =>
  ({ projectFilamentId, sourceIndex, label: `M${projectFilamentId}`, color: null, nozzleId: null, pickedColor })

/** Colours as the panel reads them: derived from the slots, exactly like the real controller. */
const coloursOf = (slots: SessionFilamentSlot[] | null | undefined): Record<number, string> => {
  const out: Record<number, string> = {}
  for (const entry of slots ?? []) if (entry.pickedColor !== undefined) out[entry.projectFilamentId] = entry.pickedColor
  return out
}

/**
 * A stand-in for `SliceFileModal`'s slice controller: it owns the config as plain mutable state
 * and exposes the same snapshot/restore/action surface the real one does. Only the members the
 * history hook touches are implemented: the rest of the (large) controller interface is inert.
 */
function makeController(initial: FakeConfig) {
  let config: FakeConfig = { ...initial }
  // The controller's derived retarget payload; tests set it to simulate the seeds resolving or
  // a target change. Only the signature-relevant essentials are populated.
  let retargetTarget: unknown = null
  const setRetargetTarget = (value: { printerProfileId: string; printerModel: string } | null) => {
    retargetTarget = value
      ? { mode: 'manualProfile', plateType: 'textured_plate', nozzleDiameters: [0.4], processProfileId: 'process-1', ...value }
      : null
  }
  const restores: SliceConfigSnapshot[] = []
  const build = (): SliceSettingsController => ({
    configSnapshot: {
      selectedSlicerTargetId: 'slicer-1',
      // Post-S2 the target contributes only the user's PICKS; the machine profile, option lists,
      // and compatibility all re-derive from them on restore.
      machineTargetIntent: {
        printerId: config.printerId,
        printerModel: config.manualPrinterModel,
        nozzleDiameter: config.nozzleDiameter
      },
      // The slots ARE the material half of the snapshot now.
      sessionSlots: config.sessionSlots ?? null,
      objectProcessOverrides: {},
      processProfileId: 'process-1',
      processProfileSelectionTouched: false,
      processSettingOverrides: {}
    },
    restoreConfig: (snapshot: SliceConfigSnapshot) => {
      restores.push(snapshot)
      config = {
        printerId: snapshot.machineTargetIntent.printerId ?? '',
        targetMode: snapshot.machineTargetIntent.printerId ? 'realPrinter' : 'manualProfile',
        manualPrinterModel: snapshot.machineTargetIntent.printerModel ?? '',
        nozzleDiameter: snapshot.machineTargetIntent.nozzleDiameter ?? '',
        sessionSlots: snapshot.sessionSlots
      }
    },
    selectPrinter: (printer: { id: string } | null) => {
      config = { ...config, printerId: printer?.id ?? '', targetMode: printer ? 'realPrinter' : 'manualProfile' }
    },
    selectPrinterModel: (model: string) => { config = { ...config, manualPrinterModel: model } },
    setNozzleDiameter: (value: string) => { config = { ...config, nozzleDiameter: value } },
    setFilamentColors: (value: Record<number, string>) => {
      // Write-through onto the slots, as the real core does now.
      const next = typeof value === 'function' ? (value as (p: Record<number, string>) => Record<number, string>)(coloursOf(config.sessionSlots)) : value
      config = { ...config, sessionSlots: (config.sessionSlots ?? []).map((entry) => ({ ...entry, pickedColor: next[entry.projectFilamentId] })) }
    },
    retargetTarget,
    materialEditListenerRef: { current: null },
    settingsEditListenerRef: { current: null }
  } as unknown as SliceSettingsController)
  const setSessionSlots = (slots: SessionFilamentSlot[] | null) => { config = { ...config, sessionSlots: slots } }
  return { build, restores, read: () => config, setRetargetTarget, setSessionSlots }
}

function renderHistory(controller: ReturnType<typeof makeController>, options?: { editorBorn?: boolean }) {
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
      supportOnlyFilamentIds: new Set<number>(),
      editorBorn: options?.editorBorn
    }),
    { initialProps: { sliceConfig: controller.build() } }
  )
  // The hook reads the snapshot off the LATEST render, so re-render with a freshly built
  // controller after every edit, exactly what SliceFileModal's state updates do in the app.
  const refresh = () => act(() => { view.rerender({ sliceConfig: controller.build() }) })
  return { ...view, refresh }
}

const START: FakeConfig = { printerId: 'printer-a', targetMode: 'realPrinter', manualPrinterModel: 'C11', nozzleDiameter: '0.4' }

test('choosing a different printer is undoable and restores the previous target', () => {
  const controller = makeController(START)
  const { result, refresh } = renderHistory(controller)
  assert.equal(result.current.canUndo, false)
  const initialRevision = result.current.revision

  act(() => { result.current.sliceConfigForPanel!.selectPrinter({ id: 'printer-b' } as never) })
  refresh()
  assert.equal(result.current.canUndo, true, 'a printer pick must record a checkpoint')
  assert.equal(result.current.hasUnsavedChanges, true)
  assert.ok(result.current.revision > initialRevision, 'slice-result owners must see the input change')
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
  // action precisely so it stays a single history frame: wrapping the two setters separately
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

// The retarget term of hasUnsavedChanges: a resolved target is unsaved work ONLY when it differs
// from the baseline (the seeds that mirror the opened file, or the last save). Before this,
// `retargetTarget != null` alone kept Save lit permanently: the controller materializes the
// target whenever machine + process resolve, i.e. always.
test('a seeded target on an OPENED project baselines silently and does not light Save', () => {
  const controller = makeController(START)
  const { result, refresh } = renderHistory(controller)
  assert.equal(result.current.hasUnsavedChanges, false, 'no target resolved yet')

  // The catalogue resolves and the controller materializes the seeded target (mirrors the file).
  act(() => { controller.setRetargetTarget({ printerProfileId: 'machine-1', printerModel: 'X1C' }) })
  refresh()
  assert.equal(result.current.hasUnsavedChanges, false, 'the seed is what the file carries, not unsaved work')

  // A genuine target change arrives THROUGH a recorded gesture (the wrapped setters record
  // before mutating), which freezes the baseline: the new signature then reads as unsaved.
  act(() => { result.current.sliceConfigForPanel!.selectPrinterModel('H2D') })
  refresh()
  act(() => { controller.setRetargetTarget({ printerProfileId: 'machine-2', printerModel: 'H2D' }) })
  refresh()
  assert.equal(result.current.hasUnsavedChanges, true, 'a changed target is unsaved work')
})

test('a pristine session re-baselines as the seed SEQUENCE lands: Save stays grey at open', () => {
  // Seeding is multi-step (machine fallback before the catalogue, baked defaults after it): a
  // baseline captured at the FIRST resolve drifts as later seeds land, which lit Save on a
  // freshly-opened untouched project. While nothing is recorded/dirty, every signature change is
  // still "what the file carries" and must re-baseline.
  const controller = makeController(START)
  const { result, refresh } = renderHistory(controller)
  act(() => { controller.setRetargetTarget({ printerProfileId: 'machine-early-fallback', printerModel: 'unknown' }) })
  refresh()
  act(() => { controller.setRetargetTarget({ printerProfileId: 'machine-1', printerModel: 'X1C' }) })
  refresh()
  assert.equal(result.current.hasUnsavedChanges, false, 'late seeds re-baseline instead of lighting Save')

  // The first user gesture freezes the baseline on the pre-gesture value.
  act(() => { result.current.sliceConfigForPanel!.selectPrinterModel('H2D') })
  refresh()
  act(() => { controller.setRetargetTarget({ printerProfileId: 'machine-2', printerModel: 'H2D' }) })
  refresh()
  assert.equal(result.current.hasUnsavedChanges, true, 'post-gesture target changes are unsaved work')
})

test('saving re-baselines the target so Save greys and stays grey', () => {
  const controller = makeController(START)
  const { result, refresh } = renderHistory(controller)
  act(() => { controller.setRetargetTarget({ printerProfileId: 'machine-1', printerModel: 'X1C' }) })
  refresh()
  // A user gesture freezes the baseline; the resulting target change is unsaved work.
  act(() => { result.current.sliceConfigForPanel!.selectPrinterModel('H2D') })
  refresh()
  act(() => { controller.setRetargetTarget({ printerProfileId: 'machine-2', printerModel: 'H2D' }) })
  refresh()
  assert.equal(result.current.hasUnsavedChanges, true)

  act(() => { result.current.markSaved() })
  refresh()
  assert.equal(result.current.hasUnsavedChanges, false, 'the save baked exactly this target')

  // The post-save world keeps producing the SAME signature (refetch reconciliation), no re-light.
  refresh()
  assert.equal(result.current.hasUnsavedChanges, false, 'no post-save re-lighting')
})

test('an editor-born project counts its seeded target as unsaved work until the first save', () => {
  const controller = makeController(START)
  const { result, refresh } = renderHistory(controller, { editorBorn: true })
  act(() => { controller.setRetargetTarget({ printerProfileId: 'machine-1', printerModel: 'X1C' }) })
  refresh()
  assert.equal(result.current.hasUnsavedChanges, true, 'a scaffold has no machine: the seed must be saved')

  act(() => { result.current.markSaved() })
  refresh()
  assert.equal(result.current.hasUnsavedChanges, false, 'saved: the target is now what the file carries')
})

test('a material colour change is undoable, and a drag collapses into one step', () => {
  // Reported as "I changed a material color and it did not create a history record for me to
  // undo": these edits marked the project dirty but snapshotted nothing, so Ctrl+Z skipped past
  // them to whatever scene edit came before.
  const controller = makeController({ ...START, sessionSlots: [slot(1, 0, '#ff0000')] })
  const { result, refresh } = renderHistory(controller)
  assert.equal(result.current.canUndo, false)

  act(() => { result.current.sliceConfigForPanel!.setFilamentColors({ 1: '#00ff00' }) })
  refresh()
  assert.equal(result.current.canUndo, true, 'a colour change must record a checkpoint')
  assert.deepEqual(coloursOf(controller.read().sessionSlots), { 1: '#00ff00' })

  // A colour picker fires continuously while dragged; those must extend the same step rather than
  // burying earlier history under one entry per frame.
  act(() => { result.current.sliceConfigForPanel!.setFilamentColors({ 1: '#00fe00' }) })
  refresh()
  act(() => { result.current.sliceConfigForPanel!.setFilamentColors({ 1: '#00fd00' }) })
  refresh()

  act(() => { result.current.undo() })
  assert.deepEqual(coloursOf(controller.read().sessionSlots), { 1: '#ff0000' }, 'one undo returns to the colour before the drag')
  assert.equal(result.current.canUndo, false, 'the whole drag was a single step')
})

test('undo past a save that removed a material puts the material back', () => {
  // The point of holding the session's material LIST rather than a delta over the file. Before,
  // the frame only said "remove slot 2", which against the post-save file meant "remove whatever
  // slot 2 has become", so the overlay had to be discarded and the material stayed gone.
  const controller = makeController(START)
  const { result, refresh } = renderHistory(controller)

  // Three materials, then an edit recorded while all three are present.
  controller.setSessionSlots([slot(1, 0, '#aaaaaa'), slot(2, 1, '#bbbbbb'), slot(3, 2, '#cccccc')])
  refresh()
  act(() => { result.current.sliceConfigForPanel!.selectPrinterModel('H2D') })
  refresh()

  // The save drops the middle slot, so the file is now [1, 3] and the session follows it again.
  controller.setSessionSlots(null)
  refresh()
  act(() => { result.current.rebaseFilamentSources(new Map([[0, 0], [2, 1]])) })

  act(() => { result.current.undo() })
  assert.deepEqual(
    controller.read().sessionSlots?.map((entry) => entry.projectFilamentId),
    [1, 2, 3],
    'the removed material is back, in its original position'
  )
  assert.deepEqual(
    coloursOf(controller.read().sessionSlots),
    { 1: '#aaaaaa', 2: '#bbbbbb', 3: '#cccccc' },
    "and it keeps its own colour: the frame's per-slot state was never remapped away"
  )
})

test('a restored frame re-points its sourceIndex at the base the save left behind', () => {
  // `sourceIndex` is the one field in a frame that refers OUTSIDE it, into the file's slot order,
  // so it is the one thing a save has to migrate. A source the save dropped becomes null, which
  // authors that slot from its preset instead of cloning a block that is no longer there.
  const controller = makeController(START)
  const { result, refresh } = renderHistory(controller)
  controller.setSessionSlots([slot(1, 0), slot(2, 1), slot(3, 2)])
  refresh()
  act(() => { result.current.sliceConfigForPanel!.selectPrinterModel('H2D') })
  refresh()

  // Saved as [slot 1, slot 3]: old base index 0 -> 0, old index 2 -> 1, old index 1 dropped.
  act(() => { result.current.rebaseFilamentSources(new Map([[0, 0], [2, 1]])) })
  act(() => { result.current.undo() })

  assert.deepEqual(
    controller.read().sessionSlots?.map((entry) => entry.sourceIndex),
    [0, null, 1],
    'survivors follow the file, and the re-added slot has nothing left to clone'
  )
})


test('replacing an in-use material is one combined undo and redo step', () => {
  type EditorState = import('./lib/editorModel').EditorState
  const controller = makeController({ ...START, sessionSlots: [slot(1, 0), slot(2, 1)] })
  const stateRef: { current: EditorState | null } = { current: { plates: [], colorPaint: { '1:0': { 0: '8' } } } }
  const build = (): SliceSettingsController => ({
    ...controller.build(),
    projectFilaments: (controller.read().sessionSlots ?? []).map((entry) => ({ ...entry, usedOnSelectedPlate: true })),
    onRemoveFilament: (id) => controller.setSessionSlots((controller.read().sessionSlots ?? []).filter((entry) => entry.projectFilamentId !== id))
  })
  const view = renderHook(({ config }) => useEditorHistory({
    stateRef,
    setState: (value) => { stateRef.current = typeof value === 'function' ? value(stateRef.current) : value },
    setSelectedKey: () => {}, setActivePlateIndex: () => {}, setRebuildToken: () => {},
    sliceConfig: config, usedFilamentIds: new Set([2]), supportOnlyFilamentIds: new Set()
  }), { initialProps: { config: build() } })
  act(() => view.result.current.sliceConfigForPanel!.onRemoveFilament(2, 1))
  act(() => view.rerender({ config: build() }))
  assert.equal(stateRef.current?.colorPaint?.['1:0']?.[0], '4')
  assert.equal(controller.read().sessionSlots?.length, 1)
  act(() => view.result.current.undo())
  act(() => view.rerender({ config: build() }))
  assert.equal(stateRef.current?.colorPaint?.['1:0']?.[0], '8')
  assert.equal(controller.read().sessionSlots?.length, 2)
  assert.equal(view.result.current.canUndo, false)
  act(() => view.result.current.redo())
  assert.equal(stateRef.current?.colorPaint?.['1:0']?.[0], '4')
  assert.equal(controller.read().sessionSlots?.length, 1)
  assert.deepEqual(stateRef.current?.baseFilamentIds, { 1: 1, 2: 1 })
  act(() => view.rerender({ config: build() }))
  act(() => view.result.current.recordHistory())
  stateRef.current = { ...stateRef.current!, colorPaint: {} }
  act(() => view.result.current.undo())
  assert.deepEqual(stateRef.current?.baseFilamentIds, { 1: 1, 2: 1 })
  view.unmount()
})

test('unverified source paint requires a replacement and remains one undo step', () => {
  type EditorState = import('./lib/editorModel').EditorState
  const controller = makeController({ ...START, sessionSlots: [slot(1, 0), slot(2, 1)] })
  const stateRef: { current: EditorState | null } = { current: { plates: [] } }
  const build = (): SliceSettingsController => ({
    ...controller.build(),
    projectFilaments: (controller.read().sessionSlots ?? []).map((entry) => ({ ...entry, usedOnSelectedPlate: true })),
    onRemoveFilament: (id) => controller.setSessionSlots((controller.read().sessionSlots ?? []).filter((entry) => entry.projectFilamentId !== id))
  })
  const view = renderHook(({ config }) => useEditorHistory({
    stateRef,
    setState: (value) => { stateRef.current = typeof value === 'function' ? value(stateRef.current) : value },
    setSelectedKey: () => {}, setActivePlateIndex: () => {}, setRebuildToken: () => {},
    sliceConfig: config, usedFilamentIds: new Set<number>(), unverifiedFilamentIds: new Set([2]), supportOnlyFilamentIds: new Set()
  }), { initialProps: { config: build() } })
  assert.equal(view.result.current.sliceConfigForPanel!.filamentInUse!(2), false)
  assert.equal(view.result.current.sliceConfigForPanel!.filamentRemovalNeedsReplacement!(2), true)
  act(() => view.result.current.sliceConfigForPanel!.onRemoveFilament(2))
  assert.equal(controller.read().sessionSlots?.length, 2)
  assert.equal(view.result.current.canUndo, false)
  act(() => view.result.current.sliceConfigForPanel!.onRemoveFilament(2, 1))
  act(() => view.rerender({ config: build() }))
  assert.equal(remapBaseMaterialPaint(stateRef.current!, { 0: '8' })?.[0], '4')
  assert.equal(controller.read().sessionSlots?.length, 1)
  act(() => view.result.current.undo())
  act(() => view.rerender({ config: build() }))
  assert.equal(remapBaseMaterialPaint(stateRef.current!, { 0: '8' })?.[0], '8')
  assert.equal(controller.read().sessionSlots?.length, 2)
  assert.equal(view.result.current.canUndo, false)
  act(() => view.result.current.redo())
  assert.equal(remapBaseMaterialPaint(stateRef.current!, { 0: '8' })?.[0], '4')
  assert.equal(controller.read().sessionSlots?.length, 1)
  assert.deepEqual(stateRef.current?.baseFilamentIds, { 1: 1, 2: 1 })
  act(() => view.rerender({ config: build() }))
  act(() => view.result.current.recordHistory())
  stateRef.current = { ...stateRef.current!, colorPaint: {} }
  act(() => view.result.current.undo())
  assert.deepEqual(stateRef.current?.baseFilamentIds, { 1: 1, 2: 1 })
  view.unmount()
})
