/**
 * The shared material-slots core (see useMaterialSlots.ts). Pins the contracts both hosts rely on:
 * the add/remove overlay + the filament-index remap callback, the post-save rebase that folds the
 * overlay into the refetched base, and the loop-proof reconciliation updaters (same-identity
 * results when nothing changed, an unstable caller identity must cost a render, never a loop).
 */
import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { LibraryFile, ThreeMfIndex } from '@printstream/shared'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import type { SliceProjectFilament } from './useMaterialSlots'

const dom = installJsdomGlobals()

const { renderHook, act, cleanup } = await import('@testing-library/react')
const { useMaterialSlots } = await import('./useMaterialSlots')

afterEach(() => { cleanup() })
after(() => { dom.window.close() })

const FILE = { id: 'f1', name: 'Widget.3mf', kind: '3mf', projectFilamentChips: [] } as unknown as LibraryFile

function slot(projectFilamentId: number, color: string): SliceProjectFilament {
  return { projectFilamentId, label: 'PLA', color, nozzleId: null, usedOnSelectedPlate: true }
}

function renderSlots(initial?: { baseProjectFilaments?: SliceProjectFilament[]; onFilamentRemoved?: (position: number) => void; onFilamentReordered?: (remap: ReadonlyMap<number, number>) => void }) {
  const props = {
    file: FILE,
    bakedIndex: null as ThreeMfIndex | null,
    baseProjectFilaments: initial?.baseProjectFilaments ?? [slot(1, '#111111'), slot(2, '#222222')],
    filamentProfiles: [],
    compatibleFilamentProfiles: [],
    materialOptions: [],
    selectedMachineProfile: null,
    onFilamentRemoved: initial?.onFilamentRemoved,
    onFilamentReordered: initial?.onFilamentReordered
  }
  const view = renderHook((p: typeof props) => useMaterialSlots(p), { initialProps: props })
  return { ...view, props }
}

test('adding a slot mints a fresh id seeded from the CHOICE, not the first material; removing an added slot drops it', () => {
  const { result } = renderSlots()
  act(() => { result.current.handleAddFilament({ optionId: 'profile:petg-basic', color: '#123456', label: 'PETG' }) })
  assert.deepEqual(result.current.projectFilaments.map((entry) => entry.projectFilamentId), [1, 2, 3])
  assert.equal(result.current.filamentMaterialOptionIds[3], 'profile:petg-basic')
  assert.equal(result.current.projectFilaments[2]?.label, 'PETG')
  // Load-bearing: this used to clone slot 1's colour (falling back to a machine default preset plus
  // #FFFFFF), which the identity resolver then named as a specific real product the user had never
  // picked. Nothing about a new slot may come from anywhere but the confirmed choice.
  assert.equal(result.current.filamentColors[3], '#123456', 'the new slot takes the chosen colour, not the template colour')
  act(() => { result.current.handleRemoveFilament(3) })
  assert.deepEqual(result.current.projectFilaments.map((entry) => entry.projectFilamentId), [1, 2])
})

// Coverage for consecutive adds: the case that broke in the browser, where every add after the
// FIRST lost its pick and rendered as a bare "PLA". Read this test for what it is: it does NOT
// reproduce that failure, and passes against the buggy implementation too. The picks used to be
// written through setFilamentMaterialOptionIds/Colors/ToolheadIds from inside the setSessionSlots
// updater; those setters are projections that map over the slots that ALREADY exist, so a write for
// a slot not yet appended is silently dropped. Whether the nested write landed before or after the
// append depended on React's dispatch path, the first add also flipped `sessionOwned`, which kept
// it off the eager path, and this renderer takes the order that happens to work.
//
// So the guarantee is structural, not observable here: `handleAddFilament` appends a COMPLETE slot
// and issues no nested writes at all, which is what makes dispatch order irrelevant. Verified
// against the running app (six consecutive adds, all keeping their preset).
test('every added slot keeps its pick, not just the first', () => {
  const { result } = renderSlots()
  act(() => { result.current.handleAddFilament({ optionId: 'profile:a', color: '#111111', label: 'PLA' }) })
  act(() => { result.current.handleAddFilament({ optionId: 'profile:b', color: '#222222', label: 'PETG' }) })
  act(() => { result.current.handleAddFilament({ optionId: 'profile:c', color: '#333333', label: 'ABS' }) })

  assert.deepEqual(result.current.projectFilaments.map((entry) => entry.projectFilamentId), [1, 2, 3, 4, 5])
  assert.deepEqual(
    [3, 4, 5].map((id) => result.current.filamentMaterialOptionIds[id]),
    ['profile:a', 'profile:b', 'profile:c']
  )
  assert.deepEqual(
    [3, 4, 5].map((id) => result.current.filamentColors[id]),
    ['#111111', '#222222', '#333333']
  )
})

