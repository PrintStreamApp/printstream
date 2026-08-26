/**
 * "Replace with…" keeps the object's IDENTITY, so it must keep the object's per-object PROCESS
 * overrides. The replacement is a freshly rendered object carrying none of its own, and the source
 * object's block is gone from the baked document, so unless the bake carries them across they are
 * simply lost.
 *
 * WHY THIS IS A BAKE INVARIANT AND NOT THE CALLER'S JOB. Until this test, the only thing restoring
 * them was the caller re-sending the whole override set and the bake re-keying it. A SAVE does send
 * it unconditionally, so a saved file looked correct and the editor kept showing the setting. A
 * SLICE sends only what the user CHANGED against the file, so an override nobody touched was absent
 * from the request, the re-key had nothing to move, and the file handed to the engine lost it.
 *
 * The observed failure: an object with `enable_support` on, against a process preset with supports
 * off, stopped generating any support the moment its mesh was replaced. Nothing reported an error,
 * the project still said supports were on, and turning supports on GLOBALLY appeared to "fix" it,
 * because `project_settings.config` is untouched by a replacement.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planEditedThreeMf, type ThreeMfBakeSource } from './bake.js'
import type { ImportedObjectInput } from './bake-documents.js'

const REPLACED_OBJECT_ID = 281

const MODEL_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
  '  <metadata name="Application">BambuStudio-02.07.01.57</metadata>',
  '  <resources>',
  `    <object id="${REPLACED_OBJECT_ID}" type="model"><mesh>`,
  '      <vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices>',
  '      <triangles><triangle v1="0" v2="1" v3="2"/></triangles>',
  '    </mesh></object>',
  '  </resources>',
  '  <build>',
  `    <item objectid="${REPLACED_OBJECT_ID}" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>`,
  '  </build>',
  '</model>'
].join('\n')

const MODEL_SETTINGS_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<config>',
  `  <object id="${REPLACED_OBJECT_ID}">`,
  '    <metadata key="enable_support" value="1"/>',
  '    <metadata key="support_threshold_angle" value="45"/>',
  '    <metadata key="name" value="Generic Cover"/>',
  '    <metadata key="extruder" value="1"/>',
  `    <part id="${REPLACED_OBJECT_ID}" subtype="normal_part">`,
  '      <metadata key="name" value="Generic Cover"/>',
  '    </part>',
  '  </object>',
  '  <plate>',
  '    <metadata key="plater_id" value="1"/>',
  `    <model_instance><metadata key="object_id" value="${REPLACED_OBJECT_ID}"/><metadata key="instance_id" value="0"/></model_instance>`,
  '  </plate>',
  '</config>'
].join('\n')

function source(): ThreeMfBakeSource {
  return {
    hasBase: true,
    modelXml: MODEL_XML,
    modelSettingsXml: MODEL_SETTINGS_XML,
    projectSettingsJson: JSON.stringify({ filament_colour: ['#FFFFFF'], enable_support: '0' }),
    customGcodeXml: null,
    sliceInfoXml: null,
    modelRelsXml: null,
    subModelEntries: new Map()
  } as unknown as ThreeMfBakeSource
}

const IMPORTS: ImportedObjectInput[] = [{
  importId: 'imp-1',
  name: 'Generic Cover (replaced)',
  mesh: {
    positions: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10],
    indices: [0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3],
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } }
  }
} as unknown as ImportedObjectInput]

function replacementEdit() {
  return {
    plates: [{ index: 1, sourceIndex: 1 }],
    instances: [{
      importId: 'imp-1',
      plateIndex: 1,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      printable: true
    }],
    meshReplacements: [{ objectId: REPLACED_OBJECT_ID, importId: 'imp-1' }]
  } as never
}

/** The `model_settings.config` a plan writes, whichever branch produced it. */
function bakedModelSettings(plan: ReturnType<typeof planEditedThreeMf>): string {
  const transform = plan.copy?.transforms.get('Metadata/model_settings.config')
  if (transform) {
    const out = transform(MODEL_SETTINGS_XML)
    assert.ok(out, 'the bake dropped model_settings.config')
    return out
  }
  const fresh = plan.freshEntries?.find((entry) => entry.name === 'Metadata/model_settings.config')
  assert.ok(fresh, 'the bake wrote no model_settings.config at all')
  return fresh.content
}

/** The head metadata of one baked object (everything before its first `<part>`). */
function objectHead(xml: string, objectId: number): string {
  const block = new RegExp(`<object\\b[^>]*\\bid="${objectId}"[^>]*>([\\s\\S]*?)</object>`).exec(xml)?.[1]
  assert.ok(block, `no baked object ${objectId}`)
  return block.split('<part')[0]!
}

test('a replaced object keeps its per-object process overrides when the caller sends none', () => {
  // The exact shape of a SLICE the user never touched the per-object settings on: no
  // `objectProcessOverrides` in the request, because nothing differed from the file.
  const plan = planEditedThreeMf(source(), replacementEdit(), IMPORTS, {})

  const [mapping] = plan.result.replacedObjectIds
  assert.ok(mapping, 'the bake reported no replacement mapping')
  assert.equal(mapping.originalObjectId, REPLACED_OBJECT_ID)

  const head = objectHead(bakedModelSettings(plan), mapping.bakedObjectId)
  assert.match(head, /key="enable_support" value="1"/, 'the replacement lost the object\'s support override')
  assert.match(head, /key="support_threshold_angle" value="45"/, 'the replacement lost a second override')
})

test('a caller-supplied override still wins over the inherited set', () => {
  // The user turned the object's supports OFF in the same session as the replace. What they
  // chose must beat what the file happened to carry, keyed by the id the REQUEST used.
  const plan = planEditedThreeMf(source(), replacementEdit(), IMPORTS, {
    objectProcessOverrides: { [String(REPLACED_OBJECT_ID)]: { enable_support: '0' } }
  })

  const [mapping] = plan.result.replacedObjectIds
  assert.ok(mapping)
  const head = objectHead(bakedModelSettings(plan), mapping.bakedObjectId)
  assert.match(head, /key="enable_support" value="0"/, 'the inherited value overwrote the user\'s choice')
  assert.doesNotMatch(
    head,
    /key="support_threshold_angle"/,
    'inheriting must not resurrect keys the caller\'s replacement set deliberately omits'
  )
})

test('an ordinary import that replaces nothing inherits no overrides', () => {
  // Guard against the inheritance leaking onto plain "Add model" imports, which have no
  // identity to inherit from: the source object stays in the file and keeps its own settings.
  const edit = {
    plates: [{ index: 1, sourceIndex: 1 }],
    instances: [
      { objectId: REPLACED_OBJECT_ID, plateIndex: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, printable: true },
      { importId: 'imp-1', plateIndex: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, printable: true }
    ]
  } as never
  const plan = planEditedThreeMf(source(), edit, IMPORTS, {})
  assert.equal(plan.result.replacedObjectIds.length, 0)

  const xml = bakedModelSettings(plan)
  const importedId = plan.result.importObjectIds[0]?.objectId
  assert.ok(importedId != null)
  assert.doesNotMatch(objectHead(xml, importedId), /enable_support/, 'a plain import inherited an unrelated object\'s settings')
  assert.match(objectHead(xml, REPLACED_OBJECT_ID), /key="enable_support" value="1"/, 'the untouched source object lost its own override')
})
