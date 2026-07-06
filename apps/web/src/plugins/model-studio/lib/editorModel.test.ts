import assert from 'node:assert/strict'
import test from 'node:test'
import { libraryThreeMfSceneSchema, threeMfIndexSchema, type StagedImport } from '@printstream/shared'
import * as THREE from 'three'
import {
  buildSceneEdit,
  decomposeInstanceTransform,
  exactTransformIfShearing,
  duplicateInstance,
  fillPlateFromScene,
  instanceFromStagedImport,
  replaceInstanceGeometry,
  seedEditorState,
  seedEmptyEditorState,
  type EditorState
} from './editorModel'

const BOUNDS = { min: { x: -1, y: -1, z: 0 }, max: { x: 1, y: 1, z: 2 } }

const STAGED: StagedImport = {
  importId: 'imp-1',
  name: 'Bracket.stl',
  format: 'stl',
  triangleCount: 12,
  bounds: BOUNDS,
  parts: [{ name: 'Bracket.stl', triangleCount: 12, bounds: BOUNDS }]
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

test('instanceFromStagedImport carries a multi-solid import as one instance with named parts', () => {
  const multi: StagedImport = {
    importId: 'imp-2',
    name: 'CHM Cylinder',
    format: 'step',
    triangleCount: 20,
    bounds: BOUNDS,
    parts: [
      { name: 'Cylinder', triangleCount: 12, bounds: BOUNDS },
      { name: 'Hole modifier 1', triangleCount: 8, bounds: BOUNDS }
    ]
  }
  const instance = instanceFromStagedImport(multi)
  assert.equal(instance.parts.length, 2)
  assert.deepEqual(instance.parts.map((part) => part.name), ['Cylinder', 'Hole modifier 1'])
  assert.deepEqual(instance.parts.map((part) => part.componentObjectId), [0, 1])
})

const MULTI: StagedImport = {
  importId: 'imp-3',
  name: 'CHM Cylinder',
  format: 'step',
  triangleCount: 20,
  bounds: BOUNDS,
  parts: [
    { name: 'Cylinder', triangleCount: 12, bounds: BOUNDS },
    { name: 'Hole modifier 1', triangleCount: 8, bounds: BOUNDS }
  ]
}

test('a fresh import gets a synthetic (negative) object identity for pre-save per-object editing', () => {
  const instance = instanceFromStagedImport(MULTI)
  const id = instance.source.kind === 'import' ? instance.source.replacedObjectId : null
  assert.ok(id != null && id < 0, 'fresh import should carry a negative synthetic object id')
})

test('buildSceneEdit emits per-part filament + a meshReplacements entry for a multi-solid import', () => {
  const state: EditorState = seedEmptyEditorState()
  const instance = instanceFromStagedImport(MULTI)
  const syntheticId = instance.source.kind === 'import' ? instance.source.replacedObjectId : null
  // Assign the second solid its own material (what the per-part filament badge does).
  instance.parts[1]!.filamentId = 2
  state.plates[0]!.instances.push(instance)

  const edit = buildSceneEdit(state)
  assert.deepEqual(edit.importPartFilaments, [{ importId: 'imp-3', partIndex: 1, filamentId: 2 }])
  // The synthetic identity rides along as a meshReplacements entry so per-object process
  // overrides authored against it re-key onto the baked object at slice time.
  assert.deepEqual(edit.meshReplacements, [{ objectId: syntheticId, importId: 'imp-3' }])
})

test('buildSceneEdit routes part-type changes to partTypeChanges (objects) and importPartTypes (imports)', () => {
  const state: EditorState = seedEmptyEditorState()
  // An unsaved multi-solid import whose second solid was retyped to a modifier.
  const imported = instanceFromStagedImport(MULTI)
  const syntheticId = imported.source.kind === 'import' ? imported.source.replacedObjectId : null
  state.plates[0]!.instances.push(imported)
  // An in-project object whose part 5 was retyped to a support blocker.
  const objectInstance = instanceFromStagedImport(STAGED)
  objectInstance.source = { kind: 'object' }
  objectInstance.objectId = 7
  state.plates[0]!.instances.push(objectInstance)
  state.partTypeChanges = {
    [`${syntheticId}:1`]: 'modifier_part',
    '7:5': 'support_blocker',
    // A change on an object no longer placed must not be emitted.
    '99:1': 'negative_part'
  }

  const edit = buildSceneEdit(state)
  assert.deepEqual(edit.partTypeChanges, [{ objectId: 7, componentObjectId: 5, subtype: 'support_blocker' }])
  assert.deepEqual(edit.importPartTypes, [{ importId: 'imp-3', partIndex: 1, subtype: 'modifier_part' }])
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

test('decomposeInstanceTransform round-trips a rotated, non-uniformly scaled object (T·S·R)', () => {
  // Build the matrix the editor itself renders/emits: world = T · S · R (scale outside rotation).
  const position = new THREE.Vector3(10, -20, 3)
  const rotation = new THREE.Euler(0.3, -0.7, 0.5, 'XYZ')
  const scale = new THREE.Vector3(2, 1, 0.5) // non-uniform + rotation = the case that used to shear
  const m = new THREE.Matrix4()
    .makeTranslation(position.x, position.y, position.z)
    .multiply(new THREE.Matrix4().makeScale(scale.x, scale.y, scale.z))
    .multiply(new THREE.Matrix4().makeRotationFromEuler(rotation))
  const e = m.elements
  const transform = [e[0]!, e[1]!, e[2]!, e[4]!, e[5]!, e[6]!, e[8]!, e[9]!, e[10]!, e[12]!, e[13]!, e[14]!]

  const decomposed = decomposeInstanceTransform(transform)
  // Recompose the editor's way and confirm it reproduces the original matrix exactly.
  const round = new THREE.Matrix4()
    .makeTranslation(decomposed.position.x, decomposed.position.y, decomposed.position.z)
    .multiply(new THREE.Matrix4().makeScale(decomposed.scale.x, decomposed.scale.y, decomposed.scale.z))
    .multiply(new THREE.Matrix4().makeRotationFromEuler(decomposed.rotation))
  let maxErr = 0
  for (let i = 0; i < 16; i++) maxErr = Math.max(maxErr, Math.abs((round.elements[i] ?? 0) - (m.elements[i] ?? 0)))
  assert.ok(maxErr < 1e-9, `T·S·R round-trip error ${maxErr}`)
})

function transform12(m: THREE.Matrix4): number[] {
  const e = m.elements
  return [e[0]!, e[1]!, e[2]!, e[4]!, e[5]!, e[6]!, e[8]!, e[9]!, e[10]!, e[12]!, e[13]!, e[14]!]
}

test('exactTransformIfShearing flags a foreign T·R·S (rotate+non-uniform) matrix but not the editor\'s T·S·R', () => {
  const pos = new THREE.Vector3(5, -3, 1)
  const rot = new THREE.Euler(0.2, 0.6, -0.4, 'XYZ')
  const nonUniform = new THREE.Vector3(2, 1, 0.5)
  // Foreign Bambu convention: T·R·S (scale inside rotation) — shears relative to the editor's T·S·R.
  const foreign = new THREE.Matrix4()
    .makeTranslation(pos.x, pos.y, pos.z)
    .multiply(new THREE.Matrix4().makeRotationFromEuler(rot))
    .multiply(new THREE.Matrix4().makeScale(nonUniform.x, nonUniform.y, nonUniform.z))
  assert.ok(exactTransformIfShearing(transform12(foreign)) !== undefined, 'foreign T·R·S should be kept exact')

  // The editor's own convention: T·S·R — reproducible from TRS, so no exact matrix needed.
  const own = new THREE.Matrix4()
    .makeTranslation(pos.x, pos.y, pos.z)
    .multiply(new THREE.Matrix4().makeScale(nonUniform.x, nonUniform.y, nonUniform.z))
    .multiply(new THREE.Matrix4().makeRotationFromEuler(rot))
  assert.equal(exactTransformIfShearing(transform12(own)), undefined)

  // Uniform scale + rotation is representable either way — no exact matrix.
  const uniform = new THREE.Matrix4()
    .makeTranslation(pos.x, pos.y, pos.z)
    .multiply(new THREE.Matrix4().makeRotationFromEuler(rot))
    .multiply(new THREE.Matrix4().makeScale(2, 2, 2))
  assert.equal(exactTransformIfShearing(transform12(uniform)), undefined)
})

test('buildSceneEdit emits an instance\'s exact matrix verbatim', () => {
  const state: EditorState = seedEmptyEditorState()
  const exact = [0.5, 0.1, 0, 0.2, 1.3, 0, 0, 0, 0.8, 10, 20, 0]
  const instance = instanceFromStagedImport(STAGED)
  instance.source = { kind: 'object' }
  instance.objectId = 7
  instance.exactMatrix = [...exact]
  state.plates[0]!.instances.push(instance)
  const emitted = buildSceneEdit(state).instances[0]
  assert.deepEqual(emitted?.matrix, exact)
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

test('replaceInstanceGeometry retains placement, material, printability, name and object identity', () => {
  // A placed, transformed object-backed instance with a material, a skip flag, and a name.
  const source = instanceFromStagedImport(STAGED)
  source.source = { kind: 'object' }
  source.objectId = 9
  source.name = 'Left bracket'
  source.position.set(40, -20, 0)
  source.rotation.set(0, 0, Math.PI / 2)
  source.scale.set(1.5, 1.5, 1.5)
  source.filamentId = 3
  source.printable = false
  source.parts = [{ entryPath: '/x.model', componentObjectId: 2, transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], filamentId: 3, name: 'p', color: null, subtype: null }]

  const replacement: StagedImport = { ...STAGED, importId: 'imp-2', name: 'Gear.stl' }
  const next = replaceInstanceGeometry(source, replacement, 9)

  // Geometry switches to the staged import; old in-project parts are dropped, but the
  // replaced object's identity is retained for the slicer via replacedObjectId.
  assert.equal(next.source.kind, 'import')
  assert.equal(next.source.kind === 'import' && next.source.importId, 'imp-2')
  assert.equal(next.source.kind === 'import' && next.source.replacedObjectId, 9)
  assert.equal(next.parts.length, 0)
  assert.notEqual(next.key, source.key)
  // BambuStudio "Replace with…": placement/orientation/scale, material, printability AND
  // the object's name are kept; only the geometry changes.
  assert.deepEqual([next.position.x, next.position.y, next.position.z], [40, -20, 0])
  assert.equal(next.rotation.z, Math.PI / 2)
  assert.deepEqual([next.scale.x, next.scale.y, next.scale.z], [1.5, 1.5, 1.5])
  assert.equal(next.filamentId, 3)
  assert.equal(next.printable, false)
  assert.equal(next.name, 'Left bracket')
  assert.equal(next.nameOverridden, true)
  // The source instance is left untouched (replacement returns a fresh instance).
  assert.equal(source.source.kind, 'object')
})

test('buildSceneEdit emits meshReplacements and a name override for a replaced object', () => {
  const state: EditorState = seedEmptyEditorState()
  const original = instanceFromStagedImport(STAGED)
  original.source = { kind: 'object' }
  original.objectId = 9
  original.name = 'Left bracket'
  const replaced = replaceInstanceGeometry(original, { ...STAGED, importId: 'imp-2', name: 'Gear.stl' }, 9)
  state.plates[0]!.instances.push(replaced)

  const edit = buildSceneEdit(state)
  // The instance is import-backed (geometry comes from the import)...
  assert.equal(edit.instances[0]?.importId, 'imp-2')
  assert.equal(edit.instances[0]?.objectId, undefined)
  // ...and the replacement provenance + retained name travel alongside it.
  assert.deepEqual(edit.meshReplacements, [{ objectId: 9, importId: 'imp-2' }])
  assert.deepEqual(edit.objectNames, [{ importId: 'imp-2', name: 'Left bracket' }])
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

test('buildSceneEdit emits layer pauses only for plates edited this session, sorted by height', () => {
  const state: EditorState = seedEmptyEditorState()
  state.plates[0]!.pauses = [{ z: 5 }] // seeded, untouched
  const edit = buildSceneEdit(state)
  assert.equal(edit.pauses, undefined)

  state.plates[0]!.pausesOverride = [{ z: 12.4 }, { z: 3.2 }]
  const edited = buildSceneEdit(state)
  assert.deepEqual(edited.pauses, [{ plateIndex: 1, pauses: [{ z: 3.2 }, { z: 12.4 }] }])

  // Edited-to-empty clears the plate's pauses (emitted as an empty list).
  state.plates[0]!.pausesOverride = []
  assert.deepEqual(buildSceneEdit(state).pauses, [{ plateIndex: 1, pauses: [] }])
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