test('removing a base slot reports its 1-based pre-removal position to the host remap', () => {
  const positions: number[] = []
  const { result } = renderSlots({ onFilamentRemoved: (position) => positions.push(position) })
  act(() => { result.current.handleRemoveFilament(2) })
  assert.deepEqual(positions, [2], 'the host remaps filament-index references from the pre-removal order')
  assert.deepEqual(result.current.projectFilaments.map((entry) => entry.projectFilamentId), [1])
  // desiredFilaments keeps pointing the kept slot at its ORIGINAL base position for the writer.
  assert.equal(result.current.desiredFilaments?.length, 1)
  assert.equal(result.current.desiredFilaments?.[0]?.sourceIndex, 0)
})

test('the post-save rebase folds the overlay into the refetched base by save order', () => {
  const view = renderSlots()
  // Session: remove slot 1, recolour the kept slot 2: the save bakes [slot 2] as new slot 1.
  act(() => { view.result.current.handleRemoveFilament(1) })
  act(() => { view.result.current.setFilamentColors((current) => ({ ...current, 2: '#000000' })) })
  act(() => { view.result.current.onProjectSaved() })
  // The refetched base lands: ONE slot, new id 1 (a different signature than the 2-slot base).
  act(() => { view.rerender({ ...view.props, baseProjectFilaments: [slot(1, '#000000')] }) })
  assert.deepEqual(view.result.current.projectFilaments.map((entry) => entry.projectFilamentId), [1])
  assert.equal(view.result.current.filamentColors[1], '#000000', 'the kept slot state followed the renumbering (old id 2 -> new id 1)')
})

test('re-rendering with fresh-but-equal inputs keeps state identities stable (no reconcile loop)', () => {
  const view = renderSlots()
  const before = view.result.current.filamentColors
  // A caller that recreates its file/bakedIndex identity (the exact shape that turned the
  // merge-under effects into an infinite loop) must cost renders, never state churn.
  for (let i = 0; i < 3; i++) {
    act(() => { view.rerender({ ...view.props, file: { ...FILE } as LibraryFile }) })
  }
  assert.equal(view.result.current.filamentColors, before, 'updaters return the same identity when nothing changed')
})

