import assert from 'node:assert/strict'
import test from 'node:test'
import { libraryThreeMfSceneSchema, sceneEditSchema, threeMfIndexSchema, type StagedImport } from '@printstream/shared'
import * as THREE from 'three'
import { decodePaintTree, encodePaintTree } from './trianglePaintTree'
import {
  addedPartHostId,
  bodyPaintHostId,
  BODY_PART_INDEX,
  partSlotKey,
  buildSceneEdit,
  buildSessionFilamentIdRemap,
  rebaseEditorStateFilamentIds,
  rebaseSceneEditFilamentIds,
  instanceLinkageKey,
  makeInstanceIndependent,
  buildSingleObjectExportState,
  cloneEditorState,
  collectPartProcessOverridesFromScenes,
  normalizePlateObjectOrder,
  moveObjectBefore,
  projectObjectOrder,
  dropAddedPartsForReplacedHost,
  deriveObjectFilamentId,
  decomposeInstanceTransform,
  exactTransformIfShearing,
  duplicateInstance,
  fillPlateFromScene,
  addedPartPaintKey,
  instanceFromStagedImport,
  instanceVolumeRows,
  isObjectMarkedForRepair,
  mintPlateId,
  movePartBefore,
  movePlate,
  printedParts,
  replaceInstanceGeometry,
  findFreePlatePosition,
  seedEditorState,
  seededActivePlateIndex,
  assignInstanceFilament,
  seedEmptyEditorState,
  stagedFootprint,
  summarizeInstanceMaterial,
  carriedPartSubtypes,
  withRemovedParts,
  type EditorInstance,
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
  assert.deepEqual(edit.partTypeChanges, [{ objectId: 7, partIndex: 5, subtype: 'support_blocker' }])
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
  assert.deepEqual(edit.partTransforms, [{ objectId: 7, partIndex: 5, matrix }])

  // History snapshots must not share the live matrix arrays.
  const clone = cloneEditorState(state)
  assert.deepEqual(clone.partTransforms?.['7:5'], matrix)
  assert.notEqual(clone.partTransforms?.['7:5'], matrix)
})

