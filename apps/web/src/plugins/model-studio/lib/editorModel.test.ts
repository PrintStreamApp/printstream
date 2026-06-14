import assert from 'node:assert/strict'
import test from 'node:test'
import { libraryThreeMfSceneSchema, threeMfIndexSchema, type StagedImport } from '@printstream/shared'
import {
  buildSceneEdit,
  duplicateInstance,
  fillPlateFromScene,
  instanceFromStagedImport,
  seedEditorState,
  seedEmptyEditorState,
  type EditorState
} from './editorModel'

const STAGED: StagedImport = {
  importId: 'imp-1',
  name: 'Bracket.stl',
  format: 'stl',
  triangleCount: 12,
  bounds: { min: { x: -1, y: -1, z: 0 }, max: { x: 1, y: 1, z: 2 } }
}

test('seedEmptyEditorState yields one empty plate', () => {
  const state = seedEmptyEditorState()
  assert.equal(state.plates.length, 1)
  assert.equal(state.plates[0]?.index, 1)
  assert.equal(state.plates[0]?.instances.length, 0)
})

test('instanceFromStagedImport places an import-backed instance at the plate centre', () => {
  const instance = instanceFromStagedImport(STAGED)
  assert.equal(instance.source.kind, 'import')
  assert.equal(instance.source.kind === 'import' && instance.source.importId, 'imp-1')
  assert.equal(instance.name, 'Bracket.stl')
  assert.deepEqual([instance.position.x, instance.position.y, instance.position.z], [0, 0, 0])
  assert.deepEqual([instance.scale.x, instance.scale.y, instance.scale.z], [1, 1, 1])
  assert.equal(instance.parts.length, 0)
})

test('buildSceneEdit emits importId for import-backed instances and objectId otherwise', () => {
  const state: EditorState = seedEmptyEditorState()
  state.plates[0]!.instances.push(instanceFromStagedImport(STAGED))
  // An object-backed instance authored by hand to exercise the other branch.
  const objectInstance = instanceFromStagedImport(STAGED)
  objectInstance.source = { kind: 'object' }
  objectInstance.objectId = 7
  state.plates[0]!.instances.push(objectInstance)

  const edit = buildSceneEdit(state)
  assert.equal(edit.instances.length, 2)

  const [imported, object] = edit.instances
  assert.equal(imported?.importId, 'imp-1')
  assert.equal(imported?.objectId, undefined)
  assert.equal(object?.objectId, 7)
  assert.equal(object?.importId, undefined)
})

test('new instances default to printable and duplicate carries the flag', () => {
  const instance = instanceFromStagedImport(STAGED)
  assert.equal(instance.printable, true)
  instance.printable = false
  assert.equal(duplicateInstance(instance).printable, false)
})

test('buildSceneEdit only emits printable when an instance is skipped', () => {
  const state: EditorState = seedEmptyEditorState()
  const printing = instanceFromStagedImport(STAGED)
  const skipped = instanceFromStagedImport(STAGED)
  skipped.printable = false
  state.plates[0]!.instances.push(printing, skipped)

  const [first, second] = buildSceneEdit(state).instances
  // Printable is the contract default, so it's omitted to keep the SceneEdit lean.
  assert.equal(first?.printable, undefined)
  // A skipped instance carries printable=false so the baker writes printable="0".
  assert.equal(second?.printable, false)
})

const IDENTITY_3MF = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]

const sceneForPlate = (plateIndex: number) => libraryThreeMfSceneSchema.parse({
  plateIndex,
  plateName: null,
  bed: { minX: 0, maxX: 256, minY: 0, maxY: 256, plateType: null },
  parts: [{
    entryPath: '/3D/Objects/object_1.model', objectId: 1, transform: IDENTITY_3MF,
    name: 'Part', sourceFile: null, filamentId: 1, filamentName: null, color: null
  }],
  instances: [{
    objectId: 1, instanceId: 0, name: 'Cube', transform: IDENTITY_3MF,
    filamentId: 1, filamentName: null, color: null,
    parts: [{ entryPath: '/3D/Objects/object_1.model', componentObjectId: 1, transform: IDENTITY_3MF }]
  }]
})

