/**
 * An object's material must be written at OBJECT level, not only on its `<part>`.
 *
 * BambuStudio's CLI slices an object by its object-level `extruder`; a part-level entry alone is
 * not honored for an inline-mesh object, so the object silently prints with filament 1. A/B-proven
 * on a real project (CHM - H2): plate objects assigned material 2 sliced as PLA filament 1 until
 * the object-level metadata was added, after which the same file sliced as PETG filament 2.
 * Desktop BambuStudio always writes the extruder at both levels; these tests pin that shape on
 * every path that authors or rewrites an object's material.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildEditedThreeMfDocuments,
  NEW_PROJECT_MODEL_SETTINGS_XML,
  NEW_PROJECT_MODEL_XML,
  type ImportedObjectInput
} from './bake-documents'
import type { SceneEdit } from '../slicing'

const TRIANGLE = {
  positions: [0, 0, 0, 10, 0, 0, 0, 10, 0],
  indices: [0, 1, 2],
  bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 } }
}

const at = { x: 0, y: 0, z: 0 }

function editWith(overrides: Partial<SceneEdit>): SceneEdit {
  return {
    plates: [{ index: 1 }],
    instances: [],
    ...overrides
  } as SceneEdit
}

/** The `<object id="N">…</object>` block of a model_settings document. */
function objectBlock(modelSettingsXml: string, objectId: number): string {
  const match = modelSettingsXml.match(new RegExp(`<object id="${objectId}">[\\s\\S]*?</object>`))
  assert.ok(match, `model_settings must contain object ${objectId}:\n${modelSettingsXml}`)
  return match[0]
}

/** Object-LEVEL extruder: the `extruder` metadata outside every `<part>` block. */
function objectLevelExtruder(block: string): string | null {
  const withoutParts = block.replace(/<part\b[\s\S]*?<\/part>/g, '')
  const match = withoutParts.match(/<metadata key="extruder" value="([^"]*)"\/>/)
  return match ? match[1]! : null
}

function partExtruders(block: string): Array<string | null> {
  return [...block.matchAll(/<part\b[\s\S]*?<\/part>/g)].map(([part]) => {
    const match = part.match(/<metadata key="extruder" value="([^"]*)"\/>/)
    return match ? match[1]! : null
  })
}

test('a single-mesh import writes its filament at object level and part level', () => {
  const edit = editWith({
    instances: [{ importId: 'imp-1', plateIndex: 1, position: at, rotation: at, scale: { x: 1, y: 1, z: 1 }, filamentId: 2 }]
  })
  const imports: ImportedObjectInput[] = [{ importId: 'imp-1', name: 'M - Track', mesh: TRIANGLE }]
  const { modelSettingsXml, importIdToObjectId } = buildEditedThreeMfDocuments(
    NEW_PROJECT_MODEL_XML,
    NEW_PROJECT_MODEL_SETTINGS_XML,
    null,
    edit,
    imports
  )
  const block = objectBlock(modelSettingsXml, importIdToObjectId.get('imp-1')!)
  // The object-level entry is what the CLI slices by; without it the object prints as filament 1.
  assert.equal(objectLevelExtruder(block), '2', `object-level extruder must be written:\n${block}`)
  assert.deepEqual(partExtruders(block), ['2'])
})