// Exit-139 regression: a dual-nozzle project switched to a SINGLE-nozzle printer must not emit a
// nozzle the machine lacks. The stale pick (`nozzle-1`) AND the slot's baked nozzle were both
// carried through, so the save/slice named extruder 2 on a one-extruder machine: BambuStudio reads
// it out of bounds and SIGSEGVs mid-slice.
test('a nozzle the machine does not have is never emitted, and the stale pick is dropped', () => {
  const DUAL = [{ id: 'nozzle-1' }, { id: 'nozzle-0' }]
  const props = {
    file: FILE,
    bakedIndex: null as ThreeMfIndex | null,
    // The slot was baked on a dual-nozzle machine: its own nozzleId is the LEFT one.
    baseProjectFilaments: [{ projectFilamentId: 1, label: 'PLA', color: '#111111', nozzleId: 1, usedOnSelectedPlate: true }],
    filamentProfiles: [],
    compatibleFilamentProfiles: [],
    materialOptions: [],
    selectedMachineProfile: null,
    toolheadOptions: DUAL
  }
  const view = renderHook((p: typeof props) => useMaterialSlots(p), { initialProps: props })
  act(() => { view.result.current.setFilamentToolheadIds({ 1: 'nozzle-1' }) })
  assert.equal(view.result.current.desiredFilaments?.[0]?.nozzleId, 1, 'the left nozzle is valid on a dual-nozzle machine')

  // Switch to a single-nozzle machine: its only toolhead carries no nozzle id.
  act(() => { view.rerender({ ...props, toolheadOptions: [{ id: 'primary' }] }) })
  assert.equal(view.result.current.desiredFilaments?.[0]?.nozzleId, null, 'no nozzle may be emitted for a single-nozzle machine')
  assert.deepEqual(view.result.current.filamentToolheadIds, {}, 'the stale dual-nozzle pick is dropped from the UI too')
})

test('a removed slot keeps its per-slot state, so restoring a snapshot brings the material back whole', () => {
  // The session holds its material LIST, not a delta over the file, so a captured snapshot is
  // self-describing: restoring it returns the slot, its position and its colour together. The
  // keyed state is deliberately left behind on removal for exactly this reason.
  const { result } = renderSlots({ baseProjectFilaments: [slot(1, '#111111'), slot(2, '#222222'), slot(3, '#333333')] })
  const before = result.current.materialSnapshot
  assert.deepEqual(before.sessionSlots?.map((entry) => entry.projectFilamentId), [1, 2, 3])

  act(() => { result.current.handleRemoveFilament(2) })
  assert.deepEqual(result.current.projectFilaments.map((entry) => entry.projectFilamentId), [1, 3])

  act(() => { result.current.restoreMaterialSnapshot(before) })
  assert.deepEqual(result.current.projectFilaments.map((entry) => entry.projectFilamentId), [1, 2, 3], 'it comes back in place')
  assert.equal(
    result.current.projectFilaments.find((entry) => entry.projectFilamentId === 2)?.color,
    '#222222',
    'and whole: the slot carries its own identity, so nothing had to be reconstructed from the file'
  )
})

test('each slot carries the base index its slicer settings clone from', () => {
  const { result } = renderSlots({ baseProjectFilaments: [slot(1, '#111111'), slot(2, '#222222')] })
  act(() => { result.current.handleRemoveFilament(1) })
  // Slot 2 was base index 1 and still is: the file has not moved yet, only the session list.
  assert.deepEqual(result.current.materialSnapshot.sessionSlots?.map((entry) => entry.sourceIndex), [1])
  assert.equal(result.current.desiredFilaments?.[0]?.sourceIndex, 1, 'the bake clones the right original slot')
})

test('a snapshot taken while the session still follows the file records the LIST it saw', () => {
  // The bug the browser caught: the snapshot stored the live "follow the file" null, which is a
  // reference that MOVES. A frame captured before a removal then said "follow the file", and once
  // the save had taken that material out of the file, undo faithfully restored the shorter list,
  // so the material stayed gone, which is the very thing this design exists to prevent.
  const { result, rerender, props } = renderSlots({ baseProjectFilaments: [slot(1, '#111111'), slot(2, '#222222')] })
  const beforeAnyEdit = result.current.materialSnapshot
  assert.deepEqual(
    beforeAnyEdit.sessionSlots?.map((entry) => entry.projectFilamentId),
    [1, 2],
    'captured as a concrete list, not as a promise to re-read the file'
  )

  // The file loses a slot (what a save that removed one leaves behind).
  rerender({ ...props, baseProjectFilaments: [slot(1, '#111111')] })
  assert.deepEqual(result.current.projectFilaments.map((entry) => entry.projectFilamentId), [1])

  act(() => { result.current.restoreMaterialSnapshot(beforeAnyEdit) })
  assert.deepEqual(
    result.current.projectFilaments.map((entry) => entry.projectFilamentId),
    [1, 2],
    'restoring the frame brings the material back even though the file no longer has it'
  )
})

