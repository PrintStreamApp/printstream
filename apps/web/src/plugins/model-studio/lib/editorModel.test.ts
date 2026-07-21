import assert from 'node:assert/strict'
import test from 'node:test'
import { libraryThreeMfSceneSchema, threeMfIndexSchema, type StagedImport } from '@printstream/shared'
import * as THREE from 'three'
import {
  addedPartHostId,
  buildSceneEdit,
  makeInstanceIndependent,
  buildSingleObjectExportState,
  cloneEditorState,
  dropAddedPartsForReplacedHost,
  deriveObjectFilamentId,
  decomposeInstanceTransform,
  exactTransformIfShearing,
  duplicateInstance,
  fillPlateFromScene,
  instanceFromStagedImport,
  isObjectMarkedForRepair,
  printedParts,
  replaceInstanceGeometry,
  findFreePlatePosition,
  seedEditorState,
  seedEmptyEditorState,
  stagedFootprint,
  summarizeInstanceMaterial,
  type EditorState
} from './editorModel'

const BOUNDS = { min: { x: -1, y: -1, z: 0 }, max: { x: 1, y: 1, z: 2 } }

const STAGED: StagedImport = {
  importId: 'imp-1',
  name: 'Bracket.stl',
  format: 'stl',
  triangleCount: 12,
  bounds: BOUNDS,
  parts: [{ name: 'Bracket.stl', triangleCount: 12, bounds: BOUNDS, subtype: null }]
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
      { name: 'Cylinder', triangleCount: 12, bounds: BOUNDS, subtype: null },
      { name: 'Hole modifier 1', triangleCount: 8, bounds: BOUNDS, subtype: null }
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
    { name: 'Cylinder', triangleCount: 12, bounds: BOUNDS, subtype: null },
    { name: 'Hole modifier 1', triangleCount: 8, bounds: BOUNDS, subtype: null }
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

test('buildSceneEdit emits partTransforms for placed objects only, and cloneEditorState copies them', () => {
  const state: EditorState = seedEmptyEditorState()
  const objectInstance = instanceFromStagedImport(STAGED)
  objectInstance.source = { kind: 'object' }
  objectInstance.objectId = 7
  state.plates[0]!.instances.push(objectInstance)
  const matrix = [1, 0, 0, 0, 1, 0, 0, 0, 2, 10, 4, 2]
  state.partTransforms = {
    '7:5': matrix,
    // A change on an object no longer placed must not be emitted.
    '99:1': [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
  }

  const edit = buildSceneEdit(state)
  assert.deepEqual(edit.partTransforms, [{ objectId: 7, componentObjectId: 5, matrix }])

  // History snapshots must not share the live matrix arrays.
  const clone = cloneEditorState(state)
  assert.deepEqual(clone.partTransforms?.['7:5'], matrix)
  assert.notEqual(clone.partTransforms?.['7:5'], matrix)
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
    meshImportId: 'part-imp-1',
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

test('an added part on an UNSAVED import emits its host as an importId', () => {
  const state: EditorState = seedEmptyEditorState()
  const imported = instanceFromStagedImport(STAGED)
  state.plates[0]!.instances.push(imported)
  const hostId = addedPartHostId(imported)
  assert.ok(hostId != null, 'a fresh import has a synthetic host identity')
  assert.ok(hostId < 0, 'that identity is synthetic (negative), never a real 3MF object id')

  state.addedParts = {
    [hostId]: [{
      key: 'p1',
      importId: 'part-imp-1',
      subtype: 'support_blocker',
      name: 'Support blocker',
      position: new THREE.Vector3(1, 2, 3),
      rotation: new THREE.Euler(),
      scale: new THREE.Vector3(1, 1, 1),
      soup: new Float32Array(9)
    }]
  }

  // The host is addressed by importId, NOT by the synthetic object id (which means nothing
  // server-side) and not by objectId 0 — the bake resolves it through importIdToObjectId.
  assert.deepEqual(buildSceneEdit(state).addedParts, [{
    importId: 'imp-1',
    meshImportId: 'part-imp-1',
    subtype: 'support_blocker',
    name: 'Support blocker',
    matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 2, 3]
  }])
})

test('an added part ships a filament only when its subtype carries one', () => {
  const state: EditorState = seedEmptyEditorState()
  const placed = instanceFromStagedImport(STAGED)
  placed.source = { kind: 'object' }
  placed.objectId = 4
  state.plates[0]!.instances.push(placed)
  const part = {
    key: 'p1',
    importId: 'part-imp-1',
    subtype: 'normal_part' as const,
    name: 'Boss',
    filamentId: 2,
    position: new THREE.Vector3(),
    rotation: new THREE.Euler(),
    scale: new THREE.Vector3(1, 1, 1),
    soup: new Float32Array(9)
  }
  state.addedParts = { 4: [part] }
  assert.equal(buildSceneEdit(state).addedParts?.[0]?.filamentId, 2)

  // A support blocker has no meaningful material: a filament left over from an earlier type
  // must not reach the bake, or the baked <part> would carry a stale extruder.
  state.addedParts[4]![0]!.subtype = 'support_blocker'
  assert.equal(buildSceneEdit(state).addedParts?.[0]?.filamentId, undefined)

  // The clone carries it so undo/redo of a type change restores the material.
  state.addedParts[4]![0]!.subtype = 'normal_part'
  assert.equal(cloneEditorState(state).addedParts?.[4]?.[0]?.filamentId, 2)
})

test('replacing a model forgets its added parts rather than reattaching them to the new mesh', () => {
  const state: EditorState = seedEmptyEditorState()
  const object = instanceFromStagedImport(STAGED)
  object.source = { kind: 'object' }
  object.objectId = 7
  state.plates[0]!.instances.push(object)
  state.addedParts = {
    7: [{
      key: 'p1',
      importId: 'part-imp-1',
      subtype: 'support_blocker',
      name: 'Support blocker',
      position: new THREE.Vector3(),
      rotation: new THREE.Euler(),
      scale: new THREE.Vector3(1, 1, 1),
      soup: new Float32Array(9)
    }]
  }

  // The replacement RETAINS object 7's identity, which is the same key addedParts uses — so
  // without the explicit drop the old shape's blocker would silently ride onto the new mesh.
  dropAddedPartsForReplacedHost(state, object)
  const replacement = replaceInstanceGeometry(object, { ...STAGED, importId: 'imp-2' }, 7)
  state.plates[0]!.instances = [replacement]
  assert.equal(addedPartHostId(replacement), 7)
  assert.equal(buildSceneEdit(state).addedParts, undefined)
})

test('the single-object export centres by the rendered footprint, not by the instance origin', () => {
  const state: EditorState = seedEmptyEditorState()
  const object = instanceFromStagedImport(STAGED)
  object.source = { kind: 'object' }
  object.objectId = 5
  // A Bambu object routinely carries plate coordinates in its MESH with a near-origin transform:
  // the placement reads (10, 10) while the geometry actually sits around (40, 30).
  object.position.set(10, 10, 0)
  const plate = state.plates[0]!
  plate.bed = { minX: 0, maxX: 200, minY: 0, maxY: 200, excludeAreas: [] }
  plate.instances.push(object)

  const exported = buildSingleObjectExportState(state, object.key, { x: 40, y: 30 })
  const placed = exported?.plates[0]?.instances[0]
  // Shifted by (bedCentre - footprintCentre) = (100-40, 100-30), so the GEOMETRY lands centred.
  // Assigning the bed centre to `position` (the old behaviour) would have put it at (100, 100),
  // leaving the mesh at (130, 120) — the half-off-the-bed export.
  assert.equal(placed?.position.x, 70)
  assert.equal(placed?.position.y, 80)

  // With no rendered group the placement is left alone rather than guessed.
  const unmeasured = buildSingleObjectExportState(state, object.key)
  assert.equal(unmeasured?.plates[0]?.instances[0]?.position.x, 10)
})

test('a moved sub-part of an unsaved import emits importPartTransforms, not partTransforms', () => {
  const state: EditorState = seedEmptyEditorState()
  const imported = instanceFromStagedImport({
    ...STAGED,
    parts: [
      { name: 'Body', triangleCount: 12, bounds: BOUNDS, subtype: null },
      { name: 'Boss', triangleCount: 8, bounds: BOUNDS, subtype: null }
    ]
  })
  state.plates[0]!.instances.push(imported)
  const hostId = addedPartHostId(imported)
  assert.ok(hostId != null)

  // The part gizmo writes through the SAME state map for both kinds; only the emit differs.
  state.partTransforms = { [`${hostId}:1`]: [1, 0, 0, 0, 1, 0, 0, 0, 1, 3, 4, 5] }
  const edit = buildSceneEdit(state)
  assert.deepEqual(edit.importPartTransforms, [
    { importId: 'imp-1', partIndex: 1, matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1, 3, 4, 5] }
  ])
  // partTransforms addresses baked 3MF object ids, which an unsaved import does not have — the
  // move would be silently dropped if it went out that way.
  assert.equal(edit.partTransforms, undefined)
})

test('an independent copy gets its own identity and inherits the source session edits', () => {
  const state: EditorState = seedEmptyEditorState()
  const source = instanceFromStagedImport(STAGED)
  source.source = { kind: 'object' }
  source.objectId = 3
  const copy = duplicateInstance(source)
  state.plates[0]!.instances.push(source, copy)
  // Session edits made on the source BEFORE the copy: the copy must start identical.
  state.supportPaint = { '3:11': { 0: '8' } }
  state.partTypeChanges = { '3:11': 'support_blocker' }

  makeInstanceIndependent(state, copy)

  // A linked copy shares objectId 3; an independent one gets a negative placeholder the bake
  // resolves into a brand-new object.
  assert.ok(copy.objectId < 0)
  assert.notEqual(copy.objectId, source.objectId)
  assert.equal(state.objectClones?.[copy.objectId], 3)
  // The source keeps its edits and the copy has its own re-keyed set, so they diverge from here.
  assert.deepEqual(state.supportPaint['3:11'], { 0: '8' })
  assert.deepEqual(state.supportPaint[`${copy.objectId}:11`], { 0: '8' })
  assert.equal(state.partTypeChanges[`${copy.objectId}:11`], 'support_blocker')

  const edit = buildSceneEdit(state)
  assert.deepEqual(edit.objectClones, [{ objectId: copy.objectId, sourceObjectId: 3 }])
  // Component ids stay the SOURCE's — the bake's clone pre-pass remaps them onto the copy's parts.
  assert.ok(edit.partTypeChanges?.some((entry) => entry.objectId === copy.objectId && entry.componentObjectId === 11))

  // Deleting the copy must not ship a dangling clone (the bake rejects one).
  state.plates[0]!.instances = [source]
  assert.equal(buildSceneEdit(state).objectClones, undefined)
})

test('a SINGLE-solid import (an added cube) emits its paint as solid 0', () => {
  const state: EditorState = seedEmptyEditorState()
  // A primitive / plain STL stages as ONE solid, so `parts` is empty — the case that made painting
  // an added cube silently do nothing.
  const cube = instanceFromStagedImport(STAGED)
  assert.equal(cube.parts.length, 0, 'a single-solid import carries no part rows')
  state.plates[0]!.instances.push(cube)
  const hostId = addedPartHostId(cube)
  assert.ok(hostId != null)

  state.supportPaint = { [`${hostId}:0`]: { 0: '8', 3: '4' } }
  const edit = buildSceneEdit(state)
  assert.deepEqual(edit.importPaint, [
    { importId: 'imp-1', partIndex: 0, channel: 'support', triangles: { '0': '8', '3': '4' } }
  ])
  // It must NOT also emit as object paint — an unsaved import has no baked object to address.
  assert.equal(edit.supportPaint, undefined)
})

test('buildSceneEdit emits repairedObjectIds for a marked, placed object', () => {
  const state: EditorState = seedEmptyEditorState()
  const object = instanceFromStagedImport(STAGED)
  object.source = { kind: 'object' }
  object.objectId = 12
  state.plates[0]!.instances.push(object)
  state.repairedObjectIds = [12]

  assert.equal(isObjectMarkedForRepair(state, 12), true)
  assert.equal(isObjectMarkedForRepair(state, 99), false)
  assert.deepEqual(buildSceneEdit(state).repairedObjectIds, [12])
})

test('buildSceneEdit drops a repair mark whose object is gone or was replaced', () => {
  // Marked but never placed (e.g. the object was deleted after marking): no dangling repair.
  const orphaned: EditorState = seedEmptyEditorState()
  orphaned.repairedObjectIds = [12]
  assert.equal(buildSceneEdit(orphaned).repairedObjectIds, undefined)

  // Marked, then replaced: the baked geometry is now the import, not the mesh the mark meant.
  const replacedState: EditorState = seedEmptyEditorState()
  const original = instanceFromStagedImport(STAGED)
  original.source = { kind: 'object' }
  original.objectId = 12
  replacedState.plates[0]!.instances.push(replaceInstanceGeometry(original, { ...STAGED, importId: 'imp-2' }, 12))
  replacedState.repairedObjectIds = [12]
  assert.equal(buildSceneEdit(replacedState).repairedObjectIds, undefined)
})

test('cloneEditorState snapshots repair marks so undo restores them', () => {
  const state: EditorState = seedEmptyEditorState()
  state.repairedObjectIds = [12]
  const snapshot = cloneEditorState(state)
  state.repairedObjectIds.push(13)
  assert.deepEqual(snapshot.repairedObjectIds, [12], 'the snapshot must not alias the live array')
})

test('cloneEditorState keeps the rename flag so undo (and exports) preserve renames', () => {
  const state: EditorState = seedEmptyEditorState()
  const renamed = instanceFromStagedImport(STAGED)
  renamed.source = { kind: 'object' }
  renamed.objectId = 4
  renamed.name = 'Better name'
  renamed.nameOverridden = true
  state.plates[0]!.instances.push(renamed)
  const snapshot = cloneEditorState(state)
  assert.equal(snapshot.plates[0]?.instances[0]?.nameOverridden, true)
  assert.deepEqual(buildSceneEdit(snapshot).objectNames, [{ objectId: 4, name: 'Better name' }])
})

test('buildSingleObjectExportState isolates one object on a fresh single plate', () => {
  const state: EditorState = seedEmptyEditorState()
  const kept = instanceFromStagedImport(STAGED)
  kept.source = { kind: 'object' }
  kept.objectId = 7
  state.plates[0]!.instances.push(kept)
  const exportedSource = instanceFromStagedImport({ ...STAGED, importId: 'imp-9' })
  exportedSource.source = { kind: 'object' }
  exportedSource.objectId = 8
  exportedSource.position.set(30, 40, 0)
  state.plates.push({
    index: 2,
    name: 'Plate two',
    plateType: null,
    bed: { minX: 0, maxX: 200, minY: 0, maxY: 180, excludeAreas: [] },
    instances: [exportedSource],
    primeTower: null,
    filamentChanges: [{ z: 5, filamentId: 2 }],
    pauses: [{ z: 3 }]
  })
  state.repairedObjectIds = [7, 8]

  // Its geometry sits where its placement says (an origin-centred mesh), so centring is a plain
  // shift of the placement onto the bed centre.
  const out = buildSingleObjectExportState(state, exportedSource.key, { x: 30, y: 40 })
  assert.ok(out)
  assert.equal(out.plates.length, 1)
  const plate = out.plates[0]!
  assert.equal(plate.index, 1)
  assert.equal(plate.name, null)
  assert.equal(plate.filamentChanges, undefined)
  assert.equal(plate.pauses, undefined)
  assert.equal(plate.instances.length, 1)
  const exported = plate.instances[0]!
  assert.equal(exported.objectId, 8)
  // Centred on the plate's bed (bed centre, not origin).
  assert.deepEqual([exported.position.x, exported.position.y], [100, 90])
  // Session maps carry over wholesale; buildSceneEdit's collectors prune to the export.
  const edit = buildSceneEdit(out)
  assert.equal(edit.instances.length, 1)
  assert.equal(edit.instances[0]?.plateIndex, 1)
  assert.deepEqual(edit.repairedObjectIds, [8])
  // The live state is untouched (deep copy).
  assert.deepEqual([exportedSource.position.x, exportedSource.position.y], [30, 40])
  assert.equal(state.plates.length, 2)
})

test('buildSingleObjectExportState recentres a shearing instance through its exact matrix', () => {
  const state: EditorState = seedEmptyEditorState()
  const sheared = instanceFromStagedImport(STAGED)
  sheared.source = { kind: 'object' }
  sheared.objectId = 5
  sheared.position.set(7, 8, 0)
  sheared.exactMatrix = [1, 0, 0, 0.5, 1, 0, 0, 0, 1, 7, 8, 0]
  state.plates[0]!.bed = { minX: -100, maxX: 100, minY: -90, maxY: 90, excludeAreas: [] }
  state.plates[0]!.instances.push(sheared)

  const out = buildSingleObjectExportState(state, sheared.key, { x: 7, y: 8 })
  assert.ok(out)
  const exported = out.plates[0]!.instances[0]!
  // Translation rewritten in place; the shear column survives.
  assert.deepEqual(exported.exactMatrix?.slice(9), [0, 0, 0])
  const edit = buildSceneEdit(out)
  assert.deepEqual(edit.instances[0]?.matrix?.slice(9), [0, 0, 0])
  assert.equal(edit.instances[0]?.matrix?.[3], 0.5)
  // The live instance's matrix is untouched.
  assert.deepEqual(sheared.exactMatrix.slice(9), [7, 8, 0])
})

test('buildSingleObjectExportState returns null for an unplaced key', () => {
  assert.equal(buildSingleObjectExportState(seedEmptyEditorState(), 'missing'), null)
})

test('deriveObjectFilamentId keeps the object fallback stable unless every part agrees', () => {
  const parts = (...ids: Array<number | null>) => ids.map((filamentId) => ({ filamentId }))
  // Uniform parts (e.g. a whole-object reassignment) adopt the common material.
  assert.equal(deriveObjectFilamentId(parts(2, 2, 2), 1), 2)
  // A single-part object tracks its one part.
  assert.equal(deriveObjectFilamentId(parts(3), 1), 3)
  // Diverging parts keep the prior object default rather than snapping to part[0].
  assert.equal(deriveObjectFilamentId(parts(1, 2, 2), 2), 2)
  // THE regression: object set to 2, then part[0] retargeted to 1 while later parts are still
  // unassigned. Deriving from part[0] would drop the fallback to 1 and collapse every unassigned
  // part onto it at bake time ("everything became material 1"); consensus keeps the fallback at 2.
  assert.equal(deriveObjectFilamentId(parts(1, null, null), 2), 2)
  // No parts / empty keeps the previous value.
  assert.equal(deriveObjectFilamentId(parts(), 2), 2)
})

test('reassigning one part of a multi-solid import leaves the object fallback material intact', () => {
  // End-to-end guard for the fresh-assembly first-save regression, exercising the SAME rule the
  // EditorView reassignFilament handler applies: whole object -> filament 2 (every part), then the
  // second solid -> filament 1. The object's fallback (instance.filamentId) must stay 2 so the
  // unassigned-in-bake solids don't collapse onto the retargeted part.
  const state: EditorState = seedEmptyEditorState()
  const instance = instanceFromStagedImport(MULTI)
  state.plates[0]!.instances.push(instance)
  // 1) Whole-object change: reassignFilament targets EVERY part -> all become 2.
  instance.parts = instance.parts.map((part) => ({ ...part, filamentId: 2 }))
  instance.filamentId = deriveObjectFilamentId(instance.parts, instance.filamentId)
  assert.equal(instance.filamentId, 2)
  // 2) Retarget only the second solid to 1.
  instance.parts = instance.parts.map((part, i) => (i === 1 ? { ...part, filamentId: 1 } : part))
  instance.filamentId = deriveObjectFilamentId(instance.parts, instance.filamentId)
  assert.equal(instance.filamentId, 2, 'object fallback stays 2, not the retargeted part\'s 1')

  const edit = buildSceneEdit(state)
  const byPart = new Map((edit.importPartFilaments ?? []).map((entry) => [entry.partIndex, entry.filamentId]))
  assert.equal(byPart.get(0), 2)
  assert.equal(byPart.get(1), 1)
  assert.equal(edit.instances[0]?.filamentId, 2)
})

test('stagedFootprint reports an import\'s XY centre and size from its file-coordinate bounds', () => {
  const staged: StagedImport = {
    ...STAGED,
    // Sits in the positive octant (origin at a corner), like a typical STL/STEP export.
    bounds: { min: { x: 10, y: 4, z: 0 }, max: { x: 50, y: 24, z: 8 } }
  }
  assert.deepEqual(stagedFootprint(staged), { center: { x: 30, y: 14 }, size: { width: 40, depth: 20 } })
})

test('findFreePlatePosition keeps a large model on the bed and clear of what is already placed', () => {
  const plate = seedEmptyEditorState().plates[0]!
  plate.bed = { minX: 0, maxX: 200, minY: 0, maxY: 200, excludeAreas: [] }
  // A 60x60 model already occupies the plate centre.
  const occupied = [{ minX: 70, maxX: 130, minY: 70, maxY: 130 }]
  const size = { width: 60, depth: 60 }
  const spot = findFreePlatePosition(plate, { size, occupied, gapMm: 6 })
  // Fully on the bed...
  assert.ok(spot.x - 30 >= 0 && spot.x + 30 <= 200, `x on bed: ${JSON.stringify(spot)}`)
  assert.ok(spot.y - 30 >= 0 && spot.y + 30 <= 200, `y on bed: ${JSON.stringify(spot)}`)
  // ...and clear of the occupant (separated on at least one axis, gap included).
  const clearX = spot.x - 30 - 6 >= 130 || spot.x + 30 + 6 <= 70
  const clearY = spot.y - 30 - 6 >= 130 || spot.y + 30 + 6 <= 70
  assert.ok(clearX || clearY, `overlaps the placed model: ${JSON.stringify(spot)}`)
})

test('findFreePlatePosition centres the first model on an empty plate', () => {
  const plate = seedEmptyEditorState().plates[0]!
  plate.bed = { minX: 0, maxX: 200, minY: 0, maxY: 200, excludeAreas: [] }
  assert.deepEqual(findFreePlatePosition(plate, { size: { width: 40, depth: 40 }, occupied: [] }), { x: 100, y: 100 })
})

/**
 * A one-object plate with a printed part, a support blocker, and a modifier — the shape that
 * exposed helper volumes wearing the object's material in the sidebar.
 */
const sceneWithHelperParts = () => libraryThreeMfSceneSchema.parse({
  plateIndex: 1,
  plateName: null,
  bed: { minX: 0, maxX: 256, minY: 0, maxY: 256, plateType: null },
  parts: [
    {
      entryPath: '/3D/Objects/object_1.model', objectId: 1, transform: IDENTITY_3MF,
      name: 'Body', sourceFile: null, filamentId: 2, filamentName: null, color: '#ff0000',
      subtype: 'normal_part'
    },
    {
      entryPath: '/3D/Objects/object_1.model', objectId: 4, transform: IDENTITY_3MF,
      name: 'Blocker', sourceFile: null, filamentId: null, filamentName: null, color: null,
      subtype: 'support_blocker'
    },
    {
      entryPath: '/3D/Objects/object_1.model', objectId: 5, transform: IDENTITY_3MF,
      name: 'Dense zone', sourceFile: null, filamentId: 3, filamentName: null, color: '#00ff00',
      subtype: 'modifier_part'
    }
  ],
  instances: [{
    objectId: 1, instanceId: 0, name: 'Widget', transform: IDENTITY_3MF,
    filamentId: 2, filamentName: null, color: '#ff0000',
    parts: [
      { entryPath: '/3D/Objects/object_1.model', componentObjectId: 1, transform: IDENTITY_3MF, subtype: 'normal_part' },
      { entryPath: '/3D/Objects/object_1.model', componentObjectId: 4, transform: IDENTITY_3MF, subtype: 'support_blocker' },
      { entryPath: '/3D/Objects/object_1.model', componentObjectId: 5, transform: IDENTITY_3MF, subtype: 'modifier_part' }
    ]
  }]
})

test('seeding never gives a support blocker the object material, and never bakes one back', () => {
  const state = seedEditorState(
    threeMfIndexSchema.parse({
      plates: [{ index: 1, name: null, hasThumbnail: false, plateType: null, nozzleSizes: [], filaments: [], objects: [] }],
      projectFilaments: [],
      compatiblePrinterModels: []
    }),
    new Map([[1, sceneWithHelperParts()]])
  )
  const parts = state.plates[0]!.instances[0]!.parts
  const byName = new Map(parts.map((part) => [part.subtype, part]))
  // The printed part keeps its material; the blocker gets none even though the object has one...
  assert.equal(byName.get('normal_part')?.filamentId, 2)
  assert.equal(byName.get('support_blocker')?.filamentId, null)
  assert.equal(byName.get('support_blocker')?.color, null)
  // ...and a modifier keeps the filament its region was explicitly assigned.
  assert.equal(byName.get('modifier_part')?.filamentId, 3)

  // The save must not write an `extruder` back onto the blocker.
  const edit = buildSceneEdit(state)
  assert.deepEqual(
    edit.partFilaments?.map((entry) => entry.componentObjectId).sort(),
    [1, 5]
  )
})

test('summarizeInstanceMaterial and printedParts ignore helper volumes', () => {
  const state = seedEditorState(
    threeMfIndexSchema.parse({
      plates: [{ index: 1, name: null, hasThumbnail: false, plateType: null, nozzleSizes: [], filaments: [], objects: [] }],
      projectFilaments: [],
      compatiblePrinterModels: []
    }),
    new Map([[1, sceneWithHelperParts()]])
  )
  const instance = state.plates[0]!.instances[0]!
  // Only the one printed part counts, so the object reads as a single material rather than
  // "mixed" against a blocker with no material and a modifier on its own filament.
  assert.deepEqual(printedParts(instance).map((part) => part.componentObjectId), [1])
  const summary = summarizeInstanceMaterial(instance, (id) => id, (_id, fallback) => fallback)
  assert.equal(summary.uniformId, 2)
  assert.equal(summary.mixedColors, undefined)
})
