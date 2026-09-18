import assert from 'node:assert/strict'
import test from 'node:test'
import { remapBaseMaterialPaint, replaceEditorMaterial, sceneObjectMaterialIds, unverifiedSourceMaterialIds, withBaseMaterialReferences } from './materialReplacement'
import { cloneEditorState, rebaseEditorStateFilamentIds, type EditorState } from './editorModel'

// A minimal scene exercises the independent reference domains without loading a WebGL renderer.
test('replacement covers scene, paint, settings, sequences and preserves the original for undo', () => {
  const state = {
    plates: [{ index: 1, instances: [{ source: { kind: 'object' }, objectId: 10, filamentId: 2, parts: [{ filamentId: 2 }],
      heightRanges: [{ minZ: 0, maxZ: 5, settings: { layer_height: '0.2', extruder: '2' } }] }],
      filamentChanges: [{ z: 2, filamentId: 2 }], firstLayerFilamentSequence: [1, 2, 3] }],
    colorPaint: { '10:0': { 0: '8', 1: '0C' } },
    supportPaint: { '10:0': { 0: '8' } },
    partProcessOverrides: { '10:0': { support_filament: '2' } },
    addedParts: { 10: [{ filamentId: 2, settings: { support_interface_filament: '2' } }] }
  } as unknown as EditorState
  const next = replaceEditorMaterial(state, [1, 2, 3], 2, 3)
  assert.equal(next.plates[0]?.instances[0]?.filamentId, 3)
  assert.equal(next.plates[0]?.instances[0]?.parts[0]?.filamentId, 3)
  assert.equal(next.addedParts?.[10]?.[0]?.filamentId, 3)
  assert.equal(next.partProcessOverrides?.['10:0']?.support_filament, '2')
  assert.equal(next.heightRanges?.[10]?.[0]?.settings.extruder, '2')
  assert.deepEqual(next.plates[0]?.firstLayerFilamentSequence, [1, 3])
  assert.equal(next.plates[0]?.filamentChanges?.[0]?.filamentId, 3)
  assert.equal(next.colorPaint?.['10:0']?.[0], '0C')
  assert.equal(next.supportPaint?.['10:0']?.[0], '8')
  assert.equal(state.plates[0]?.instances[0]?.filamentId, 2)
  assert.equal(state.colorPaint?.['10:0']?.[0], '8')
})

test('unopened plates and subsequent brush strokes remap base paint through chained deletion and save renumbering', () => {
  const first = replaceEditorMaterial({ plates: [] }, [1, 2, 3], 1, 3)
  const second = replaceEditorMaterial(first, [2, 3], 3, 2)
  assert.deepEqual(remapBaseMaterialPaint(second, { 0: '4', 1: '8', 2: '0C' }), { 0: '8', 1: '8', 2: '8' })
  const saved = rebaseEditorStateFilamentIds(second, new Map([[2, 1]]))
  assert.deepEqual(remapBaseMaterialPaint(saved, { 0: '4', 1: '8', 2: '0C' }), { 0: '4', 1: '4', 2: '4' })
})


test('replacement after a saved reorder continues to address the original base slots', () => {
  const reordered = rebaseEditorStateFilamentIds({ plates: [] }, new Map([[3, 1], [1, 2], [2, 3]]))
  const replaced = replaceEditorMaterial(reordered, [1, 2, 3], 2, 3)
  const list = [{ color: '#FFFFFF' }, { color: '#000000' }]
  const firstSave = withBaseMaterialReferences(list, [1, 3], replaced.baseFilamentIds)
  assert.deepEqual(firstSave.map((slot) => slot.replacedSourceIndices), [[2], [0, 1]])
  const saved = rebaseEditorStateFilamentIds(replaced, new Map([[1, 1], [3, 2]]))
  const secondSave = withBaseMaterialReferences(list, [1, 2], saved.baseFilamentIds)
  assert.deepEqual(secondSave, firstSave)
})


test('history clones preserve independent base material mappings for paint and saves', () => {
  const replaced = replaceEditorMaterial({ plates: [] }, [1, 2, 3], 1, 3)
  const restored = cloneEditorState(replaced)
  assert.deepEqual(restored.baseFilamentIds, replaced.baseFilamentIds)
  assert.notEqual(restored.baseFilamentIds, replaced.baseFilamentIds)
  assert.deepEqual(remapBaseMaterialPaint(restored, { 0: '4' }), { 0: '0C' })
  assert.deepEqual(withBaseMaterialReferences([{ color: '#FFFFFF' }, { color: '#000000' }], [2, 3], restored.baseFilamentIds)
    .map((entry) => entry.replacedSourceIndices), [[1], [0, 2]])
})