test('tune overrides travel WITH their slot, so a removal takes them and a restore brings them back', () => {
  // The first per-slot field moved off id-keyed storage. State that travels with its slot cannot be
  // orphaned by a renumber that misses a map, which is the whole reason the id space needed
  // walking across a save.
  const { result } = renderSlots({ baseProjectFilaments: [slot(1, '#111111'), slot(2, '#222222')] })
  act(() => { result.current.setFilamentSettingOverridesById({ 2: { nozzle_temperature: '250' } }) })
  assert.deepEqual(result.current.filamentSettingOverridesById, { 2: { nozzle_temperature: '250' } })

  const withOverride = result.current.materialSnapshot
  act(() => { result.current.handleRemoveFilament(2) })
  assert.deepEqual(result.current.filamentSettingOverridesById, {}, 'the slot took its overrides with it')

  act(() => { result.current.restoreMaterialSnapshot(withOverride) })
  assert.deepEqual(
    result.current.filamentSettingOverridesById,
    { 2: { nozzle_temperature: '250' } },
    'and brought them back: the snapshot never carried a second copy to fall out of step'
  )
})

test('tune overrides survive the save that renumbers the slots', () => {
  // The post-save transition replaces the session's slots with the file's, so anything the slot
  // carries has to be carried across positionally or it would be dropped exactly where the old
  // id-keyed remap used to move it.
  const view = renderSlots()
  act(() => { view.result.current.handleRemoveFilament(1) })
  act(() => { view.result.current.setFilamentSettingOverridesById({ 2: { nozzle_temperature: '250' } }) })
  act(() => { view.result.current.onProjectSaved() })
  // The refetched base lands: the kept slot is now the file's slot 1.
  act(() => { view.rerender({ ...view.props, baseProjectFilaments: [slot(1, '#222222')] }) })

  assert.deepEqual(view.result.current.projectFilaments.map((entry) => entry.projectFilamentId), [1])
  assert.deepEqual(
    view.result.current.filamentSettingOverridesById,
    { 1: { nozzle_temperature: '250' } },
    'the override followed its slot to its new position'
  )
})

test('the profile-edited flag lives on the slot, and a renumbering save clears it', () => {
  // It marks "the user picked this preset, and the file does not carry it yet". Once the save has
  // baked the pick into the file's slots it is no longer pending, so the carry deliberately drops
  // it: unlike the type filter beside it, which is still the session's.
  const view = renderSlots()
  act(() => { view.result.current.handleMaterialOptionChange(2, { id: 'profile:x', materialType: 'PETG' } as never) })
  assert.deepEqual([...view.result.current.profileEditedFilamentIds], [2])
  assert.deepEqual(view.result.current.filamentMaterialTypeFilters, { 2: 'PETG' }, 'the type filter moved with it')

  // Remove the other slot so the save actually rewrites the file's list (the carry waits for that).
  act(() => { view.result.current.handleRemoveFilament(1) })
  act(() => { view.result.current.onProjectSaved() })
  act(() => { view.rerender({ ...view.props, baseProjectFilaments: [slot(1, '#222222')] }) })

  assert.deepEqual([...view.result.current.profileEditedFilamentIds], [], 'the pick is in the file now')
  assert.deepEqual(
    view.result.current.filamentMaterialTypeFilters,
    { 1: 'PETG' },
    "but the filter is still the session's, and followed its slot to the new position"
  )
})

test('a restored snapshot brings back the type filter and the profile-edited flag with their slot', () => {
  const { result } = renderSlots()
  act(() => { result.current.handleMaterialOptionChange(2, { id: 'profile:x', materialType: 'PETG' } as never) })
  const before = result.current.materialSnapshot

  act(() => { result.current.handleRemoveFilament(2) })
  assert.deepEqual([...result.current.profileEditedFilamentIds], [], 'the slot took its flag with it')

  act(() => { result.current.restoreMaterialSnapshot(before) })
  assert.deepEqual([...result.current.profileEditedFilamentIds], [2])
  assert.deepEqual(result.current.filamentMaterialTypeFilters, { 2: 'PETG' })
})

