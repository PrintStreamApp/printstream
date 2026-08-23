/**
 * A staged repair must CLEAR the file, and stay cleared.
 *
 * The user-visible failure this pins is "I pressed Repair, it said it worked, and the banner came
 * back when I reopened the project". That is not a detection bug: the save succeeded and the defect
 * was still in the bytes. It happened because the repair declined the one shape it met most often
 * (an object with mixed part coverage), and it could happen again for any defect whose repair runs
 * before a later bake stage that regenerates the same document.
 *
 * So every defect is asserted through a full round trip rather than at the repair function:
 *   carry it -> flagged -> bake WITH `repairSettings` -> the WRITTEN documents inspect clean
 *   -> bake again WITHOUT it -> still clean.
 *
 * The last step is what catches an authoring stage that re-introduces the defect on the next
 * ordinary save, which no single-shot repair test can see.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planEditedThreeMf, type ThreeMfBakePlan, type ThreeMfBakeSource } from './bake'
import { NEW_PROJECT_MODEL_SETTINGS_XML, NEW_PROJECT_MODEL_XML } from './bake-documents'
import { collectSettingsRepairReasons } from '../repairs/index.js'
import type { SceneEdit, SceneEditFilament } from '../slicing'

/**
 * A root model that DECLARES the object being placed. The bake refuses a build item naming an object
 * the model does not contain (it would strip the real geometry and produce a file BambuStudio
 * refuses to open), so a fixture cannot place an object into an empty `<resources>`.
 */
function modelXmlDeclaring(objectId: number): string {
  return NEW_PROJECT_MODEL_XML.replace(
    '  </resources>',
    `    <object id="${objectId}" type="model"><mesh><vertices/><triangles/></mesh></object>\n  </resources>`
  )
}


const at = { x: 0, y: 0, z: 0 }
const unit = { x: 1, y: 1, z: 1 }

function sourceOf(projectSettings: Record<string, unknown> | null, modelSettingsXml: string): ThreeMfBakeSource {
  return {
    hasBase: true,
    modelXml: modelXmlDeclaring(5),
    modelSettingsXml,
    projectSettingsJson: projectSettings ? JSON.stringify(projectSettings) : null,
    customGcodeXml: null,
    sliceInfoXml: null,
    modelRelsXml: null,
    subModelEntries: []
  } as ThreeMfBakeSource
}

/**
 * Run a plan the way a write does (its project-settings transform is applied lazily), and return
 * both the documents it produced and the reasons it reports for them.
 */
function write(plan: ThreeMfBakePlan, source: ThreeMfBakeSource): {
  projectSettingsJson: string | null
  modelSettingsXml: string
  reasons: string[]
} {
  let projectSettingsJson: string | null = null
  let modelSettingsXml = source.modelSettingsXml
  for (const [name, transform] of plan.copy?.transforms ?? []) {
    if (name === 'Metadata/project_settings.config') projectSettingsJson = transform(source.projectSettingsJson ?? '{}')
    if (name === 'Metadata/model_settings.config') modelSettingsXml = transform(source.modelSettingsXml) ?? modelSettingsXml
  }
  for (const entry of plan.copy?.appendEntries ?? []) {
    if (entry.name === 'Metadata/project_settings.config') projectSettingsJson = entry.content
    if (entry.name === 'Metadata/model_settings.config') modelSettingsXml = entry.content
  }
  return { projectSettingsJson, modelSettingsXml, reasons: plan.settingsRepairReasons() }
}

/**
 * carry -> flag -> repair-save -> clean -> plain re-save -> still clean.
 * `filaments` is only needed by the defects repaired from RESOLVED PRESETS (filamentPhysics).
 */
function assertRepairSticks(
  label: string,
  projectSettings: Record<string, unknown> | null,
  modelSettingsXml: string,
  expectedReason: string,
  options: { filaments?: SceneEditFilament[]; instances?: SceneEdit['instances'] } = {}
): void {
  const instances = options.instances ?? []
  const baseEdit = { plates: [{ index: 1 }], instances } as SceneEdit

  const source = sourceOf(projectSettings, modelSettingsXml)
  assert.ok(
    collectSettingsRepairReasons(source.projectSettingsJson, source.modelSettingsXml).includes(expectedReason as never),
    `${label}: the fixture must actually carry ${expectedReason}`
  )

  const repairEdit = { ...baseEdit, repairSettings: true, ...(options.filaments ? { filaments: options.filaments } : {}) } as SceneEdit
  const repaired = write(planEditedThreeMf(source, repairEdit), source)
  assert.deepEqual(repaired.reasons, [], `${label}: a staged repair must clear the file it writes`)

  // The next ORDINARY save must not put it back. An authoring stage that re-derives the same field
  // would, and only a second pass can see it.
  const resource = sourceOf(
    repaired.projectSettingsJson ? (JSON.parse(repaired.projectSettingsJson) as Record<string, unknown>) : null,
    repaired.modelSettingsXml
  )
  const resaved = write(planEditedThreeMf(resource, { ...baseEdit, ...(options.filaments ? { filaments: options.filaments } : {}) } as SceneEdit), resource)
  assert.deepEqual(resaved.reasons, [], `${label}: the defect came back on the next ordinary save`)
}