test('a multi-solid import writes the object filament at object level and per-solid overrides on the parts', () => {
  const edit = editWith({
    instances: [{ importId: 'imp-2', plateIndex: 1, position: at, rotation: at, scale: { x: 1, y: 1, z: 1 }, filamentId: 2 }],
    importPartFilaments: [{ importId: 'imp-2', partIndex: 1, filamentId: 3 }]
  })
  const imports: ImportedObjectInput[] = [{
    importId: 'imp-2',
    name: 'Assembly',
    mesh: TRIANGLE,
    parts: [
      { name: 'Solid A', mesh: TRIANGLE },
      { name: 'Solid B', mesh: TRIANGLE }
    ]
  }]
  const { modelSettingsXml, importIdToObjectId } = buildEditedThreeMfDocuments(
    NEW_PROJECT_MODEL_XML,
    NEW_PROJECT_MODEL_SETTINGS_XML,
    null,
    edit,
    imports
  )
  const block = objectBlock(modelSettingsXml, importIdToObjectId.get('imp-2')!)
  assert.equal(objectLevelExtruder(block), '2', `object-level extruder must be written:\n${block}`)
  // Solid A inherits the object's filament; Solid B keeps its own reassignment.
  assert.deepEqual(partExtruders(block), ['2', '3'])
})

const BASE_MODEL_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
  '  <metadata name="Application">BambuStudio-02.07.01.57</metadata>',
  '  <resources>',
  '   <object id="10" type="model">',
  '    <mesh>',
  '     <vertices>',
  '      <vertex x="0" y="0" z="0"/>',
  '      <vertex x="10" y="0" z="0"/>',
  '      <vertex x="0" y="10" z="0"/>',
  '     </vertices>',
  '     <triangles>',
  '      <triangle v1="0" v2="1" v3="2"/>',
  '     </triangles>',
  '    </mesh>',
  '   </object>',
  '   <object id="20" type="model">',
  '    <mesh>',
  '     <vertices>',
  '      <vertex x="0" y="0" z="0"/>',
  '      <vertex x="10" y="0" z="0"/>',
  '      <vertex x="0" y="10" z="0"/>',
  '     </vertices>',
  '     <triangles>',
  '      <triangle v1="0" v2="1" v3="2"/>',
  '     </triangles>',
  '    </mesh>',
  '   </object>',
  '  </resources>',
  '  <build>',
  '   <item objectid="10" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>',
  '   <item objectid="20" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>',
  '  </build>',
  '</model>'
].join('\n')

const BASE_MODEL_SETTINGS_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<config>',
  '  <object id="10">',
  '    <metadata key="name" value="Widget"/>',
  '    <metadata key="extruder" value="1"/>',
  '    <part id="10" subtype="normal_part">',
  '      <metadata key="name" value="Widget"/>',
  '      <metadata key="extruder" value="1"/>',
  '    </part>',
  '  </object>',
  '  <object id="20">',
  '    <metadata key="name" value="Duo"/>',
  '    <metadata key="extruder" value="1"/>',
  '    <part id="20" subtype="normal_part">',
  '      <metadata key="name" value="Half A"/>',
  '      <metadata key="extruder" value="1"/>',
  '    </part>',
  '    <part id="21" subtype="normal_part">',
  '      <metadata key="name" value="Half B"/>',
  '      <metadata key="extruder" value="3"/>',
  '    </part>',
  '  </object>',
  '  <plate>',
  '    <metadata key="plater_id" value="1"/>',
  '  </plate>',
  '</config>'
].join('\n')

function bakeBaseWith(partFilaments: SceneEdit['partFilaments']): string {
  const edit = editWith({
    instances: [
      { objectId: 10, plateIndex: 1, position: at, rotation: at, scale: { x: 1, y: 1, z: 1 } },
      { objectId: 20, plateIndex: 1, position: at, rotation: at, scale: { x: 1, y: 1, z: 1 } }
    ],
    partFilaments
  })
  return buildEditedThreeMfDocuments(BASE_MODEL_XML, BASE_MODEL_SETTINGS_XML, null, edit, []).modelSettingsXml
}

test('reassigning every part of an object moves the object-level extruder with it', () => {
  const modelSettingsXml = bakeBaseWith([{ objectId: 10, partIndex: 0, filamentId: 2 }])
  const block = objectBlock(modelSettingsXml, 10)
  assert.deepEqual(partExtruders(block), ['2'])
  // A stale object-level `1` here is what the CLI would slice by: the part change must carry it.
  assert.equal(objectLevelExtruder(block), '2', `object-level extruder must follow the parts:\n${block}`)
})

