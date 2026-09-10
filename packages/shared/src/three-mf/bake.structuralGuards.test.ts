/**
 * The two structural invariants a bake must never write, both engine-fatal rather than cosmetic:
 * a build item naming a missing object (`bbs_3mf.cpp:4205-4210` aborts the parse) and a component
 * cycle (`:4992-5016` walks components with no visited set, so it hangs then runs out of memory).
 *
 * The placement one is also silent DATA LOSS on our side, which is why it throws rather than
 * dropping the instance: `removeUnreferencedObjects` is seeded from the build items, so an id that
 * names nothing leaves the real objects unreferenced and strips them from the saved file.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planEditedThreeMf, type ThreeMfBakeSource } from './bake.js'
import { sceneEditAddedPartSchema } from '../slicing.js'
import type { SceneEdit } from '../slicing.js'

const MODEL_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<model unit="millimeter">',
  ' <resources>',
  '  <object id="1" type="model"><mesh><vertices/><triangles/></mesh></object>',
  '  <object id="2" type="model"><mesh><vertices/><triangles/></mesh></object>',
  ' </resources>',
  ' <build><item objectid="1"/><item objectid="2"/></build>',
  '</model>'
].join('\n')

const MODEL_SETTINGS_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<config>',
  '  <object id="1"><metadata key="name" value="A"/></object>',
  '  <object id="2"><metadata key="name" value="B"/></object>',
  '</config>'
].join('\n')

function source(): ThreeMfBakeSource {
  return {
    modelXml: MODEL_XML,
    modelSettingsXml: MODEL_SETTINGS_XML,
    projectSettingsJson: null,
    customGcodeXml: null,
    sliceInfoXml: null,
    modelRelsXml: null,
    subModelEntries: new Map(),
    hasBase: true
  }
}

function editPlacing(objectIds: number[]): SceneEdit {
  return {
    plates: [{ index: 1 }],
    instances: objectIds.map((objectId) => ({
      objectId,
      plateIndex: 1,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 }
    }))
  } as unknown as SceneEdit
}

test('placing an object the project does not contain is refused', () => {
  // Before this guard the save succeeded and objects 1 and 2 were swept out as unreferenced, so the
  // file came back with no geometry and one item pointing at 9999.
  assert.throws(() => planEditedThreeMf(source(), editPlacing([1, 9999])), /9999.*does not contain/)
})

test('the refusal names every missing object, not just the first', () => {
  assert.throws(() => planEditedThreeMf(source(), editPlacing([7, 8])), /objects 7, 8/)
})

test('placing objects that do exist still bakes', () => {
  const plan = planEditedThreeMf(source(), editPlacing([1, 2]))
  const modelXml = plan.copy?.transforms.get('3D/3dmodel.model')?.('') ?? ''
  assert.match(modelXml, /<item objectid="1"/)
  assert.match(modelXml, /<item objectid="2"/)
})

test('dropping an object from the plate is a normal edit, not a missing reference', () => {
  // The guard must fire on ids that name NOTHING, never on an object deliberately left unplaced.
  const plan = planEditedThreeMf(source(), editPlacing([1]))
  const modelXml = plan.copy?.transforms.get('3D/3dmodel.model')?.('') ?? ''
  assert.doesNotMatch(modelXml, /<item objectid="2"/)
})

test('an added part cannot name its own host as its geometry', () => {
  // The one cycle shape a single request can state; the bake's graph check covers the rest.
  const selfHosted = {
    importId: 'import-a',
    meshImportId: 'import-a',
    subtype: 'normal_part',
    name: 'Part',
    matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
  }
  const result = sceneEditAddedPartSchema.safeParse(selfHosted)
  assert.equal(result.success, false)
  assert.match(JSON.stringify(result.error?.issues ?? []), /its own host/)

  const distinct = sceneEditAddedPartSchema.safeParse({ ...selfHosted, meshImportId: 'import-b' })
  assert.equal(distinct.success, true, 'a normal added part must still validate')
})

test('a sparse plate numbering is refused', () => {
  // BambuStudio indexes plate_data_list by plater_id - 1 and rejects any id above the plate count
  // (`bbs_3mf.cpp:2323-2329`), so [1, 3] refuses the whole project on open.
  const edit = { ...editPlacing([1]), plates: [{ index: 1 }, { index: 3 }] } as unknown as SceneEdit
  assert.throws(() => planEditedThreeMf(source(), edit), /plates must be numbered 1 to 2/)
})

test('plates out of order but dense are fine', () => {
  // Order is not the rule; density is. Sorting already handled this and must keep working.
  const edit = { ...editPlacing([1]), plates: [{ index: 2 }, { index: 1 }] } as unknown as SceneEdit
  assert.doesNotThrow(() => planEditedThreeMf(source(), edit))
})

test('a zero scale axis is refused whichever form it arrived in', () => {
  // The matrix field was already guarded; the TRS form composed to the same twelve numbers and was
  // not. A zero axis makes the importer drop the WHOLE transform, losing position and rotation too.
  const trs = {
    plates: [{ index: 1 }],
    instances: [{ objectId: 1, plateIndex: 1, position: { x: 5, y: 5, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 0, y: 1, z: 1 } }]
  } as unknown as SceneEdit
  assert.throws(() => planEditedThreeMf(source(), trs), /degenerate transform.*column 1/)
})

test('a mirrored object is not degenerate', () => {
  // Mirroring is a negative scale, which the editor offers. A basis column's LENGTH ignores sign, so
  // testing the factor instead of the length would refuse a legitimate everyday edit.
  const mirrored = {
    plates: [{ index: 1 }],
    instances: [{ objectId: 1, plateIndex: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: -1, y: 1, z: 1 } }]
  } as unknown as SceneEdit
  assert.doesNotThrow(() => planEditedThreeMf(source(), mirrored))
})

test('a save over a base with no generator marker adds one', () => {
  // The marker only ever came from the from-scratch scaffold, so a copy-path save inherited its
  // absence and produced a project BambuStudio opens with every setting dropped -- and the saved
  // file had no marker either, so re-saving could never recover it.
  const unmarked = { ...source(), modelXml: MODEL_XML }
  assert.doesNotMatch(MODEL_XML, /Application/, 'the fixture must start WITHOUT a marker')
  const plan = planEditedThreeMf(unmarked, editPlacing([1]))
  const modelXml = plan.copy?.transforms.get('3D/3dmodel.model')?.('') ?? ''
  assert.match(modelXml, /<metadata name="Application">BambuStudio-/)
})

test('a base that already names BambuStudio keeps its own version', () => {
  const marked = MODEL_XML.replace('<model unit="millimeter">', '<model unit="millimeter">\n  <metadata name="Application">BambuStudio-01.09.00.00</metadata>')
  const plan = planEditedThreeMf({ ...source(), modelXml: marked }, editPlacing([1]))
  const modelXml = plan.copy?.transforms.get('3D/3dmodel.model')?.('') ?? ''
  assert.match(modelXml, /BambuStudio-01\.09\.00\.00/, 'the real generator version was overwritten')
})

test('a settings document that would name no filament is skipped, not refused', () => {
  // BambuStudio throws on a settings document whose `filament_colour` is absent or empty
  // (`PresetBundle.cpp:3723-3727`), so writing one makes the project unopenable. Refusing the SAVE
  // was tried and was wrong: a project with no settings entry at all is fine, and this same bake
  // writes exactly that when no transform applies, so throwing here refused a file class it emits.
  const noFilaments = {
    plates: [{ index: 1, plateType: 'Textured PEI Plate' }],
    instances: []
  } as unknown as SceneEdit
  const bare: ThreeMfBakeSource = { ...source(), projectSettingsJson: null, hasBase: false }
  const plan = planEditedThreeMf(bare, noFilaments)
  const entries = [...(plan.copy?.appendEntries ?? []), ...(plan.freshEntries ?? [])]
  assert.ok(!entries.some((entry) => entry.name === 'Metadata/project_settings.config'),
    'a settings document naming no filament was written, which BambuStudio refuses to open')
})

test('a from-scratch save WITH a filament is fine', () => {
  // The control: the scaffold seeds one filament, so the ordinary new-project path must still bake.
  const withFilament = {
    plates: [{ index: 1, plateType: 'Textured PEI Plate' }],
    instances: [],
    filaments: [{ color: '#FFFFFF', type: 'PLA', settingsId: 'Bambu PLA Basic' }]
  } as unknown as SceneEdit
  const bare: ThreeMfBakeSource = { ...source(), projectSettingsJson: null, hasBase: false }
  assert.doesNotThrow(() => planEditedThreeMf(bare, withFilament))
})

test('a save preserves the plate settings the SceneEdit cannot express', () => {
  // Every save re-renders the plate blocks from the edit, so these were discarded wholesale. A
  // vase-mode plate came back solid and a by-object plate came back by-layer, with no error.
  const settingsWithPlate = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<config>',
    '  <object id="1"><metadata key="name" value="A"/></object>',
    '  <plate>',
    '    <metadata key="plater_id" value="1"/>',
    '    <metadata key="bed_type" value="Cool Plate"/>',
    '    <metadata key="print_sequence" value="by object"/>',
    '    <metadata key="spiral_mode" value="1"/>',
    '  </plate>',
    '</config>'
  ].join('\n')
  const plan = planEditedThreeMf({ ...source(), modelSettingsXml: settingsWithPlate }, editPlacing([1]))
  const out = plan.copy?.transforms.get('Metadata/model_settings.config')?.('') ?? ''
  // `bed_type` is deliberately NOT carried. This edit names no global plate type, so it is one from
  // before per-plate bed types: its plates describe the global rather than overriding it, and the
  // global is authored into `project_settings.config` instead. Carrying the source's value here
  // would outlive the user's next Settings-tab change.
  assert.doesNotMatch(out, /key="bed_type"/)
  assert.match(out, /key="print_sequence" value="by object"/)
  assert.match(out, /key="spiral_mode" value="1"/)
  // And exactly one plater_id: the carried entries must not duplicate what the save authors.
  assert.equal(out.match(/key="plater_id"/g)?.length, 1)
})

test('a filamentId above the project material count is rejected at the boundary', async () => {
  // BambuStudio clamps such an index to 1 at load (`bbs_3mf.cpp:2283-2298`), so the object silently
  // prints in the WRONG MATERIAL rather than failing, and the bad index stays on disk to do it
  // again on the next open. The bake authors these ids AFTER its slot remap, so the remap that
  // clamps a bad index inherited from the base file cannot also catch one the request supplied.
  const { sceneEditSchema } = await import('../slicing.js')
  const base = { plates: [{ index: 1 }], instances: [], filaments: [{ color: '#ffffff' }, { color: '#000000' }] }

  const inRange = sceneEditSchema.safeParse({ ...base, partFilaments: [{ objectId: 1, partIndex: 0, filamentId: 2 }] })
  assert.equal(inRange.success, true, 'a valid material id was refused')

  const overflow = sceneEditSchema.safeParse({ ...base, partFilaments: [{ objectId: 1, partIndex: 0, filamentId: 5 }] })
  assert.equal(overflow.success, false)
  assert.match(JSON.stringify(overflow.error?.issues ?? []), /above this project's 2 materials/)

  // Every seam that carries a filament id, not just parts.
  const addedPart = sceneEditSchema.safeParse({
    ...base,
    addedParts: [{ objectId: 1, meshImportId: 'm1', subtype: 'normal_part', name: 'P', matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], filamentId: 5 }]
  })
  assert.equal(addedPart.success, false, 'an added part could still name a material that does not exist')
})

test('an edit that carries no filament list is not range-checked', () => {
  // The count is unknown there, and inventing one would refuse valid slice-time edits. The bake's
  // own remap still clamps whatever the BASE file carried.
  const noFilaments = { plates: [{ index: 1 }], instances: [], partFilaments: [{ objectId: 1, partIndex: 0, filamentId: 9 }] }
  return import('../slicing.js').then(({ sceneEditSchema }) => {
    assert.equal(sceneEditSchema.safeParse(noFilaments).success, true)
  })
})

test('a carried plate setting follows its SOURCE plate through a delete', () => {
  // The carry looked the source block up by the plate's NEW position, so deleting a plate handed
  // the deleted plate's bed type and vase mode to whichever plate took its number -- the exact
  // misattribution the carry exists to prevent. Found by adversarial review, not by a test.
  const settingsWithPlates = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<config>',
    '  <object id="1"><metadata key="name" value="A"/></object>',
    '  <plate><metadata key="plater_id" value="1"/><metadata key="spiral_mode" value="1"/></plate>',
    '  <plate><metadata key="plater_id" value="2"/><metadata key="print_sequence" value="by object"/></plate>',
    '</config>'
  ].join('\n')
  // Source plate 1 is deleted; source plate 2 survives and renumbers to position 1.
  const edit = {
    plates: [{ index: 1, sourceIndex: 2 }],
    instances: [{ objectId: 1, plateIndex: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }]
  } as unknown as SceneEdit
  const plan = planEditedThreeMf({ ...source(), modelSettingsXml: settingsWithPlates }, edit)
  const out = plan.copy?.transforms.get('Metadata/model_settings.config')?.('') ?? ''
  assert.match(out, /key="print_sequence" value="by object"/, "the surviving plate lost its own setting")
  assert.doesNotMatch(out, /spiral_mode/, "the DELETED plate's vase mode was handed to the survivor")
})

test('adding a material drops the filament-INDEXED plate keys', () => {
  // Found on staging against a real 8-material dual-extruder project: adding a 9th material left
  // `filament_maps` and `first_layer_print_sequence` eight entries wide against nine filaments.
  // An identity slot remap only says nothing MOVED, and an append moves nothing, so stability has
  // to be judged against the SOURCE filament count as well.
  const settings = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<config>',
    '  <object id="1"><metadata key="name" value="A"/></object>',
    '  <plate>',
    '    <metadata key="plater_id" value="1"/>',
    '    <metadata key="locked" value="false"/>',
    '    <metadata key="filament_maps" value="1 1"/>',
    '    <metadata key="first_layer_print_sequence" value="1 2"/>',
    '  </plate>',
    '</config>'
  ].join('\n')
  const source2 = { ...source(), modelSettingsXml: settings, projectSettingsJson: JSON.stringify({ filament_colour: ['#a', '#b'] }) }
  const place = { objectId: 1, plateIndex: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }

  const unchanged = planEditedThreeMf(source2, { plates: [{ index: 1, sourceIndex: 1 }], instances: [place], filaments: [{ color: '#a', sourceIndex: 0 }, { color: '#b', sourceIndex: 1 }] } as never)
  const kept = unchanged.copy?.transforms.get('Metadata/model_settings.config')?.('') ?? ''
  assert.match(kept, /filament_maps/, 'an untouched filament list must keep its map')

  const appended = planEditedThreeMf(source2, { plates: [{ index: 1, sourceIndex: 1 }], instances: [place], filaments: [{ color: '#a', sourceIndex: 0 }, { color: '#b', sourceIndex: 1 }, { color: '#c' }] } as never)
  const grown = appended.copy?.transforms.get('Metadata/model_settings.config')?.('') ?? ''
  assert.doesNotMatch(grown, /filament_maps/, 'the map was carried at the old width against a longer filament list')
  assert.doesNotMatch(grown, /first_layer_print_sequence/, 'the print sequence was carried at the old width')
  assert.match(grown, /key="locked"/, 'a non-filament setting must still survive')
})