test('buildSceneEdit never emits a cut group of one piece, which no save would accept', () => {
  // A cut that keeps only one half (Keep upper unticked -- "chop the top off") produces a single
  // piece, and `sceneEditSchema` requires at least two importIds. Emitted anyway, the group failed
  // validation at the save route and took every later save, export and slice of the project with
  // it: a 400 naming an array the user has never heard of, escapable only by undoing the cut.
  const state: EditorState = seedEmptyEditorState()
  const kept = instanceFromStagedImport({ ...STAGED, importId: 'half-a' })
  const other = instanceFromStagedImport({ ...STAGED, importId: 'half-b' })
  state.plates[0]!.instances.push(kept, other)
  state.cutGroups = [
    { importIds: ['half-a'], connectorCount: 0, connectors: [] },
    { importIds: ['half-a', 'half-b'], connectorCount: 0, connectors: [] }
  ]

  const edit = buildSceneEdit(state)
  assert.deepEqual(edit.cutGroups?.map((group) => group.importIds), [['half-a', 'half-b']])
  assert.ok(sceneEditSchema.safeParse(edit).success, 'the emitted edit must satisfy the wire contract')
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
  // Foreign Bambu convention: T·R·S (scale inside rotation): shears relative to the editor's T·S·R.
  const foreign = new THREE.Matrix4()
    .makeTranslation(pos.x, pos.y, pos.z)
    .multiply(new THREE.Matrix4().makeRotationFromEuler(rot))
    .multiply(new THREE.Matrix4().makeScale(nonUniform.x, nonUniform.y, nonUniform.z))
  assert.ok(exactTransformIfShearing(transform12(foreign)) !== undefined, 'foreign T·R·S should be kept exact')

  // The editor's own convention: T·S·R: reproducible from TRS, so no exact matrix needed.
  const own = new THREE.Matrix4()
    .makeTranslation(pos.x, pos.y, pos.z)
    .multiply(new THREE.Matrix4().makeScale(nonUniform.x, nonUniform.y, nonUniform.z))
    .multiply(new THREE.Matrix4().makeRotationFromEuler(rot))
  assert.equal(exactTransformIfShearing(transform12(own)), undefined)

  // Uniform scale + rotation is representable either way, no exact matrix.
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
  source.parts = [{ entryPath: '/x.model', componentObjectId: 2, partIndex: 0, transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], filamentId: 3, name: 'p', color: null, subtype: null }]

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

test('replaceInstanceGeometry keeps a MIXED-material object off the project default', () => {
  // The object's own filamentId is a consensus over its printed parts, so a body on material 5
  // with labels on material 3 reports null. Left null, the bake binds the replacement to filament
  // 1 and a multi-material object silently returns on the project's first material. The leading
  // printed part is the fallback.
  const source = instanceFromStagedImport(STAGED)
  source.source = { kind: 'object' }
  source.objectId = 4
  source.filamentId = null
  const part = (partIndex: number, filamentId: number | null, subtype: string | null) => ({
    entryPath: '/x.model', componentObjectId: partIndex + 2, partIndex, transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    filamentId, name: `p${partIndex}`, color: null, subtype
  })
  source.parts = [part(0, 5, null), part(1, 3, null), part(2, 3, null)]

  const next = replaceInstanceGeometry(source, { ...STAGED, importId: 'imp-9' }, 4)
  assert.equal(next.filamentId, 5)
})

test('replaceInstanceGeometry ignores helper volumes when falling back to a leading material', () => {
  // A support blocker carries no material, so it must not be the part the fallback reads.
  const source = instanceFromStagedImport(STAGED)
  source.source = { kind: 'object' }
  source.objectId = 4
  source.filamentId = null
  const part = (partIndex: number, filamentId: number | null, subtype: string | null) => ({
    entryPath: '/x.model', componentObjectId: partIndex + 2, partIndex, transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    filamentId, name: `p${partIndex}`, color: null, subtype
  })
  source.parts = [part(0, null, 'support_blocker'), part(1, 2, null), part(2, 4, null)]

  const next = replaceInstanceGeometry(source, { ...STAGED, importId: 'imp-9' }, 4)
  assert.equal(next.filamentId, 2)
})

// A staged import's origin IS its centre (`ImportNormalization` normalises whole objects that way),
// but an in-project Bambu object's is not: its mesh routinely carries plate coordinates, so its
// origin can sit far from where the model appears. Copying `position` across therefore drops the
// replacement's CENTRE onto the original's ORIGIN and the model jumps by the difference. The caller
// passes where the old object actually SAT, and the replacement lands there.
test('replaceInstanceGeometry lands the replacement where the old object SAT, not on its origin', () => {
  const source = instanceFromStagedImport(STAGED)
  source.source = { kind: 'object' }
  source.objectId = 9
  // The object's origin, which for a Bambu mesh need not be anywhere near its rendered centre.
  source.position.set(0, 0, 4)

  const replacement: StagedImport = { ...STAGED, importId: 'imp-2', name: 'Gear.stl' }
  const next = replaceInstanceGeometry(source, replacement, 9, undefined, { x: 128, y: 128 })

  // XY comes from where it sat. Z is SOLVED so the body rests on the bed (Studio's `ensure_on_bed`)
  // rather than inherited: an inherited rotation moves the mesh's floor, so keeping the source's z
  // would sink or float the replacement until the user happened to drag it.
  assert.deepEqual([next.position.x, next.position.y, next.position.z], [128, 128, 0])

  // No centre available (an instance with no live group, e.g. on a non-active plate): keep the
  // source's own placement rather than guessing one.
  const blind = replaceInstanceGeometry(source, replacement, 9, undefined, null)
  assert.deepEqual([blind.position.x, blind.position.y, blind.position.z], [0, 0, 4])
})

// The case a naive `position = oldCentre` gets wrong, and the one that shipped broken.
// `position` places the local ORIGIN, and a staged import's origin is its XY centre but its Z
// FLOOR. Inherit a rotation and that un-centred axis turns into the plane: -90 degrees about X maps
// local z onto world y, so the origin sits at the EDGE of the rotated footprint and the model lands
// a half-body away with its edge on the old centre. Studio rotates the centring offset into the
// object's frame for exactly this reason (`get_matrix(true)` * mesh_offset delta).
test('replaceInstanceGeometry centres a ROTATED replacement, and rests it on the bed', () => {
  const source = instanceFromStagedImport(STAGED)
  source.source = { kind: 'object' }
  source.objectId = 9
  source.position.set(0, 0, 0)
  // Laid flat, exactly like the object this was found on.
  source.rotation.set(-Math.PI / 2, 0, 0)

  // A staged import as the server now normalises one: centred in XY, floored in Z (0..20 tall).
  const replacement: StagedImport = {
    ...STAGED,
    importId: 'imp-2',
    name: 'Gear.stl',
    bounds: { min: { x: -5, y: -5, z: 0 }, max: { x: 5, y: 5, z: 20 } }
  }
  const next = replaceInstanceGeometry(source, replacement, 9, undefined, { x: 100, y: 100 })

  // -90 about X maps local (x,y,z) to world (x, z, -y). Local z (0..20) becomes world y, so the
  // rotated body spans 20mm in Y with its centre 10mm PAST the origin: the position has to pull
  // back by that 10, or the origin (and so the model's edge) lands on the old centre instead.
  assert.equal(Math.round(next.position.x * 1000) / 1000, 100)
  assert.equal(Math.round(next.position.y * 1000) / 1000, 90)
  // Its world centre therefore lands exactly on the target.
  assert.equal(Math.round((next.position.y + 10) * 1000) / 1000, 100)
  // Local y (-5..5) becomes world z, so resting on the bed means lifting by 5.
  assert.equal(Math.round(next.position.z * 1000) / 1000, 5)
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

test('seeded plates carry a unique session identity and remember their source index', () => {
  const index = threeMfIndexSchema.parse({
    plates: [1, 2, 3].map((plateIndex) => ({
      index: plateIndex, name: null, hasThumbnail: false, plateType: null,
      nozzleSizes: [], filaments: [], objects: []
    })),
    projectFilaments: [],
    compatiblePrinterModels: []
  })
  const state = seedEditorState(index, new Map())
  const plateIds = state.plates.map((plate) => plate.plateId)
  assert.equal(new Set(plateIds).size, 3, 'plateIds must be unique')
  assert.deepEqual(state.plates.map((plate) => plate.sourcePlateIndex), [1, 2, 3])
  // A scaffold plate has no archive plate behind it.
  assert.equal(seedEmptyEditorState().plates[0]?.sourcePlateIndex, null)
  // Identity survives the undo snapshot: dropping it there would resurrect the index-keyed
  // thumbnail drift the moment a reorder is undone.
  const snapshot = cloneEditorState(state)
  assert.deepEqual(snapshot.plates.map((plate) => plate.plateId), plateIds)
  assert.deepEqual(snapshot.plates.map((plate) => plate.sourcePlateIndex), [1, 2, 3])
})

test('seededActivePlateIndex maps the preferred SOURCE plate onto the reindexed live plates', () => {
  // The regression shape: a Bambu per-plate "export sliced file" carries ONLY the exported plate,
  // keeping its number: the parsed index has one plate whose index is 2, which reindexes to live
  // index 1. Assigning the source index (2) directly left activePlate unresolvable and the editor
  // on "Loading plates…" forever, state fully seeded behind it.
  const singleExported = threeMfIndexSchema.parse({
    plates: [{ index: 2, name: null, hasThumbnail: false, plateType: null, nozzleSizes: [], filaments: [], objects: [] }],
    projectFilaments: [],
    compatiblePrinterModels: []
  })
  const exported = seedEditorState(singleExported, new Map())
  assert.equal(exported.plates[0]?.index, 1, 'the sole plate reindexes to live 1')
  assert.equal(seededActivePlateIndex(exported.plates, 2), 1, 'source plate 2 opens at its live position')

  // The usual contiguous archive: the two spaces coincide and the preference passes through.
  const contiguous = threeMfIndexSchema.parse({
    plates: [1, 2, 3].map((plateIndex) => ({
      index: plateIndex, name: null, hasThumbnail: false, plateType: null,
      nozzleSizes: [], filaments: [], objects: []
    })),
    projectFilaments: [],
    compatiblePrinterModels: []
  })
  const seeded = seedEditorState(contiguous, new Map())
  assert.equal(seededActivePlateIndex(seeded.plates, 2), 2)

  // No usable preference falls back to the first plate; no plates at all to the scaffold's 1.
  assert.equal(seededActivePlateIndex(seeded.plates, 9), 1, 'an unknown source index falls back')
  assert.equal(seededActivePlateIndex(seeded.plates, null), 1)
  assert.equal(seededActivePlateIndex([], null), 1)
})

test('movePlate drops into an insertion gap and renumbers, keeping identity with each plate', () => {
  const index = threeMfIndexSchema.parse({
    plates: [1, 2, 3].map((plateIndex) => ({
      index: plateIndex, name: null, hasThumbnail: false, plateType: null,
      nozzleSizes: [], filaments: [], objects: []
    })),
    projectFilaments: [],
    compatiblePrinterModels: []
  })
  const plates = seedEditorState(index, new Map()).plates
  const idOf = (sourceIndex: number) => plates.find((plate) => plate.sourcePlateIndex === sourceIndex)!.plateId

  // Backward: plate 3 into gap 0 (before plate 1).
  const backward = movePlate(plates, 3, 0)
  assert.deepEqual(backward.map((plate) => plate.index), [1, 2, 3], 'indices stay contiguous')
  assert.deepEqual(backward.map((plate) => plate.plateId), [idOf(3), idOf(1), idOf(2)])
  assert.deepEqual(backward.map((plate) => plate.sourcePlateIndex), [3, 1, 2], 'source addressing travels with the plate')

  // Forward: plate 1 into gap 3 (after the last plate). Gap semantics are direction-independent.
  const forward = movePlate(plates, 1, 3)
  assert.deepEqual(forward.map((plate) => plate.plateId), [idOf(2), idOf(3), idOf(1)])

  // The inverse restores the original order exactly.
  const roundTripped = movePlate(backward, backward[0]!.index, 3)
  assert.deepEqual(roundTripped.map((plate) => plate.plateId), plates.map((plate) => plate.plateId))

  // No-ops return the input array so callers can skip the history checkpoint: the gaps on either
  // side of the plate's own position, an unknown plate, and out-of-range gaps clamp.
  assert.equal(movePlate(plates, 2, 1), plates)
  assert.equal(movePlate(plates, 2, 2), plates)
  assert.equal(movePlate(plates, 99, 0), plates)
  assert.deepEqual(movePlate(plates, 3, 99).map((plate) => plate.plateId), plates.map((plate) => plate.plateId), 'over-range gap clamps to the end')
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
  // server-side) and not by objectId 0: the bake resolves it through importIdToObjectId.
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

  // The replacement RETAINS object 7's identity, which is the same key addedParts uses, so
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
  plate.bed = { minX: 0, maxX: 200, minY: 0, maxY: 200, maxZ: null, excludeAreas: [] }
  plate.instances.push(object)

  const exported = buildSingleObjectExportState(state, object.key, { x: 40, y: 30 })
  const placed = exported?.plates[0]?.instances[0]
  // Shifted by (bedCentre - footprintCentre) = (100-40, 100-30), so the GEOMETRY lands centred.
  // Assigning the bed centre to `position` (the old behaviour) would have put it at (100, 100),
  // leaving the mesh at (130, 120): the half-off-the-bed export.
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
  // partTransforms addresses baked 3MF object ids, which an unsaved import does not have: the
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
  // A part is addressed by its ORDINAL, which a copy shares with its source, so unlike the mesh
  // ids the clone pre-pass remaps, there is nothing per-part to translate here.
  assert.ok(edit.partTypeChanges?.some((entry) => entry.objectId === copy.objectId && entry.partIndex === 11))

  // Deleting the copy must not ship a dangling clone (the bake rejects one).
  state.plates[0]!.instances = [source]
  assert.equal(buildSceneEdit(state).objectClones, undefined)
})

test('a SINGLE-solid import (an added cube) emits its paint as solid 0', () => {
  const state: EditorState = seedEmptyEditorState()
  // A primitive / plain STL stages as ONE solid, so `parts` is empty: the case that made painting
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
  // It must NOT also emit as object paint, an unsaved import has no baked object to address.
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
    plateId: mintPlateId(),
    sourcePlateIndex: 2,
    name: 'Plate two',
    plateType: null,
    bed: { minX: 0, maxX: 200, minY: 0, maxY: 180, maxZ: null, excludeAreas: [] },
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
  state.plates[0]!.bed = { minX: -100, maxX: 100, minY: -90, maxY: 90, maxZ: null, excludeAreas: [] }
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
  plate.bed = { minX: 0, maxX: 200, minY: 0, maxY: 200, maxZ: null, excludeAreas: [] }
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
  plate.bed = { minX: 0, maxX: 200, minY: 0, maxY: 200, maxZ: null, excludeAreas: [] }
  assert.deepEqual(findFreePlatePosition(plate, { size: { width: 40, depth: 40 }, occupied: [] }), { x: 100, y: 100 })
})

/**
 * A one-object plate with a printed part, a support blocker, and a modifier: the shape that
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
    edit.partFilaments?.map((entry) => entry.partIndex).sort(),
    [0, 2]
  )
})

// SESSION -> SAVED filament renumbering: a save that removed/reordered materials bakes the desired
// list as slots 1..N, so every filament id the editor emits, and then holds live, must follow.
// The production repro: 5 slots reduced to 1 (kept session id 2); an untranslated emit wrote a part
// `extruder="2"` into a 1-filament file, and the untranslated live state made the mesh colour
// lookup miss, reverting the viewport to the originally-seeded colour after Save.
test('buildSessionFilamentIdRemap is null for identity and maps session ids to positions otherwise', () => {
  assert.equal(buildSessionFilamentIdRemap([1, 2, 3]), null)
  const remap = buildSessionFilamentIdRemap([2])
  assert.deepEqual([...remap!.entries()], [[2, 1]])
  const reorder = buildSessionFilamentIdRemap([3, 1])
  assert.deepEqual([...reorder!.entries()], [[3, 1], [1, 2]])
})

test('rebaseSceneEditFilamentIds translates every id-carrying field and drops unmappable ids', () => {
  const remap = buildSessionFilamentIdRemap([2])!
  const edit = {
    plates: [{ index: 1 }],
    instances: [
      { objectId: 2, plateIndex: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, filamentId: 2 },
      { objectId: 3, plateIndex: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, filamentId: 5 }
    ],
    partFilaments: [
      { objectId: 2, partIndex: 0, filamentId: 2 },
      { objectId: 2, partIndex: 1, filamentId: 5 }
    ],
    importPartFilaments: [{ importId: 'imp-1', partIndex: 0, filamentId: 2 }],
    addedParts: [{ objectId: 2, meshImportId: 'imp-2', subtype: 'normal_part', name: 'Cube', matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], filamentId: 2 }],
    filamentChanges: [{ plateIndex: 1, changes: [{ z: 3, filamentId: 2 }, { z: 6, filamentId: 5 }] }]
  } as unknown as Parameters<typeof rebaseSceneEditFilamentIds>[0]
  const next = rebaseSceneEditFilamentIds(edit, remap)
  assert.equal(next.instances[0]!.filamentId, 1, 'kept slot follows to its saved id')
  assert.equal(next.instances[1]!.filamentId, null, 'a removed material becomes inherit, never a guess')
  assert.deepEqual(next.partFilaments, [{ objectId: 2, partIndex: 0, filamentId: 1 }], 'unmappable part assignment dropped')
  assert.deepEqual(next.importPartFilaments, [{ importId: 'imp-1', partIndex: 0, filamentId: 1 }])
  assert.equal(next.addedParts![0]!.filamentId, 1)
  assert.deepEqual(next.filamentChanges![0]!.changes, [{ z: 3, filamentId: 1 }], 'a change to a removed material is dropped')
})

test('rebaseEditorStateFilamentIds moves live instances, parts, and added parts onto the saved ids', () => {
  const state = seedEmptyEditorState()
  // Multi-part import: it carries the synthetic negative object identity added parts key on.
  const instance = instanceFromStagedImport(MULTI)
  instance.filamentId = 2
  instance.parts = instance.parts.map((part) => ({ ...part, filamentId: 2 }))
  state.plates[0]!.instances.push(instance)
  const hostId = addedPartHostId(instance)!
  state.addedParts = { [hostId]: [{ key: 'ap-1', meshImportId: 'imp-2', subtype: 'normal_part', name: 'Cube', matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], filamentId: 2 }] as never }
  const remap = buildSessionFilamentIdRemap([2])!
  const next = rebaseEditorStateFilamentIds(state, remap)
  assert.equal(next.plates[0]!.instances[0]!.filamentId, 1)
  assert.equal(next.plates[0]!.instances[0]!.parts[0]!.filamentId, 1)
  assert.equal(next.addedParts![hostId]![0]!.filamentId, 1)
  // The original state is untouched (the rebase replaces, never mutates).
  assert.equal(state.plates[0]!.instances[0]!.filamentId, 2)
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

test('paint on a SESSION-ADDED volume emits as that volume\'s own importPaint', () => {
  // A volume is paintable from the moment it exists, like every other part-scoped feature. Its mesh
  // is a single-solid `part` import, so the paint rides `importPaint` at solid 0 -- the same entry
  // the bake already reads for an unsaved import, which is why this needed no bake seam.
  const state = seedEditorState(
    threeMfIndexSchema.parse({
      plates: [{ index: 1, name: null, hasThumbnail: false, plateType: null, nozzleSizes: [], filaments: [], objects: [] }],
      projectFilaments: [],
      compatiblePrinterModels: []
    }),
    new Map([[1, sceneWithHelperParts()]])
  )
  const instance = state.plates[0]!.instances[0]!
  const hostId = addedPartHostId(instance)!
  const volume = {
    key: 'vol-1',
    importId: 'imp-vol-1',
    subtype: 'normal_part',
    name: 'Cube',
    filamentId: null,
    position: new THREE.Vector3(),
    rotation: new THREE.Euler(),
    scale: new THREE.Vector3(1, 1, 1),
    soup: new Float32Array(9)
  } as never
  const painted: EditorState = {
    ...state,
    addedParts: { [hostId]: [volume] },
    supportPaint: { [addedPartPaintKey('imp-vol-1')]: { 0: '8', 3: '4' } }
  }

  const entries = buildSceneEdit(painted).importPaint ?? []
  const entry = entries.find((item) => item.importId === 'imp-vol-1')
  assert.ok(entry, 'the volume\'s paint never reached the edit')
  assert.equal(entry?.partIndex, 0, 'a volume\'s mesh is its import\'s only solid')
  assert.equal(entry?.channel, 'support')
  assert.deepEqual(entry?.triangles, { '0': '8', '3': '4' })

  // The inverse: paint for a volume the user has since deleted must not ship, or the save writes
  // paint for geometry it does not write.
  const orphaned = buildSceneEdit({ ...painted, addedParts: {} }).importPaint ?? []
  assert.equal(orphaned.find((item) => item.importId === 'imp-vol-1'), undefined,
    'paint for a removed volume must not be emitted')
})

test('a DELETED body survives an undo snapshot and a duplicate', () => {
  // `cloneEditorState` and `duplicateInstance` rebuild an instance FIELD BY FIELD, so a new field
  // that is not named in them is dropped in silence. For this one that means undo/redo resurrecting
  // geometry the user deleted -- and then saving it, because the flag is what tells the bake not to
  // write that component. The same trap the `nameOverridden` flag carries a comment about.
  const state = seedEditorState(
    threeMfIndexSchema.parse({
      plates: [{ index: 1, name: null, hasThumbnail: false, plateType: null, nozzleSizes: [], filaments: [], objects: [] }],
      projectFilaments: [],
      compatiblePrinterModels: []
    }),
    new Map([[1, sceneWithHelperParts()]])
  )
  const instance = { ...state.plates[0]!.instances[0]!, parts: [], bodyRemoved: true }
  const withFlag: EditorState = {
    ...state,
    plates: [{ ...state.plates[0]!, instances: [instance] }]
  }

  assert.equal(cloneEditorState(withFlag).plates[0]!.instances[0]!.bodyRemoved, true,
    'an undo snapshot dropped the deleted body')
  assert.equal(duplicateInstance(instance).bodyRemoved, true,
    'a copy of the object grew its body back')

  // The inverse: an ordinary object must not gain the flag, or every object would save without
  // its own geometry.
  const plain = { ...instance, bodyRemoved: undefined }
  assert.equal(cloneEditorState({ ...withFlag, plates: [{ ...withFlag.plates[0]!, instances: [plain] }] })
    .plates[0]!.instances[0]!.bodyRemoved, undefined)
  assert.equal(duplicateInstance(plain).bodyRemoved, undefined)
})

test('a deleted body removes the body ROW and emits the removal', () => {
  const instance = { parts: [], bodyRemoved: true } as never
  // No body row, and its volumes are the object's whole geometry: one volume means no rows at all,
  // exactly as a saved object with one part shows none.
  assert.deepEqual(instanceVolumeRows(instance, 1), { showRows: false, showBodyRow: false, cutConnectorCount: 0 })
  assert.deepEqual(instanceVolumeRows(instance, 2), { showRows: true, showBodyRow: false, cutConnectorCount: 0 })
  // The inverse: without the flag the body is a volume again and earns its row.
  assert.deepEqual(instanceVolumeRows({ parts: [] } as never, 1), { showRows: true, showBodyRow: true, cutConnectorCount: 0 })
})

test('a body retyped to a HELPER VOLUME is not paintable', () => {
  // The paint tag is what puts a mesh in the brush's raycast set, so a tagged aid catches strokes
  // aimed at whatever is behind it -- and stores paint the bake will never write, because a blocker
  // or a negative volume carries none. The three other mesh-build sites gate on the part's own
  // `subtype`; the body has no part entry until a save, so its subtype has to be read back out of
  // `partTypeChanges`, and that is the reason this one site could miss the guard.
  const instance = { parts: [], source: { kind: 'import', importId: 'imp-1', replacedObjectId: -7 } } as never
  const helperBody = (subtype: string): EditorState =>
    ({ partTypeChanges: { [partSlotKey(-7, BODY_PART_INDEX)]: subtype } }) as never

  assert.equal(bodyPaintHostId(null, instance), -7,
    'an ordinary body must stay paintable, before any save')
  assert.equal(bodyPaintHostId(helperBody('normal_part'), instance), -7)
  for (const subtype of ['negative_part', 'modifier_part', 'support_blocker', 'support_enforcer']) {
    assert.equal(bodyPaintHostId(helperBody(subtype), instance), null, `a ${subtype} body was paintable`)
  }
  // The raw spelling BambuStudio writes into `model_settings.config` canonicalizes to the same
  // thing, so a project loaded from disk is judged identically to one retyped this session.
  assert.equal(bodyPaintHostId(helperBody('support_blocker'), instance), null)
})

test('summarizeInstanceMaterial counts SESSION-ADDED volumes, and the body when there are no parts', () => {
  // The badge summarises what the object PRINTS, and a normal added volume is printed geometry that
  // carries its own filament (it inherits the host's on add, explicitly). Counting only
  // `instance.parts` made the badge lie in both directions: an object whose baked parts are on
  // material 2 with a volume on material 5 summarised as a UNIFORM 2, and an object with no part
  // list at all summarised nothing once a volume joined it. Both then changed on the next save,
  // when the volume became a baked part and started counting.
  const state = seedEditorState(
    threeMfIndexSchema.parse({
      plates: [{ index: 1, name: null, hasThumbnail: false, plateType: null, nozzleSizes: [], filaments: [], objects: [] }],
      projectFilaments: [],
      compatiblePrinterModels: []
    }),
    new Map([[1, sceneWithHelperParts()]])
  )
  const instance = state.plates[0]!.instances[0]!
  const identity = (id: number | null) => id
  const asColour = (_id: number | null, fallback: string | null) => fallback
  const volume = (filamentId: number | null, subtype = 'normal_part') =>
    ({ key: `v-${filamentId}-${subtype}`, importId: 'imp', subtype, name: 'V', filamentId } as never)

  // A volume on a DIFFERENT material makes the object mixed.
  const mixed = summarizeInstanceMaterial(instance, identity, asColour, [volume(5)])
  assert.equal(mixed.uniformId, null, 'a volume on another material must break the uniform answer')
  assert.equal(mixed.mixedColors?.length, 2)

  // A volume on the SAME material leaves it uniform, so the badge does not cry mixed over nothing.
  assert.equal(summarizeInstanceMaterial(instance, identity, asColour, [volume(2)]).uniformId, 2)

  // A helper volume has no material and must not count, exactly as a helper PART does not.
  const withBlocker = summarizeInstanceMaterial(instance, identity, asColour, [volume(null, 'support_blocker')])
  assert.equal(withBlocker.uniformId, 2)
  assert.equal(withBlocker.mixedColors, undefined)

  // An object with NO part list keeps its material on the instance, and that body is a volume too.
  const bodyOnly = { ...instance, parts: [], filamentId: 3, color: '#FF0000' }
  assert.equal(summarizeInstanceMaterial(bodyOnly, identity, asColour, []).uniformId, 3)
  const bodyMixed = summarizeInstanceMaterial(bodyOnly, identity, asColour, [volume(5)])
  assert.equal(bodyMixed.uniformId, null, 'the body must be weighed against the volume beside it')
  assert.equal(bodyMixed.mixedColors?.length, 2)
})

test('both rebase halves carry COLOUR PAINT onto the saved filament ids', () => {
  // The pure remap is covered in trianglePaintTree.test.ts; this pins that the two rebase paths
  // actually REACH it. Without the wiring the codes survive the renumber addressing the old
  // number, so painted regions print in whatever material moved into that slot.
  const remap = buildSessionFilamentIdRemap([2])!   // slot 2 kept, everything else removed
  const kept = encodePaintTree({ kind: 'leaf', state: 2 })
  const doomed = encodePaintTree({ kind: 'leaf', state: 5 })

  const edit = {
    plates: [{ index: 1 }],
    instances: [],
    colorPaint: [
      { objectId: 2, componentObjectId: 1, triangles: { 0: kept, 1: doomed } },
      { objectId: 2, componentObjectId: 9, triangles: { 0: doomed } }
    ],
    importPaint: [
      { importId: 'imp-1', partIndex: 0, channel: 'color', triangles: { 0: kept } },
      { importId: 'imp-1', partIndex: 0, channel: 'support', triangles: { 0: kept } }
    ]
  } as unknown as Parameters<typeof rebaseSceneEditFilamentIds>[0]
  const nextEdit = rebaseSceneEditFilamentIds(edit, remap)
  assert.equal(nextEdit.colorPaint!.length, 1, 'a part left with no paint is dropped')
  assert.deepEqual(Object.keys(nextEdit.colorPaint![0]!.triangles), ['0'], 'the removed material’s triangle goes')
  assert.equal(decodePaintTree(nextEdit.colorPaint![0]!.triangles[0]!)!.kind === 'leaf'
    && (decodePaintTree(nextEdit.colorPaint![0]!.triangles[0]!) as { state: number }).state, 1)
  // Supports/seam encode enforcer/blocker constants, NOT filament ids: remapping them would
  // corrupt the channel, so they must pass through untouched.
  const supports = nextEdit.importPaint!.find((entry) => entry.channel === 'support')!
  assert.equal(supports.triangles[0], kept, 'a non-colour channel is left alone')

  const state = seedEmptyEditorState()
  state.colorPaint = { '2:1': { 0: kept, 1: doomed } }
  const nextState = rebaseEditorStateFilamentIds(state, remap)
  assert.deepEqual(Object.keys(nextState.colorPaint!['2:1']!), ['0'])
  assert.equal((decodePaintTree(nextState.colorPaint!['2:1']![0]!) as { state: number }).state, 1)
})

test('assignInstanceFilament sets the material of a model that has NO parts', () => {
  // The regression. A primitive, a single-solid STL/3MF import, a single-shell Cut output and any
  // single-mesh saved object all arrive with `parts: []`, so a material change expressed over
  // PARTS had nothing to write to and silently did nothing. Their material lives here, and
  // buildSceneEdit emits it as the instance's own filamentId.
  const instance = instanceFromStagedImport(STAGED)
  assert.equal(instance.parts.length, 0, 'a single-solid import keeps the one-mesh render path')

  const next = assignInstanceFilament(instance, 3)
  assert.equal(next.filamentId, 3)
  assert.notEqual(next, instance, 'a real change returns a new instance')

  const state: EditorState = seedEmptyEditorState()
  state.plates[0]!.instances.push(next)
  const emitted = buildSceneEdit(state).instances[0]
  assert.equal(emitted?.filamentId, 3, 'and the bake carries it')
})

test('assignInstanceFilament retargets every printed part of a multi-part model, sparing helpers', () => {
  const instance = instanceFromStagedImport(MULTI)
  assert.ok(instance.parts.length > 1)
  instance.parts[1]!.subtype = 'support_blocker'

  const next = assignInstanceFilament(instance, 2)
  assert.equal(next.parts[0]!.filamentId, 2, 'printed part retargeted')
  assert.equal(next.parts[1]!.filamentId, null, 'a helper volume has no material to set')
  assert.equal(next.filamentId, 2, "and the object's own id follows the printed consensus")
})

test('assignInstanceFilament returns the SAME instance when nothing changes', () => {
  const instance = assignInstanceFilament(instanceFromStagedImport(STAGED), 4)
  assert.equal(assignInstanceFilament(instance, 4), instance, 'so callers can skip a state write')
})

test('withRemovedParts drops the part from every copy and records its BASE ordinal', () => {
  // Parts are object-level, so a deletion reaches every linked copy, and the survivors keep their
  // own partIndex: nothing is renumbered, which is what keeps the other part-scoped seams pointing
  // at the volumes they were made against.
  const part = (partIndex: number, subtype: string | null) => ({
    entryPath: '/x.model', componentObjectId: partIndex + 2, partIndex,
    transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], filamentId: null, name: `p${partIndex}`, color: null, subtype
  })
  const instance = (key: string) => {
    const next = instanceFromStagedImport(STAGED)
    next.source = { kind: 'object' }
    next.objectId = 12
    next.key = key
    next.parts = [part(0, null), part(1, 'modifier_part'), part(2, null)]
    return next
  }
  const state = {
    plates: [
      { index: 1, instances: [instance('a'), instance('b')] },
      { index: 2, instances: [instance('c')] }
    ]
  } as unknown as EditorState

  const next = withRemovedParts(state, 12, new Set([1]))
  assert.ok(next)
  const everyInstance = next!.plates.flatMap((plate) => plate.instances)
  assert.equal(everyInstance.length, 3)
  for (const entry of everyInstance) {
    assert.deepEqual(entry.parts.map((entryPart) => entryPart.partIndex), [0, 2], 'survivors keep their base ordinals')
  }
  assert.deepEqual(next!.removedParts, { 12: [1] })
})

test('withRemovedParts refuses to take an object\'s last printed part', () => {
  // Helper volumes are not printed geometry, so an object left holding only a modifier has nothing
  // to print. Deleting the OBJECT is the action for that.
  const part = (partIndex: number, subtype: string | null) => ({
    entryPath: '/x.model', componentObjectId: partIndex + 2, partIndex,
    transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], filamentId: null, name: `p${partIndex}`, color: null, subtype
  })
  const only = instanceFromStagedImport(STAGED)
  only.source = { kind: 'object' }
  only.objectId = 3
  only.parts = [part(0, null), part(1, 'modifier_part'), part(2, 'support_blocker')]
  const state = { plates: [{ index: 1, instances: [only] }] } as unknown as EditorState

  assert.equal(withRemovedParts(state, 3, new Set([0])), null)
  // The helper volumes on their own are removable, because printed geometry survives.
  assert.ok(withRemovedParts(state, 3, new Set([1, 2])))
})

test('a session-added part counts as printed geometry when the last baked one goes', () => {
  // The part-is-a-part rule: an added volume is geometry the browser is holding, so an object whose
  // printed geometry is one of THOSE is not an object with nothing to print. Counting only baked
  // parts is what refused a part boolean over an object's single printed part -- which is the common
  // case, since replacing that part is usually the whole point.
  const part = (partIndex: number, subtype: string | null) => ({
    entryPath: '/x.model', componentObjectId: partIndex + 2, partIndex,
    transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], filamentId: null, name: `p${partIndex}`, color: null, subtype
  })
  const host = instanceFromStagedImport(STAGED)
  host.source = { kind: 'object' }
  host.objectId = 5
  host.parts = [part(0, null)]
  const added = (subtype: string) => ({
    key: `k-${subtype}`, importId: 'imp', subtype, name: subtype,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
    soup: new Float32Array(0)
  })

  const withHelperOnly = { plates: [{ index: 1, instances: [host] }], addedParts: { 5: [added('support_blocker')] } } as unknown as EditorState
  assert.equal(withRemovedParts(withHelperOnly, 5, new Set([0])), null,
    'a blocker is not printed geometry, so the last printed part still cannot go')

  const withPrintedAdded = { plates: [{ index: 1, instances: [host] }], addedParts: { 5: [added('normal_part')] } } as unknown as EditorState
  assert.ok(withRemovedParts(withPrintedAdded, 5, new Set([0])),
    'an added normal part is printed geometry and keeps the object printable')

  // And a caller adding a replacement in the same commit says so explicitly, which is how the
  // boolean consumes every printed part of an object and puts its result there instead.
  const bare = { plates: [{ index: 1, instances: [host] }] } as unknown as EditorState
  assert.equal(withRemovedParts(bare, 5, new Set([0])), null)
  assert.ok(withRemovedParts(bare, 5, new Set([0]), 1), 'the incoming replacement counts')
})

test('buildSceneEdit emits removals against the right id space for objects and imports', () => {
  const part = (partIndex: number) => ({
    entryPath: '/x.model', componentObjectId: partIndex + 2, partIndex,
    transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], filamentId: null, name: `p${partIndex}`, color: null, subtype: null
  })
  const saved = instanceFromStagedImport(STAGED)
  saved.source = { kind: 'object' }
  saved.objectId = 21
  saved.parts = [part(0), part(1)]

  const imported = instanceFromStagedImport({ ...STAGED, importId: 'imp-7' })
  imported.parts = [part(0), part(1)]
  const importHostId = imported.source.kind === 'import' ? imported.source.replacedObjectId! : 0

  const state = {
    plates: [{ index: 1, instances: [saved, imported] }],
    removedParts: { 21: [1], [importHostId]: [0] }
  } as unknown as EditorState

  const edit = buildSceneEdit(state)
  assert.deepEqual(edit.removedParts, [{ objectId: 21, partIndex: 1 }])
  assert.deepEqual(edit.importRemovedParts, [{ importId: 'imp-7', partIndex: 0 }])
})

test('replacing an object forgets its part DELETIONS as well as its added parts', () => {
  // Both key on the retained identity, and a stale removal is the more dangerous of the two: it
  // resolves against the REPLACEMENT once the host is import-backed, so "delete part 1, then
  // replace" would silently drop solid 1 of the new mesh.
  const instance = instanceFromStagedImport(STAGED)
  instance.source = { kind: 'object' }
  instance.objectId = 12
  const state = {
    plates: [{ index: 1, instances: [instance] }],
    addedParts: { 12: [{ key: 'p1' }] },
    removedParts: { 12: [1] }
  } as unknown as EditorState

  dropAddedPartsForReplacedHost(state, instance)
  assert.equal(state.addedParts?.[12], undefined)
  assert.equal(state.removedParts?.[12], undefined)
})

test('carriedPartSubtypes re-applies helper volume types to a revised export, matched by name', () => {
  // The reported case: a model re-exported with the same named solids came back with its five
  // "Hole modifier" volumes as printed geometry. A STEP has no volume types at all, so the only
  // evidence of intent is the object being replaced.
  const previous = [
    { name: 'Cylinder', subtype: 'normal_part' },
    { name: 'Hole modifier 1', subtype: 'modifier_part' },
    { name: 'Cylinder size label 2', subtype: 'modifier_part' },
    { name: 'Cylinder size label 2', subtype: 'support_blocker' }
  ]
  const staged = [
    { name: 'Cylinder' },
    { name: 'Hole modifier 1' },
    { name: 'Cylinder size label 2' },
    { name: 'Cylinder size label 2' }
  ]
  const carried = carriedPartSubtypes(previous, staged)
  // A printed part carries nothing (normal_part is already the default), and duplicate names pair
  // up in order rather than both taking the first match.
  assert.deepEqual([...carried.entries()], [[1, 'modifier_part'], [2, 'modifier_part'], [3, 'support_blocker']])
})

test('carriedPartSubtypes never overrides a type the imported file states itself', () => {
  // A 3MF carries its volume types, and the file being imported is better evidence than the file
  // being replaced.
  const carried = carriedPartSubtypes(
    [{ name: 'Connector', subtype: 'modifier_part' }],
    [{ name: 'Connector', subtype: 'negative_part' }]
  )
  assert.equal(carried.size, 0)
})

test('carriedPartSubtypes carries nothing when no name corresponds', () => {
  // Replacing with a genuinely different model must not invent helper volumes.
  const carried = carriedPartSubtypes(
    [{ name: 'Hole modifier 1', subtype: 'modifier_part' }],
    [{ name: 'Bracket' }, { name: 'Pin' }]
  )
  assert.equal(carried.size, 0)
})

test('per-part process overrides re-hydrate by ORDINAL, not by the mesh id', () => {
  // The fixture gives NO part a `componentObjectId` equal to its ordinal, which is the shape of
  // nearly every real object: the seed used to key on the mesh id, so a reopened project put its
  // saved per-part settings on a neighbouring volume with nothing thrown.
  const scene = libraryThreeMfSceneSchema.parse({
    plateIndex: 1,
    plateName: null,
    bed: { minX: 0, maxX: 256, minY: 0, maxY: 256, plateType: null },
    parts: [],
    instances: [{
      objectId: 7, instanceId: 0, name: 'Assembly', transform: IDENTITY_3MF,
      filamentId: 1, filamentName: null, color: null,
      parts: [
        { entryPath: '3D/3dmodel.model', componentObjectId: 20, transform: IDENTITY_3MF },
        { entryPath: '3D/3dmodel.model', componentObjectId: 21, transform: IDENTITY_3MF, processOverrides: { wall_loops: '4' } }
      ]
    }]
  })

  const seeded = collectPartProcessOverridesFromScenes(new Map([[1, scene]]))
  // Ordinal 1, not mesh id 21.
  assert.deepEqual(seeded, { '7:1': { wall_loops: '4' } })
})

test('an independent copy carries the source deletions and its pending mesh repair', () => {
  const state: EditorState = seedEmptyEditorState()
  const source = instanceFromStagedImport(STAGED)
  source.source = { kind: 'object' }
  source.objectId = 3
  const copy = duplicateInstance(source)
  state.plates[0]!.instances.push(source, copy)
  // Two object-keyed maps the copy used to be given none of. Both fail silently: the copy came
  // back with volumes the user had deleted, and unrepaired while its source repaired.
  state.removedParts = { 3: [1, 2] }
  state.repairedObjectIds = [3]

  makeInstanceIndependent(state, copy)

  assert.deepEqual(state.removedParts[copy.objectId], [1, 2])
  assert.ok(state.repairedObjectIds.includes(copy.objectId), 'the copy is marked for repair too')
  // Its own array, so removing a part from the copy cannot remove it from the source.
  assert.notEqual(state.removedParts[copy.objectId], state.removedParts[3])
  assert.deepEqual(state.removedParts[3], [1, 2], 'the source is untouched')

  const edit = buildSceneEdit(state)
  assert.ok(edit.removedParts?.some((entry) => entry.objectId === copy.objectId && entry.partIndex === 1))
  assert.ok(edit.repairedObjectIds?.includes(copy.objectId))
})

/**
 * Object display order. It is portable through the BUILD ITEMS, which BambuStudio walks to build
 * its object list, so the unit an order can address is the OBJECT, not the row: a linked copy is
 * another instance of one entry in that list, and the file cannot put another object between them.
 */
const objectInstance = (objectId: number, name: string): EditorInstance => {
  const instance = instanceFromStagedImport(STAGED)
  instance.source = { kind: 'object' }
  instance.objectId = objectId
  instance.name = name
  return instance
}

const stateWith = (instances: EditorInstance[]) => {
  const state = seedEmptyEditorState()
  state.plates[0]!.instances = instances
  return state
}

const names = (state: EditorState, plateIndex = 0) =>
  state.plates[plateIndex]!.instances.map((instance) => instance.name)

test('projectObjectOrder lists each object once, at its first instance', () => {
  const a = objectInstance(3, 'A')
  const state = stateWith([a, duplicateInstance(a), objectInstance(9, 'B')])
  // A linked copy is the same object, so it must not take a position of its own.
  assert.deepEqual(projectObjectOrder(state), [3, 9])
})

test('a reorder carries every linked copy of the object it moves', () => {
  const a = objectInstance(3, 'A')
  const state = stateWith([a, duplicateInstance(a), objectInstance(9, 'B')])
  // B before A: both copies of A travel, because the file has one list entry for the two of them.
  assert.deepEqual(names(moveObjectBefore(state, 9, 3)), ['B', 'A', 'A'])
  // A last.
  assert.deepEqual(names(moveObjectBefore(state, 3, null)), ['B', 'A', 'A'])
})

test('a reorder that changes nothing returns the same state, so no checkpoint is recorded', () => {
  const state = stateWith([objectInstance(3, 'A'), objectInstance(9, 'B'), objectInstance(11, 'C')])
  assert.equal(moveObjectBefore(state, 3, 9), state, 'already there')
  assert.equal(moveObjectBefore(state, 9, 9), state, 'dropped on itself')
  assert.equal(moveObjectBefore(state, 11, null), state, 'already last')
  assert.equal(moveObjectBefore(state, 404, 3), state, 'an object that is not placed')
})

test('an unknown anchor appends rather than dropping the object off the plate', () => {
  const state = stateWith([objectInstance(3, 'A'), objectInstance(9, 'B')])
  // Losing the object here would not be a reorder: the unreferenced-object sweep would take its
  // geometry on the next save.
  assert.deepEqual(names(moveObjectBefore(state, 3, 404)), ['B', 'A'])
})

test('object order is PROJECT-wide, so a drag on one plate reaches the object on every plate', () => {
  // An object placed on two plates. The file has ONE object order (the bake flattens every plate
  // into one build section), so a per-plate order would silently lose this drag on reopen.
  const shared = objectInstance(3, 'A')
  const state = seedEmptyEditorState()
  state.plates[0]!.instances = [shared, objectInstance(9, 'B')]
  state.plates.push({ ...state.plates[0]!, index: 2, plateId: mintPlateId(), instances: [duplicateInstance(shared), objectInstance(11, 'C')] })
  const moved = moveObjectBefore(state, 9, 3)
  assert.deepEqual(projectObjectOrder(moved), [9, 3, 11])
  assert.deepEqual(names(moved, 0), ['B', 'A'])
  // Plate 2 holds no B, so its own rows keep their relative order under the new project order.
  assert.deepEqual(names(moved, 1), ['A', 'C'])
})

test('normalizing puts an object copies back together without reordering the objects', () => {
  const a = objectInstance(3, 'A')
  // The shape a duplicate produces: the copy is appended, so it lands after an unrelated object.
  const state = stateWith([a, objectInstance(9, 'B'), duplicateInstance(a)])
  const plates = normalizePlateObjectOrder(state.plates)
  assert.deepEqual(names({ ...state, plates }), ['A', 'A', 'B'])
  // A stays first: normalizing tidies the rows, it does not decide the order.
  assert.deepEqual(projectObjectOrder({ ...state, plates }), [3, 9])
  // Idempotent, and identity-stable so nothing downstream rebuilds for a no-op.
  assert.equal(normalizePlateObjectOrder(plates), plates)
})

test('every plate is laid out to the ONE project order, not to its own', () => {
  // A copy of A and a copy of B moved to plate 2, in the opposite order. The file has one object
  // sequence, so plate 2 showing `B, A` while the save writes `A, B` is the sidebar disagreeing
  // with the file, which is the whole thing this seam exists to prevent.
  const a = objectInstance(3, 'A')
  const b = objectInstance(9, 'B')
  const state = seedEmptyEditorState()
  state.plates[0]!.instances = [a, b]
  state.plates.push({ ...state.plates[0]!, index: 2, plateId: mintPlateId(), instances: [duplicateInstance(b), duplicateInstance(a)] })
  const normalized = { ...state, plates: normalizePlateObjectOrder(state.plates) }
  assert.deepEqual(names(normalized, 1), ['A', 'B'], 'plate 2 follows the project order')
  assert.deepEqual(buildSceneEdit(normalized).instances.map((instance) => instance.objectId), [3, 9, 3, 9])
})

test('a no-op drag returns the same state, so it records no undo step', () => {
  // It used to re-lay other plates and hand back a new state for a gesture with no visible effect.
  const a = objectInstance(3, 'A')
  const b = objectInstance(9, 'B')
  const state = seedEmptyEditorState()
  state.plates[0]!.instances = [a, b]
  state.plates.push({ ...state.plates[0]!, index: 2, plateId: mintPlateId(), instances: [duplicateInstance(b), duplicateInstance(a)] })
  const normalized = { ...state, plates: normalizePlateObjectOrder(state.plates) }
  assert.equal(moveObjectBefore(normalized, 3, 9), normalized, 'A is already before B')
})

test('buildSceneEdit emits instances in the sidebar order, which is what the bake writes items in', () => {
  const state = stateWith([objectInstance(3, 'A'), objectInstance(9, 'B')])
  assert.deepEqual(buildSceneEdit(state).instances.map((instance) => instance.objectId), [3, 9])
  const moved = moveObjectBefore(state, 9, 3)
  assert.deepEqual(buildSceneEdit(moved).instances.map((instance) => instance.objectId), [9, 3])
})

/**
 * Part order within an object. Portable as-is through the `<component>` sequence, and addressed by
 * BASE ordinal because `componentObjectId` is the mesh id and BambuStudio writes one id for every
 * volume sharing a mesh.
 */
const partedObject = (objectId: number, partIndexes: number[]): EditorInstance => {
  const instance = objectInstance(objectId, `Object ${objectId}`)
  instance.parts = partIndexes.map((partIndex) => ({
    entryPath: '3D/3dmodel.model',
    // Deliberately NOT equal to the ordinal: a mesh id that happened to match would let an
    // implementation confusing the two pass.
    componentObjectId: 20 + partIndex,
    partIndex,
    transform: [...IDENTITY_3MF],
    filamentId: 1,
    name: `P${partIndex}`,
    color: null,
    subtype: null
  }))
  return instance
}

const partOrderOf = (state: EditorState, instanceIndex = 0) =>
  state.plates[0]!.instances[instanceIndex]!.parts.map((part) => part.partIndex)

test('a part reorder moves the part and records the object complete ordinal sequence', () => {
  const state = seedEmptyEditorState()
  state.plates[0]!.instances = [partedObject(3, [0, 1, 2])]
  const moved = movePartBefore(state, 3, 2, 0)
  assert.deepEqual(partOrderOf(moved), [2, 0, 1])
  assert.deepEqual(moved.partOrder?.[3], [2, 0, 1])
  // Ordinals are stable identities: the surviving parts are NOT renumbered, so every other
  // part-scoped seam goes on addressing the volume it was made against.
  assert.deepEqual(moved.plates[0]!.instances[0]!.parts.map((part) => part.componentObjectId), [22, 20, 21])
})

test('a helper volume cannot be dragged into the leading slot', () => {
  // BambuStudio requires the first volume to be a printed part: its own object list refuses this
  // drop, and it sorts the volumes on load when a file arrives otherwise. So allowing it corrupts
  // nothing -- it just means the order we persist is not the order the project reopens with, here
  // or in Studio, which makes the drag look like it silently undid itself later.
  const state = seedEmptyEditorState()
  const object = partedObject(3, [0, 1, 2])
  object.parts[2]!.subtype = 'modifier_part'
  state.plates[0]!.instances = [object]

  const moved = movePartBefore(state, 3, 2, 0)
  assert.deepEqual(partOrderOf(moved), [0, 1, 2], 'a modifier was allowed to lead the volume list')
  assert.equal(moved.partOrder?.[3], undefined, 'a refused move still recorded an order')

  // The same drag anywhere else is still fine: only the leading slot is reserved.
  const legal = movePartBefore(state, 3, 2, 1)
  assert.deepEqual(partOrderOf(legal), [0, 2, 1])
})

test('a part reorder applies to every linked copy of the object', () => {
  const state = seedEmptyEditorState()
  const source = partedObject(3, [0, 1, 2])
  state.plates[0]!.instances = [source, duplicateInstance(source)]
  const moved = movePartBefore(state, 3, 0, null)
  // Both copies, because an object has ONE part list; only one of two orders could survive a save.
  assert.deepEqual(partOrderOf(moved, 0), [1, 2, 0])
  assert.deepEqual(partOrderOf(moved, 1), [1, 2, 0])
})

test('a part reorder that changes nothing returns the same state', () => {
  const state = seedEmptyEditorState()
  state.plates[0]!.instances = [partedObject(3, [0, 1, 2])]
  assert.equal(movePartBefore(state, 3, 0, 1), state, 'already there')
  assert.equal(movePartBefore(state, 3, 1, 1), state, 'dropped on itself')
  assert.equal(movePartBefore(state, 3, 2, null), state, 'already last')
  assert.equal(movePartBefore(state, 9, 0, null), state, 'an object that is not placed')
  assert.equal(movePartBefore(state, 3, 7, null), state, 'a part the object does not have')
})

test('part order emits against the object, and against the IMPORT when there is no save yet', () => {
  const state = seedEmptyEditorState()
  state.plates[0]!.instances = [partedObject(3, [0, 1, 2])]
  const moved = movePartBefore(state, 3, 2, 0)
  assert.deepEqual(buildSceneEdit(moved).partOrder, [{ objectId: 3, order: [2, 0, 1] }])
  assert.equal(buildSceneEdit(moved).importPartOrder, undefined)

  // The same edit on a staged multi-solid import, which has no baked object id to address.
  const importState = seedEmptyEditorState()
  const staged = instanceFromStagedImport(MULTI)
  importState.plates[0]!.instances = [staged]
  const hostId = addedPartHostId(staged)
  assert.ok(hostId != null)
  const movedImport = movePartBefore(importState, hostId, 1, 0)
  const edit = buildSceneEdit(movedImport)
  assert.equal(edit.partOrder, undefined, 'an unsaved import has no object id to key an order by')
  assert.deepEqual(edit.importPartOrder, [{ importId: 'imp-3', order: [1, 0] }])
})

test('an order for an object that is no longer placed is not shipped', () => {
  const state = seedEmptyEditorState()
  state.plates[0]!.instances = [partedObject(3, [0, 1, 2])]
  const moved = movePartBefore(state, 3, 2, 0)
  moved.plates[0]!.instances = []
  assert.equal(buildSceneEdit(moved).partOrder, undefined)
})

test('cloneEditorState deep-copies partOrder so an undo frame cannot share the array', () => {
  const state = seedEmptyEditorState()
  state.plates[0]!.instances = [partedObject(3, [0, 1, 2])]
  const moved = movePartBefore(state, 3, 2, 0)
  const snapshot = cloneEditorState(moved)
  assert.deepEqual(snapshot.partOrder?.[3], [2, 0, 1])
  assert.notEqual(snapshot.partOrder![3], moved.partOrder![3])
})

test('deleting a part prunes it out of any recorded order, so both records agree', () => {
  // BambuStudio has no separate order to go stale: `ModelObject::volumes` IS the order and a delete
  // erases from it. Without the prune the same end state emits two different payloads depending on
  // which the user did first, and the bake has to be correct for both.
  const state = seedEmptyEditorState()
  state.plates[0]!.instances = [partedObject(3, [0, 1, 2])]

  const reorderedThenDeleted = withRemovedParts(movePartBefore(state, 3, 2, 0), 3, new Set([1]))
  assert.ok(reorderedThenDeleted)
  assert.deepEqual(reorderedThenDeleted.partOrder?.[3], [2, 0], 'the removed ordinal is gone')

  const deletedThenReordered = movePartBefore(withRemovedParts(state, 3, new Set([1]))!, 3, 2, 0)
  assert.deepEqual(deletedThenReordered.partOrder?.[3], [2, 0], 'the other order produces the same')
  assert.deepEqual(
    buildSceneEdit(reorderedThenDeleted).partOrder,
    buildSceneEdit(deletedThenReordered).partOrder,
    'one end state, one payload'
  )
})

test('deleting down to one part drops the order entirely rather than keeping a stub', () => {
  const state = seedEmptyEditorState()
  // A helper volume alongside two printed parts, so removing two still leaves something printable.
  const object = partedObject(3, [0, 1, 2])
  object.parts[2]!.subtype = 'support_blocker'
  state.plates[0]!.instances = [object]
  const reordered = movePartBefore(state, 3, 2, 0)
  const pruned = withRemovedParts(reordered, 3, new Set([0, 2]))
  assert.ok(pruned)
  assert.equal(pruned.partOrder?.[3], undefined, 'an order of one volume says nothing')
  assert.equal(buildSceneEdit(pruned).partOrder, undefined)
})

test('a body deleted this session stops claiming ordinal 0 in the emitted edit', () => {
  // The body occupies BODY_PART_INDEX only while it EXISTS. Once it is gone the bake writes no
  // component for it, so `<part>` position 0 is the object's first added volume -- and the type or
  // per-part settings the user had given the body would land on that volume in the saved file,
  // silently. Dropped at the EMIT rather than by the delete, so an undo brings the body's own type
  // back with it.
  const base = seedEmptyEditorState()
  const instance = {
    ...base.plates[0]!.instances[0],
    key: 'inst-body-ordinal',
    objectId: 41,
    parts: [],
    printable: true,
    bodyRemoved: true,
    source: { kind: 'object' as const },
    position: new THREE.Vector3(), rotation: new THREE.Euler(), scale: new THREE.Vector3(1, 1, 1)
  } as never as EditorInstance
  const state: EditorState = {
    ...base,
    plates: [{ ...base.plates[0]!, instances: [instance] }],
    partTypeChanges: {
      [partSlotKey(41, BODY_PART_INDEX)]: 'modifier_part',
      [partSlotKey(41, 1)]: 'support_blocker'
    },
    partProcessOverrides: {
      [partSlotKey(41, BODY_PART_INDEX)]: { wall_loops: '5' },
      [partSlotKey(41, 1)]: { wall_loops: '9' }
    }
  }

  const edit = buildSceneEdit(state)
  assert.deepEqual(edit.partTypeChanges, [{ objectId: 41, partIndex: 1, subtype: 'support_blocker' }],
    "the deleted body's type retargeted the volume that took ordinal 0")
  assert.deepEqual(edit.partProcessOverrides, [{ objectId: 41, partIndex: 1, overrides: { wall_loops: '9' } }],
    "the deleted body's settings retargeted the volume that took ordinal 0")

  // The inverse: with the body still there, ordinal 0 is its own and must be emitted.
  const kept = { ...state, plates: [{ ...state.plates[0]!, instances: [{ ...instance, bodyRemoved: undefined }] }] }
  const keptEdit = buildSceneEdit(kept)
  assert.equal(keptEdit.partTypeChanges?.length, 2)
  assert.equal(keptEdit.partProcessOverrides?.length, 2)
})

test('a cut connector is not a volume row, so a cut half reads as one object', () => {
  // BambuStudio leaves connectors out of the count that decides whether an object gets rows at all
  // (`can_add_volumes_to_object`). Counting them made a cut half list an object row, a body row
  // carrying the SAME name, and a row per peg -- reported from the viewport as "cube left is not
  // there twice" against Studio's single row.
  const half = {
    parts: [
      { partIndex: 0, subtype: null },
      { partIndex: 1, subtype: null, cutConnector: true }
    ]
  } as never
  const rows = instanceVolumeRows(half, 0)
  assert.equal(rows.showRows, false, 'a body plus one connector is a single-volume object')
  assert.equal(rows.cutConnectorCount, 1)
})

test('two real volumes still list, connectors or not', () => {
  const object = {
    parts: [
      { partIndex: 0, subtype: null },
      { partIndex: 1, subtype: null },
      { partIndex: 2, subtype: null, cutConnector: true }
    ]
  } as never
  const rows = instanceVolumeRows(object, 0)
  assert.equal(rows.showRows, true)
  assert.equal(rows.cutConnectorCount, 1)
})

test('an object whose only baked volumes are connectors still gets a body row', () => {
  // The body row exists when the part list does not describe the object. Connectors do not
  // describe it either, so an added volume beside them must still surface the body.
  const rows = instanceVolumeRows({ parts: [{ partIndex: 0, subtype: null, cutConnector: true }] } as never, 1)
  assert.equal(rows.showBodyRow, true)
  assert.equal(rows.showRows, true)
  assert.equal(rows.cutConnectorCount, 1)
})

/**
 * The sidebar's `xN` badge only appeared after a save and reopen, because linkage was keyed on the
 * Bambu `objectId` and every session-added instance carries `objectId: 0` until a save mints one.
 * A linked duplicate of an import shares its `importId`/`replacedObjectId` instead, and that IS the
 * identity the bake later hangs both build items off.
 */
function instanceWith(source: EditorInstance['source'], objectId: number): EditorInstance {
  return { key: `k${Math.round(objectId * 1000)}`, source, objectId } as EditorInstance
}

test('two instances of one file-backed object share a linkage identity', () => {
  const a = instanceWith({ kind: 'object' }, 7)
  const b = instanceWith({ kind: 'object' }, 7)
  assert.equal(instanceLinkageKey(a), instanceLinkageKey(b))
  assert.notEqual(instanceLinkageKey(a), instanceLinkageKey(instanceWith({ kind: 'object' }, 8)))
})

test('a linked duplicate of a SESSION import shares its identity before any save', () => {
  // The reported bug: both carry `objectId: 0`, so an objectId comparison called them unrelated
  // (or, worse, called every unrelated import a copy of every other).
  const source = instanceWith({ kind: 'import', importId: 'imp-1', meshUrl: '/m/1', replacedObjectId: -3 }, 0)
  const copy = instanceWith({ kind: 'import', importId: 'imp-1', meshUrl: '/m/1', replacedObjectId: -3 }, 0)
  assert.equal(instanceLinkageKey(source), instanceLinkageKey(copy))
})

test('two DIFFERENT imports are not linked, though both carry objectId 0', () => {
  const first = instanceWith({ kind: 'import', importId: 'imp-1', meshUrl: '/m/1' }, 0)
  const second = instanceWith({ kind: 'import', importId: 'imp-2', meshUrl: '/m/2' }, 0)
  assert.notEqual(instanceLinkageKey(first), instanceLinkageKey(second))
})

test('an import identifies by its replaced object, so a "Replace with..." pair agrees', () => {
  // `replacedObjectId` is the stable per-object identity the editor hangs settings on; two
  // instances of one replacement agree on it even though the import that fed them is incidental.
  const first = instanceWith({ kind: 'import', importId: 'imp-a', meshUrl: '/m/a', replacedObjectId: 12 }, 0)
  const second = instanceWith({ kind: 'import', importId: 'imp-b', meshUrl: '/m/b', replacedObjectId: 12 }, 0)
  assert.equal(instanceLinkageKey(first), instanceLinkageKey(second))
})

test('unlinking a file-backed copy separates it, since it reassigns the object id', () => {
  const state = { plates: [], objectClones: {} } as unknown as EditorState
  const copy = instanceWith({ kind: 'object' }, 7)
  const before = instanceLinkageKey(copy)
  makeInstanceIndependent(state, copy)
  assert.notEqual(instanceLinkageKey(copy), before)
})

/**
 * "Duplicate as independent copy" on a SESSION-ADDED model used to return the linked pair it was
 * asked to break: `makeInstanceIndependent` bailed on anything import-backed, on the reasoning that
 * an import is "independent by nature". That held only while nothing could copy one; a linked
 * duplicate copies `importId` and `replacedObjectId` verbatim, so both instances shared their object
 * identity and their mesh.
 */
test('an independent copy of a session import stops sharing its object identity', () => {
  const state = { plates: [], objectClones: {} } as unknown as EditorState
  const copy = instanceWith({ kind: 'import', importId: 'imp-1', meshUrl: '/m/1', replacedObjectId: -3 }, 0)
  const before = instanceLinkageKey(copy)

  makeInstanceIndependent(state, copy)

  assert.notEqual(instanceLinkageKey(copy), before, 'it no longer shares the source\'s identity')
  assert.equal(copy.source.kind, 'import', 'it is still import-backed')
  assert.notEqual((copy.source as { replacedObjectId?: number }).replacedObjectId, -3)
})

test('unlinking a session import does not register a bake clone, having no baked object to copy', () => {
  // `objectClones` drives the bake's pre-pass, which deep-copies a BAKED object's XML and mesh.
  // An import has neither; the bake builds its object from the staged import instead, so an entry
  // here would point that pre-pass at an id no source object exists for.
  const state = { plates: [], objectClones: {} } as unknown as EditorState
  const copy = instanceWith({ kind: 'import', importId: 'imp-1', meshUrl: '/m/1', replacedObjectId: -3 }, 0)

  makeInstanceIndependent(state, copy)

  assert.deepEqual(state.objectClones, {})
})

test('a file-backed unlink still registers its clone against the source object', () => {
  const state = { plates: [], objectClones: {} } as unknown as EditorState
  const copy = instanceWith({ kind: 'object' }, 7)

  makeInstanceIndependent(state, copy)

  assert.equal(Object.values(state.objectClones ?? {})[0], 7, 'the clone still points back at object 7')
})