test('the file replaces the list while the session has not diverged, and never after it has', () => {
  // Ownership is now explicit instead of being implied by "the list is null". That is what lets
  // per-slot state live on the slots: writing to a slot no longer has to pretend the user diverged.
  const view = renderSlots()
  act(() => { view.rerender({ ...view.props, baseProjectFilaments: [slot(1, '#111111'), slot(2, '#222222'), slot(3, '#333333')] }) })
  assert.deepEqual(
    view.result.current.projectFilaments.map((entry) => entry.projectFilamentId),
    [1, 2, 3],
    'an untouched session follows the file'
  )

  act(() => { view.result.current.handleRemoveFilament(2) })
  act(() => { view.rerender({ ...view.props, baseProjectFilaments: [slot(1, '#111111'), slot(2, '#222222'), slot(3, '#333333'), slot(4, '#444444')] }) })
  assert.deepEqual(
    view.result.current.projectFilaments.map((entry) => entry.projectFilamentId),
    [1, 3],
    'once the session owns its list the file may not overwrite it'
  )
})

test('adopting the file keeps what the session knows about each surviving slot', () => {
  const view = renderSlots()
  act(() => { view.result.current.setFilamentSettingOverridesById({ 2: { nozzle_temperature: '250' } }) })
  // A refetch that drops slot 1: slot 2 survives and keeps its overrides.
  act(() => { view.rerender({ ...view.props, baseProjectFilaments: [slot(2, '#222222')] }) })
  assert.deepEqual(view.result.current.projectFilaments.map((entry) => entry.projectFilamentId), [2])
  assert.deepEqual(view.result.current.filamentSettingOverridesById, { 2: { nozzle_temperature: '250' } })
})

test('an unstable base identity costs renders, not a reconcile loop', () => {
  // The base reconciliation keys on a signature derived from a caller-supplied array, so an updater
  // that always minted a new list would loop. Same rule as the other reconcilers here.
  const view = renderSlots()
  const before = view.result.current.projectFilaments
  for (let i = 0; i < 3; i++) {
    act(() => { view.rerender({ ...view.props, baseProjectFilaments: [slot(1, '#111111'), slot(2, '#222222')] }) })
  }
  assert.deepEqual(view.result.current.projectFilaments.map((entry) => entry.projectFilamentId), before.map((entry) => entry.projectFilamentId))
})

test('plate usage is read from the FILE per render, not frozen onto the slot', () => {
  // It answers "does the active plate use this material", which changes when the user switches
  // plates without the material list changing at all, so it cannot live on the session's slot.
  const used = { projectFilamentId: 1, label: 'PLA', color: '#111111', nozzleId: null, usedOnSelectedPlate: true }
  const view = renderSlots({ baseProjectFilaments: [used] })
  assert.equal(view.result.current.projectFilaments[0]?.usedOnSelectedPlate, true)
  act(() => { view.rerender({ ...view.props, baseProjectFilaments: [{ ...used, usedOnSelectedPlate: false }] }) })
  assert.equal(view.result.current.projectFilaments[0]?.usedOnSelectedPlate, false, 'a plate switch is reflected immediately')
})