/** Two filaments on a dual-nozzle machine, the shape most of these defects are sized against. */
const TWO_FILAMENTS = {
  filament_colour: ['#111111', '#222222'],
  filament_type: ['PLA', 'PETG'],
  filament_ids: ['GFA00', 'GFG02'],
  filament_settings_id: ['Bambu PLA Basic @BBL H2D', 'Bambu PETG HF @BBL H2D 0.4 nozzle'],
  nozzle_temperature: ['220', '255'],
  nozzle_temperature_initial_layer: ['220', '255'],
  filament_flow_ratio: ['0.98', '0.95'],
  filament_density: ['1.26', '1.27'],
  filament_diameter: ['1.75', '1.75'],
  nozzle_diameter: ['0.4', '0.4']
}

const OBJECT_PART_ONLY = [
  '<config>',
  '  <object id="5">',
  '    <metadata key="name" value="Branded"/>',
  '    <part id="5" subtype="normal_part">',
  '      <metadata key="extruder" value="2"/>',
  '    </part>',
  '  </object>',
  '</config>'
].join('\n')

const OBJECT_MIXED_COVERAGE = [
  '<config>',
  '  <object id="5">',
  '    <metadata key="name" value="Branded"/>',
  '    <part id="5" subtype="normal_part">',
  '      <metadata key="name" value="Body"/>',
  '    </part>',
  '    <part id="6" subtype="normal_part">',
  '      <metadata key="extruder" value="2"/>',
  '    </part>',
  '  </object>',
  '</config>'
].join('\n')

const PLACED_5 = [{ objectId: 5, instanceId: 1, plateIndex: 1, position: at, rotation: at, scale: unit }] as SceneEdit['instances']

test('objectExtruder: a part-only binding is repaired and stays repaired', () => {
  assertRepairSticks('part-only', TWO_FILAMENTS, OBJECT_PART_ONLY, 'objectExtruder', { instances: PLACED_5 })
})

test('objectExtruder: MIXED part coverage is repaired and stays repaired', () => {
  // The shape a replaced/imported object lands in, and the one the repair used to decline, which
  // is what made a repair look successful and then raise the banner again on reopen.
  assertRepairSticks('mixed-coverage', TWO_FILAMENTS, OBJECT_MIXED_COVERAGE, 'objectExtruder', { instances: PLACED_5 })
})

const OBJECT_NO_HEAD_METADATA = [
  '<config>',
  '  <object id="5">',
  '    <part id="5" subtype="normal_part">',
  '      <metadata key="extruder" value="2"/>',
  '    </part>',
  '  </object>',
  '</config>'
].join('\n')

test('objectExtruder: an object head with NO metadata is repaired and stays repaired', () => {
  // Our own bake writes this shape. The writer had no anchor to insert after and silently declined,
  // while the caller still recorded a repair, so the round trip is the only thing that catches it.
  assertRepairSticks('no-head-metadata', TWO_FILAMENTS, OBJECT_NO_HEAD_METADATA, 'objectExtruder', { instances: PLACED_5 })
})

test('inheritsGroup: a stale length is repaired and stays repaired', () => {
  // Left by a save made at a different filament count; the CLI reads past the end and SIGSEGVs.
  assertRepairSticks('inherits-group', { ...TWO_FILAMENTS, inherits_group: ['', '', '', '', ''] }, NEW_PROJECT_MODEL_SETTINGS_XML, 'inheritsGroup')
})

test('flushMatrix: an undersized matrix is repaired and stays repaired', () => {
  // 2 filaments x 2 extruders needs 8 entries; a single 2x2 block is the dual-nozzle segfault.
  assertRepairSticks('flush-matrix', {
    ...TWO_FILAMENTS,
    flush_volumes_matrix: ['0', '140', '140', '0'],
    flush_multiplier: ['1', '1']
  }, NEW_PROJECT_MODEL_SETTINGS_XML, 'flushMatrix')
})