test('reassigning one part of a mixed-material object leaves the object-level extruder alone', () => {
  const modelSettingsXml = bakeBaseWith([{ objectId: 20, partIndex: 0, filamentId: 2 }])
  const block = objectBlock(modelSettingsXml, 20)
  assert.deepEqual(partExtruders(block), ['2', '3'])
  // Parts now disagree (2 vs 3): the object's own default is not derivable, so it must not change.
  assert.equal(objectLevelExtruder(block), '1')
})

/**
 * An imported object with NO filament of its own must still be BOUND, not left implicit.
 *
 * Reproduces a real project: a multi-solid 3MF imported onto a plate carried per-solid materials
 * for its lettering but none for its body, and the instance itself had none (an import starts at
 * `filamentId: null`). The bake wrote the lettering's `extruder` on its parts and NOTHING at object
 * level, so the body printed filament 1 only because the ENGINE defaults it there
 * (`bbs_3mf.cpp`: object extruder `0`/out-of-range -> 1). The file said nothing, the sidebar showed
 * "1", and the saved project was flagged `objectExtruder` with mixed part coverage, which the repair
 * declines to touch, a dead end the user could not clear.
 *
 * Binding to 1 is what BambuStudio itself materialises on load, so it is behaviour-preserving by
 * construction: every uncovered part already prints filament 1.
 */
test('an imported object with no filament of its own is bound to filament 1, not left implicit', () => {
  const edit = editWith({
    // No `filamentId` on the instance: nothing in the session claims a material for the object.
    instances: [{ importId: 'imp-3', plateIndex: 1, position: at, rotation: at, scale: { x: 1, y: 1, z: 1 } }],
    // Only the lettering solid carries one, exactly as the imported 3MF supplied it.
    importPartFilaments: [{ importId: 'imp-3', partIndex: 1, filamentId: 2 }]
  } as Partial<SceneEdit>)
  const imports: ImportedObjectInput[] = [{
    importId: 'imp-3',
    name: 'Branded Clipboard',
    mesh: TRIANGLE,
    parts: [
      { name: 'Clipboard', mesh: TRIANGLE },
      { name: 'Lettering', mesh: TRIANGLE }
    ]
  }]
  const { modelSettingsXml, importIdToObjectId } = buildEditedThreeMfDocuments(
    NEW_PROJECT_MODEL_XML,
    NEW_PROJECT_MODEL_SETTINGS_XML,
    null,
    edit,
    imports
  )
  const block = objectBlock(modelSettingsXml, importIdToObjectId.get('imp-3')!)
  assert.equal(objectLevelExtruder(block), '1', `an unassigned object must still be bound:\n${block}`)
  // The body follows the object's binding; the lettering keeps the material it came in with.
  assert.deepEqual(partExtruders(block), ['1', '2'])
})

test('a single-mesh import with no filament of its own is bound to filament 1', () => {
  const edit = editWith({
    instances: [{ importId: 'imp-4', plateIndex: 1, position: at, rotation: at, scale: { x: 1, y: 1, z: 1 } }]
  } as Partial<SceneEdit>)
  const imports: ImportedObjectInput[] = [{ importId: 'imp-4', name: 'Plain', mesh: TRIANGLE }]
  const { modelSettingsXml, importIdToObjectId } = buildEditedThreeMfDocuments(
    NEW_PROJECT_MODEL_XML,
    NEW_PROJECT_MODEL_SETTINGS_XML,
    null,
    edit,
    imports
  )
  const block = objectBlock(modelSettingsXml, importIdToObjectId.get('imp-4')!)
  assert.equal(objectLevelExtruder(block), '1', `an unassigned import must still be bound:\n${block}`)
  assert.deepEqual(partExtruders(block), ['1'])
})