test('no per-slot state is keyed by session id any more: a save renumbers by rewriting the list', () => {
  // The end of S6's premise. Every per-slot fact, pick, colour, nozzle, overrides, filter, travels
  // ON the slot, so a save that renumbers moves them by rebuilding the list, with no map to walk and
  // none to forget.
  const view = renderSlots()
  act(() => {
    view.result.current.setFilamentColors({ 2: '#00ff00' })
    view.result.current.setFilamentToolheadIds({ 2: 'nozzle-0' })
    view.result.current.setFilamentSettingOverridesById({ 2: { nozzle_temperature: '250' } })
  })
  act(() => { view.result.current.handleRemoveFilament(1) })
  act(() => { view.result.current.onProjectSaved() })
  // The refetched base: the kept slot is now the file's slot 1.
  act(() => { view.rerender({ ...view.props, baseProjectFilaments: [slot(1, '#00ff00')] }) })

  assert.deepEqual(view.result.current.projectFilaments.map((entry) => entry.projectFilamentId), [1])
  assert.deepEqual(view.result.current.filamentColors, { 1: '#00ff00' })
  assert.deepEqual(view.result.current.filamentToolheadIds, { 1: 'nozzle-0' })
  assert.deepEqual(view.result.current.filamentSettingOverridesById, { 1: { nozzle_temperature: '250' } })
})

test('a colour pick falls back to the file colour, and survives an undo restore whole', () => {
  const { result } = renderSlots()
  assert.equal(result.current.desiredFilaments?.[0]?.color, '#111111', "no pick yet: the file's colour is emitted")
  act(() => { result.current.setFilamentColors({ 1: '#00ff00' }) })
  const picked = result.current.materialSnapshot
  assert.equal(result.current.desiredFilaments?.[0]?.color, '#00ff00')

  act(() => { result.current.setFilamentColors({}) })
  assert.equal(result.current.desiredFilaments?.[0]?.color, '#111111', 'clearing the pick falls back again')
  act(() => { result.current.restoreMaterialSnapshot(picked) })
  assert.equal(result.current.desiredFilaments?.[0]?.color, '#00ff00', 'and the snapshot carried the pick on its slot')
})

test('a save renumbers the list without the refetched file landing at all', () => {
  // The in-memory-after-open goal: the save WROTE these slots as the file's 1..N, so the session
  // already knows the answer and must not have to ask for it back. This used to arm a pending
  // rebase and wait for the refetched index: correctness depended on a request landing, and on
  // the caller arming before the invalidation, or an added material showed up twice.
  const view = renderSlots()
  act(() => { view.result.current.setFilamentColors({ 2: '#00ff00' }) })
  act(() => { view.result.current.handleRemoveFilament(1) })
  assert.deepEqual(view.result.current.projectFilaments.map((entry) => entry.projectFilamentId), [2])

  act(() => { view.result.current.onProjectSaved() })
  // NO rerender: the file has not come back, and is not going to in this test.
  assert.deepEqual(
    view.result.current.projectFilaments.map((entry) => entry.projectFilamentId),
    [1],
    'the kept slot is already the saved file\'s slot 1'
  )
  assert.deepEqual(view.result.current.filamentColors, { 1: '#00ff00' }, 'and its state came with it')
  assert.equal(view.result.current.desiredFilaments?.[0]?.sourceIndex, 0, 'a further save clones from the slot we just wrote')
})

test('the refetch, when it does land, is an ordinary refresh rather than the source of truth', () => {
  const view = renderSlots()
  act(() => { view.result.current.setFilamentColors({ 2: '#00ff00' }) })
  act(() => { view.result.current.handleRemoveFilament(1) })
  act(() => { view.result.current.onProjectSaved() })
  const beforeRefetch = view.result.current.projectFilaments.map((entry) => entry.projectFilamentId)

  // The file finally arrives, carrying the label the bake wrote.
  act(() => { view.rerender({ ...view.props, baseProjectFilaments: [{ projectFilamentId: 1, label: 'Bambu PETG HF', color: '#00ff00', nozzleId: null, usedOnSelectedPlate: true }] }) })
  assert.deepEqual(view.result.current.projectFilaments.map((entry) => entry.projectFilamentId), beforeRefetch, 'membership was already right')
  assert.equal(view.result.current.projectFilaments[0]?.label, 'Bambu PETG HF', 'it only refreshes what the FILE owns')
  assert.deepEqual(view.result.current.filamentColors, { 1: '#00ff00' }, 'the session pick is untouched')
})