test('unverified source paint requires confirmation without marking new materials as used', () => {
  assert.deepEqual([...unverifiedSourceMaterialIds([1, 2, 3], undefined, [1, 2, 3, 4])], [1, 2, 3])
  assert.deepEqual([...unverifiedSourceMaterialIds([1, 2, 3], { 1: 2, 2: 1, 3: 2 }, [1, 2, 4])], [2, 1])
  assert.deepEqual([...unverifiedSourceMaterialIds([1, 2], { 1: 2, 2: 2, 3: 2, 4: 1, 5: 2 }, [1, 2])], [2, 1])
  assert.deepEqual([...unverifiedSourceMaterialIds(undefined, undefined, [1, 2])], [1, 2])
  assert.deepEqual([...unverifiedSourceMaterialIds([], undefined, [1, 2])], [])
})


test('default-material imports count as uses and follow a non-first replacement', () => {
  const state = { plates: [{ index: 1, instances: [
    { objectId: 0, source: { kind: 'import', importId: 'stl', replacedObjectId: -1 }, filamentId: null, parts: [] },
    { objectId: 0, source: { kind: 'import', importId: 'step', replacedObjectId: -2 }, filamentId: null,
      parts: [{ filamentId: null }, { filamentId: 2 }, { filamentId: null, subtype: 'negative_part' }] }
  ] }] } as unknown as EditorState
  assert.deepEqual([...sceneObjectMaterialIds(state, [1, 2, 3])], [1, 2])
  const replaced = replaceEditorMaterial(state, [1, 2, 3], 1, 3)
  assert.deepEqual(replaced.plates[0]!.instances.map((instance) => instance.filamentId), [3, 3])
  assert.equal(replaced.plates[0]!.instances[1]!.parts[1]!.filamentId, 2)
  assert.equal(replaced.plates[0]!.instances[1]!.parts[2]!.filamentId, null)
  assert.deepEqual([...sceneObjectMaterialIds(replaced, [2, 3])], [3, 2])
  assert.equal(state.plates[0]!.instances[0]!.filamentId, null)
})

test('save then undo restores original base references independently of rebased template indices', async () => {
  const { rebaseMaterialSlotsSnapshot, buildFilamentSourceRemap } = await import('../../../components/library/useMaterialSlots')
  const { filamentSlotIdRemap } = await import('@printstream/shared/three-mf')
  const before = { sessionSlots: [1, 2, 3].map((id) => ({
    projectFilamentId: id, sourceIndex: id - 1, label: 'PLA', color: '#FFFFFF', nozzleId: null
  })) }
  // Saving the deletion shortens the configuration list, but geometry remains pinned to the
  // original archive. Undo restores a scene from before baseFilamentIds existed.
  const restored = rebaseMaterialSlotsSnapshot(before, buildFilamentSourceRemap([1, 2]))
  const desired = restored.sessionSlots!.map((slot) => ({ color: slot.color!, sourceIndex: slot.sourceIndex ?? 0 }))
  const filaments = withBaseMaterialReferences(desired, [1, 2, 3], undefined)
  assert.deepEqual([...filamentSlotIdRemap(filaments)], [[1, 1], [2, 2], [3, 3]])
  const afterAnotherSave = rebaseMaterialSlotsSnapshot(restored, buildFilamentSourceRemap([0, 1, 2]))
  assert.deepEqual(withBaseMaterialReferences(afterAnotherSave.sessionSlots!.map((slot) => ({
    color: slot.color!, sourceIndex: slot.sourceIndex ?? 0
  })), [1, 2, 3], undefined), filaments)
})


test('an inherited added part retains the chosen default even when all original parts use another material', () => {
  const state = { plates: [{ index: 1, instances: [{ objectId: 10, source: { kind: 'object' },
    filamentId: null, parts: [{ filamentId: 2 }] }] }],
    addedParts: { 10: [{ filamentId: null }] }
  } as unknown as EditorState
  assert.deepEqual([...sceneObjectMaterialIds(state, [1, 2, 3])], [2, 1])
  const replaced = replaceEditorMaterial(state, [1, 2, 3], 1, 3)
  assert.equal(replaced.plates[0]!.instances[0]!.filamentId, 3)
  assert.equal(replaced.addedParts?.[10]?.[0]?.filamentId, null)
  assert.deepEqual([...sceneObjectMaterialIds(replaced, [2, 3])], [2, 3])
})