test('seedEditorState seeds plates without a scene empty, and fillPlateFromScene fills them later', () => {
  // The editor seeds as soon as the visible plate's scene is in; other plates arrive later.
  const index = threeMfIndexSchema.parse({
    plates: [1, 2].map((plateIndex) => ({
      index: plateIndex, name: null, hasThumbnail: false, plateType: null,
      nozzleSizes: [], filaments: [], objects: []
    })),
    projectFilaments: [],
    compatiblePrinterModels: []
  })

  const state = seedEditorState(index, new Map([[1, sceneForPlate(1)]]))
  assert.equal(state.plates.length, 2)
  assert.equal(state.plates[0]?.instances.length, 1)
  assert.equal(state.plates[1]?.instances.length, 0)
  // The not-yet-loaded plate borrows the loaded scene's bed (one printer bed per project),
  // so camera framing and zones don't snap from a generic placeholder on first selection.
  assert.equal(state.plates[1]?.bed.maxX, 256)

  const filled = fillPlateFromScene(state.plates[1]!, sceneForPlate(2))
  assert.equal(filled.instances.length, 1)
  assert.equal(filled.instances[0]?.name, 'Cube')
  assert.equal(filled.bed.maxX, 256)
  // The original placeholder plate is left untouched (fill returns a new plate).
  assert.equal(state.plates[1]?.instances.length, 0)
})

test('buildSceneEdit emits support paint only for objects still placed; clone deep-copies it', async () => {
  const { cloneEditorState, supportPaintKey } = await import('./editorModel')
  const state: EditorState = seedEmptyEditorState()
  const placed = instanceFromStagedImport(STAGED)
  placed.source = { kind: 'object' }
  placed.objectId = 3
  state.plates[0]!.instances.push(placed)
  state.supportPaint = {
    [supportPaintKey(3, 1)]: { 0: '4', 5: '8' },
    // Painted earlier, but object 9 no longer has any placed instance.
    [supportPaintKey(9, 1)]: { 2: '4' }
  }
  state.seamPaint = { [supportPaintKey(3, 1)]: { 7: '8' } }

  const edit = buildSceneEdit(state)
  assert.deepEqual(edit.seamPaint, [{ objectId: 3, componentObjectId: 1, triangles: { 7: '8' } }])
  assert.equal(edit.supportPaint?.length, 1)
  assert.deepEqual(edit.supportPaint?.[0], {
    objectId: 3,
    componentObjectId: 1,
    triangles: { 0: '4', 5: '8' }
  })

  // History snapshots are independent of later strokes.
  const snapshot = cloneEditorState(state)
  state.supportPaint[supportPaintKey(3, 1)]![7] = '8'
  assert.deepEqual(snapshot.supportPaint?.[supportPaintKey(3, 1)], { 0: '4', 5: '8' })
})

test('buildSceneEdit omits supportPaint when nothing was painted', () => {
  const state: EditorState = seedEmptyEditorState()
  assert.equal(buildSceneEdit(state).supportPaint, undefined)
})

