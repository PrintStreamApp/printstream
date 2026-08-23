/**
 * The bake reports the repairable defects it WROTE.
 *
 * Every other invariant check we own inspects a file at rest, so a defect the bake introduces is
 * invisible until someone reopens the project. Two shipped that way. This pins the save-time
 * counterpart: `settingsRepairReasons()` judges the produced documents, not the input ones.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planEditedThreeMf, type ThreeMfBakeSource } from './bake'
import { NEW_PROJECT_MODEL_SETTINGS_XML, NEW_PROJECT_MODEL_XML } from './bake-documents'
import type { SceneEdit } from '../slicing'

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


function sourceWith(projectSettingsJson: string | null, modelSettingsXml: string): ThreeMfBakeSource {
  return {
    hasBase: true,
    modelXml: modelXmlDeclaring(7),
    modelSettingsXml,
    projectSettingsJson,
    customGcodeXml: null,
    sliceInfoXml: null,
    modelRelsXml: null,
    subModelEntries: []
  } as ThreeMfBakeSource
}

/** Run the plan's lazy transforms the way a write does, then report. */
function reasonsAfterWrite(source: ThreeMfBakeSource, edit: SceneEdit): string[] {
  const plan = planEditedThreeMf(source, edit)
  for (const transform of plan.copy?.transforms.values() ?? []) transform(source.projectSettingsJson ?? '{}')
  return plan.settingsRepairReasons()
}

test('a bake that produces a clean document reports nothing', () => {
  const source = sourceWith(JSON.stringify({
    filament_colour: ['#1'], filament_type: ['PLA'], filament_ids: ['GFA00'],
    filament_settings_id: ['Bambu PLA Basic @BBL H2D'],
    nozzle_temperature: ['220'], nozzle_temperature_initial_layer: ['220'],
    filament_flow_ratio: ['0.98'], filament_density: ['1.26'], filament_diameter: ['1.75']
  }), NEW_PROJECT_MODEL_SETTINGS_XML)
  assert.deepEqual(reasonsAfterWrite(source, { plates: [{ index: 1 }], instances: [] } as SceneEdit), [])
})

test('a bake whose model_settings leaves an object unbound reports objectExtruder', () => {
  // The defect the save used to introduce silently: a part claims a material, the object claims
  // nothing, and the engine quietly prints it with filament 1.
  const modelSettings = [
    '<config>',
    '  <object id="7">',
    '    <metadata key="name" value="Unbound"/>',
    '    <part id="7" subtype="normal_part">',
    '      <metadata key="extruder" value="2"/>',
    '    </part>',
    '  </object>',
    '</config>'
  ].join('\n')
  const at = { x: 0, y: 0, z: 0 }
  const edit = {
    plates: [{ index: 1 }],
    // The object has to be PLACED, or the bake drops it from the document it writes and there is
    // nothing left to judge.
    instances: [{ objectId: 7, instanceId: 1, plateIndex: 1, position: at, rotation: at, scale: { x: 1, y: 1, z: 1 } }]
  } as SceneEdit
  const reasons = reasonsAfterWrite(sourceWith(null, modelSettings), edit)
  assert.deepEqual(reasons, ['objectExtruder'])
})

/**
 * A bake that runs no project-settings transform still WROTE a project-settings document: the
 * source's, passed through unchanged. Reporting `[]` for it says "clean" about a document the
 * validator never looked at, and "unknown" read as "healthy" is the one answer a check like this
 * must never give.
 */
test('a bake with no project-settings transform judges what it passed through', () => {
  const carriesDefect = JSON.stringify({
    filament_colour: ['#1', '#2'],
    filament_type: ['PLA', 'PETG'],
    filament_ids: ['GFA00', 'GFG02'],
    filament_settings_id: ['Bambu PLA Basic @BBL H2D', 'Bambu PETG HF @BBL H2D 0.4 nozzle'],
    // Complete physics, so the fixture carries exactly ONE defect and the assertion can be exact.
    nozzle_temperature: ['220', '255'],
    nozzle_temperature_initial_layer: ['220', '255'],
    filament_flow_ratio: ['0.98', '0.95'],
    filament_density: ['1.26', '1.27'],
    filament_diameter: ['1.75', '1.75'],
    // Left by a save at a different filament count: the CLI reads past the end and dies loading it.
    inherits_group: ['', '', '', '', '']
  })
  // An edit with no filaments and no plate settings installs no project-settings transform at all.
  const plan = planEditedThreeMf(sourceWith(carriesDefect, NEW_PROJECT_MODEL_SETTINGS_XML), { plates: [], instances: [] } as SceneEdit)
  for (const transform of plan.copy?.transforms.values() ?? []) transform(carriesDefect)
  assert.deepEqual(plan.settingsRepairReasons(), ['inheritsGroup'])
})