test('filamentIds: an id naming a different material than its preset is repaired and stays repaired', () => {
  // BambuStudio BINDS a slot on the id, so a mismatch makes it fabricate a defaults-only preset.
  assertRepairSticks('filament-ids', {
    ...TWO_FILAMENTS,
    filament_ids: ['GFB00', 'GFG02']
  }, NEW_PROJECT_MODEL_SETTINGS_XML, 'filamentIds')
})

test('variantIndex: a self-index that does not match the variant layout is repaired and stays repaired', () => {
  assertRepairSticks('variant-index', {
    ...TWO_FILAMENTS,
    extruder_variant_list: ['Direct Drive Standard', 'Direct Drive High Flow'],
    filament_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive Standard', 'Direct Drive High Flow'],
    filament_self_index: ['1', '2']
  }, NEW_PROJECT_MODEL_SETTINGS_XML, 'variantIndex')
})

/**
 * filamentPhysics is the odd one out: it is repaired by the SAVE (from resolved presets), not by
 * the staged repair step, because the values cannot be derived from the file alone. The round trip
 * still has to hold, and the re-save leg is what proves the restore did not write a width that
 * the next parse rejects as stale.
 */
test('filamentPhysics: a dropped physics block is restored on save and stays restored', () => {
  // Drop three of the five completeness sentinels: the exact shape a variant-scoped drop left.
  const {
    nozzle_temperature: _temp,
    nozzle_temperature_initial_layer: _tempInitial,
    filament_flow_ratio: _flow,
    ...stripped
  } = TWO_FILAMENTS
  assertRepairSticks('filament-physics', stripped, NEW_PROJECT_MODEL_SETTINGS_XML, 'filamentPhysics', {
    filaments: [
      { color: '#111111', type: 'PLA', settingsId: 'Bambu PLA Basic @BBL H2D', filamentId: 'GFA00', sourceIndex: 0,
        config: { nozzle_temperature: ['220'], nozzle_temperature_initial_layer: ['220'], filament_flow_ratio: ['0.98'], filament_density: ['1.26'], filament_diameter: ['1.75'] } },
      { color: '#222222', type: 'PETG', settingsId: 'Bambu PETG HF @BBL H2D 0.4 nozzle', filamentId: 'GFG02', sourceIndex: 1,
        config: { nozzle_temperature: ['255'], nozzle_temperature_initial_layer: ['255'], filament_flow_ratio: ['0.95'], filament_density: ['1.27'], filament_diameter: ['1.75'] } }
    ] as SceneEditFilament[]
  })
})

test('filamentPhysics: a stale width on a VENDOR-ONLY key is repaired and stays repaired', () => {
  // `volumetric_speed_coefficients` is variant-scoped and in BambuStudio's filament option list, but
  // NOT in the tune dialog's catalogue. Detection judges width over the vendor list while the bake's
  // stale-width drop classifies over the catalogue, so a key in that gap can be flagged by one and
  // invisible to the other. If those two lists disagree, this round trip is what notices.
  assertRepairSticks('vendor-only-key', {
    ...TWO_FILAMENTS,
    filament_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive Standard', 'Direct Drive High Flow'],
    nozzle_temperature: ['220', '220', '255', '255'],
    nozzle_temperature_initial_layer: ['220', '220', '255', '255'],
    filament_flow_ratio: ['0.98', '0.98', '0.95', '0.95'],
    // Three entries fits neither 2 slots nor the 4 declared rows.
    volumetric_speed_coefficients: ['1', '1', '1']
  }, NEW_PROJECT_MODEL_SETTINGS_XML, 'filamentPhysics', {
    filaments: [
      { color: '#111111', type: 'PLA', settingsId: 'Bambu PLA Basic @BBL H2D', filamentId: 'GFA00', sourceIndex: 0,
        config: { nozzle_temperature: ['220', '220'], filament_density: ['1.26'], filament_diameter: ['1.75'] } },
      { color: '#222222', type: 'PETG', settingsId: 'Bambu PETG HF @BBL H2D 0.4 nozzle', filamentId: 'GFG02', sourceIndex: 1,
        config: { nozzle_temperature: ['255', '255'], filament_density: ['1.27'], filament_diameter: ['1.75'] } }
    ] as SceneEditFilament[]
  })
})