test('fillPlateFromScene keeps per-instance filaments when objects share a mesh component', () => {
  // Four placed objects all reference the same mesh component but print in different
  // filaments (the scene's parts rows are per-placement). The shared-component lookup
  // must not let the last row win for every copy.
  const scene = libraryThreeMfSceneSchema.parse({
    plateIndex: 1,
    plateName: null,
    bed: { minX: 0, maxX: 256, minY: 0, maxY: 256, plateType: null },
    parts: [1, 2, 4, 3].map((filamentId) => ({
      entryPath: '/3D/Objects/object_3.model', objectId: 3, transform: IDENTITY_3MF,
      name: 'Hex', sourceFile: null, filamentId, filamentName: null, color: `#00000${filamentId}`
    })),
    instances: [
      { objectId: 4, instanceId: 0, name: 'Hex', transform: IDENTITY_3MF, filamentId: 1, filamentName: null, color: '#000001', parts: [{ entryPath: '/3D/Objects/object_3.model', componentObjectId: 3, transform: IDENTITY_3MF }] },
      { objectId: 8, instanceId: 0, name: 'Hex', transform: IDENTITY_3MF, filamentId: 2, filamentName: null, color: '#000002', parts: [{ entryPath: '/3D/Objects/object_3.model', componentObjectId: 3, transform: IDENTITY_3MF }] },
      { objectId: 9, instanceId: 0, name: 'Hex', transform: IDENTITY_3MF, filamentId: 4, filamentName: null, color: '#000004', parts: [{ entryPath: '/3D/Objects/object_3.model', componentObjectId: 3, transform: IDENTITY_3MF }] },
      { objectId: 18, instanceId: 0, name: 'Hex', transform: IDENTITY_3MF, filamentId: 3, filamentName: null, color: '#000003', parts: [{ entryPath: '/3D/Objects/object_3.model', componentObjectId: 3, transform: IDENTITY_3MF }] }
    ]
  })

  const filled = fillPlateFromScene(seedEmptyEditorState().plates[0]!, scene)
  assert.deepEqual(
    filled.instances.map((instance) => instance.parts[0]?.filamentId),
    [1, 2, 4, 3]
  )
  assert.deepEqual(
    filled.instances.map((instance) => instance.parts[0]?.color),
    ['#000001', '#000002', '#000004', '#000003']
  )
})

test('buildSceneEdit emits filament changes only for plates edited this session, sorted by height', () => {
  const state: EditorState = seedEmptyEditorState()
  state.plates[0]!.filamentChanges = [{ z: 5, filamentId: 2 }] // seeded, untouched
  const edit = buildSceneEdit(state)
  assert.equal(edit.filamentChanges, undefined)

  state.plates[0]!.filamentChangesOverride = [{ z: 8, filamentId: 3 }, { z: 2.4, filamentId: 1 }]
  const edited = buildSceneEdit(state)
  assert.deepEqual(edited.filamentChanges, [
    { plateIndex: 1, changes: [{ z: 2.4, filamentId: 1 }, { z: 8, filamentId: 3 }] }
  ])

  // Edited-to-empty clears the plate's changes (emitted as an empty list).
  state.plates[0]!.filamentChangesOverride = []
  assert.deepEqual(buildSceneEdit(state).filamentChanges, [{ plateIndex: 1, changes: [] }])
})

test('buildSceneEdit emits added parts only for placed objects; clone keeps them independent', async () => {
  const THREE = await import('three')
  const { cloneEditorState } = await import('./editorModel')
  const state: EditorState = seedEmptyEditorState()
  const placed = instanceFromStagedImport(STAGED)
  placed.source = { kind: 'object' }
  placed.objectId = 3
  state.plates[0]!.instances.push(placed)
  state.addedParts = {
    3: [{
      key: 'p1',
      importId: 'part-imp-1',
      subtype: 'negative_part',
      name: 'Hole punch',
      position: new THREE.Vector3(5, 6, 7),
      rotation: new THREE.Euler(0, 0, 0),
      scale: new THREE.Vector3(1, 1, 1),
      soup: new Float32Array(9)
    }],
    // Added earlier, but object 9 no longer has any placed instance.
    9: [{
      key: 'p2',
      importId: 'part-imp-2',
      subtype: 'modifier_part',
      name: 'Modifier',
      position: new THREE.Vector3(),
      rotation: new THREE.Euler(),
      scale: new THREE.Vector3(1, 1, 1),
      soup: new Float32Array(9)
    }]
  }

  const edit = buildSceneEdit(state)
  assert.equal(edit.addedParts?.length, 1)
  assert.deepEqual(edit.addedParts?.[0], {
    objectId: 3,
    importId: 'part-imp-1',
    subtype: 'negative_part',
    name: 'Hole punch',
    matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1, 5, 6, 7]
  })

  // Snapshots are independent of later gizmo moves.
  const snapshot = cloneEditorState(state)
  state.addedParts[3]![0]!.position.set(99, 0, 0)
  assert.equal(snapshot.addedParts?.[3]?.[0]?.position.x, 5)

  // No added parts -> the field is omitted entirely.
  assert.equal(buildSceneEdit(seedEmptyEditorState()).addedParts, undefined)
})