// The file's materials arrive in two steps, a short DTO view first, the full index after, so a
// seed can land while the session's slot list is still short. These setters are projections that
// map over the slots that ALREADY exist, so the seed for the missing slot was silently discarded,
// and the index never changed again to re-trigger it: on a 3-material project the third material
// lost its nozzle assignment permanently.
test('a baked nozzle assignment still lands when the slot list catches up late', () => {
  const index = {
    plates: [],
    compatiblePrinterModels: [],
    supportFilamentIds: [],
    printerProfileName: null,
    processProfileName: null,
    projectFilaments: [
      { id: 1, filamentType: 'PETG', filamentName: 'A', color: '#111111', nozzleId: 1, chamberTemperature: null },
      { id: 2, filamentType: 'PETG', filamentName: 'B', color: '#222222', nozzleId: 0, chamberTemperature: null },
      { id: 3, filamentType: 'PLA-S', filamentName: 'C', color: '#333333', nozzleId: 0, chamberTemperature: null }
    ]
  } as unknown as ThreeMfIndex

  // The full index is in hand, but the base list still shows only the first two materials.
  const props = {
    file: FILE,
    bakedIndex: index,
    baseProjectFilaments: [slot(1, '#111111'), slot(2, '#222222')],
    filamentProfiles: [],
    compatibleFilamentProfiles: [],
    materialOptions: [],
    selectedMachineProfile: null
  }
  const view = renderHook((p: typeof props) => useMaterialSlots(p), { initialProps: props })
  assert.equal(view.result.current.filamentToolheadIds[1], 'nozzle-1')
  assert.equal(view.result.current.filamentToolheadIds[3], undefined, 'the third slot does not exist yet')

  // The third material arrives. The index has NOT changed, so only the slot list can re-trigger it.
  act(() => {
    view.rerender({ ...props, baseProjectFilaments: [slot(1, '#111111'), slot(2, '#222222'), slot(3, '#333333')] })
  })
  assert.equal(view.result.current.filamentToolheadIds[3], 'nozzle-0', 'the late slot picks up its baked nozzle')
  assert.equal(view.result.current.filamentColors[3], '#333333', 'and its baked colour')
})

test('reordering moves the slot, keeps its id, and reports the position permutation', () => {
  const remaps: Array<ReadonlyMap<number, number>> = []
  const { result } = renderSlots({
    baseProjectFilaments: [slot(1, '#111111'), slot(2, '#222222'), slot(3, '#333333')],
    onFilamentReordered: (remap) => remaps.push(remap)
  })
  // Drag slot 1 (index 0) into the gap after slot 3 (gap 3): order becomes [2, 3, 1].
  act(() => { result.current.handleReorderFilament(0, 3) })
  assert.deepEqual(result.current.projectFilaments.map((entry) => entry.projectFilamentId), [2, 3, 1],
    'session ids travel with their slots: paint and picks stay attached')
  assert.equal(remaps.length, 1)
  assert.deepEqual([...remaps[0]!.entries()].sort((a, b) => a[0] - b[0]), [[1, 3], [2, 1], [3, 2]],
    'the host gets the old-position -> new-position permutation')
  // The baked list follows the new order via each slot's carried sourceIndex.
  assert.deepEqual(result.current.desiredFilaments?.map((entry) => entry.sourceIndex), [1, 2, 0])
})

test('a no-op drop (same position) reports nothing and keeps list identity', () => {
  const remaps: Array<ReadonlyMap<number, number>> = []
  const { result } = renderSlots({ onFilamentReordered: (remap) => remaps.push(remap) })
  const before = result.current.projectFilaments
  // Gaps 0 and 1 both mean "stay first" for the slot at index 0.
  act(() => { result.current.handleReorderFilament(0, 0) })
  act(() => { result.current.handleReorderFilament(0, 1) })
  assert.equal(remaps.length, 0, 'no permutation callback for a drop that moves nothing')
  assert.deepEqual(result.current.projectFilaments.map((entry) => entry.projectFilamentId),
    before.map((entry) => entry.projectFilamentId))
})
