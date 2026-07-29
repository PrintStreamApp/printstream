import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildThreeMfIndex, extractProjectVersion, parseModelSettingsPlates } from './index-parser.js'

test('extractProjectVersion reads the Bambu Studio version that saved the project', () => {
  // Used to warn before a slice: BambuStudio refuses a project newer than the engine (exit 232).
  assert.equal(extractProjectVersion(JSON.stringify({ version: '02.08.00.50' })), '02.08.00.50')
  assert.equal(extractProjectVersion(JSON.stringify({ version: ' 01.09.05.51 ' })), '01.09.05.51')
  // Unknown must stay null — never guessed, or the dialog would warn (or not) on invented data.
  assert.equal(extractProjectVersion(JSON.stringify({})), null)
  assert.equal(extractProjectVersion(JSON.stringify({ version: 'v2.8' })), null)
  assert.equal(extractProjectVersion('not json'), null)
  assert.equal(extractProjectVersion(null), null)
})

test('per-object process overrides reach the index, scoped to the object and to real process keys', () => {
  // The prepare-print dialog works off this index and never loads the scene. Before these were
  // carried, it seeded an EMPTY override map: the baked settings were invisible there, and editing
  // one setting sent a map claiming the object had only that one -- which the slice-time transform
  // takes as authoritative, dropping the rest from the slice.
  const xml = [
    '<config>',
    '  <object id="7">',
    '    <metadata key="name" value="Hole insert"/>',
    '    <metadata key="extruder" value="2"/>',
    '    <metadata key="wall_loops" value="4"/>',
    '    <metadata key="sparse_infill_density" value="35%"/>',
    '    <part id="1" subtype="normal_part">',
    '      <metadata key="wall_loops" value="9"/>',
    '      <metadata key="source_object_id" value="0"/>',
    '    </part>',
    '  </object>',
    '  <object id="8">',
    '    <metadata key="name" value="Plain"/>',
    '    <metadata key="matrix" value="1 0 0 0 1 0 0 0 1 0 0 0"/>',
    '  </object>',
    '  <plate>',
    '    <metadata key="plater_id" value="1"/>',
    '    <model_instance><metadata key="object_id" value="7"/><metadata key="identify_id" value="101"/></model_instance>',
    '    <model_instance><metadata key="object_id" value="8"/><metadata key="identify_id" value="102"/></model_instance>',
    '  </plate>',
    '</config>'
  ].join('\n')

  const objects = parseModelSettingsPlates(xml)[0]?.objects ?? []
  const overridden = objects.find((object) => object.id === 7)
  // The object's own two process settings, and NOT the part's wall_loops=9 sitting below it.
  assert.deepEqual(overridden?.processOverrides, { wall_loops: '4', sparse_infill_density: '35%' })
  // name/extruder/matrix are identity and placement, not overrides — writing them back as process
  // settings on the next save would be junk.
  assert.equal(overridden?.processOverrides.name, undefined)
  assert.equal(overridden?.processOverrides.extruder, undefined)
  // An object with no overrides gets an empty map, never undefined, so callers need no guard.
  assert.deepEqual(objects.find((object) => object.id === 8)?.processOverrides, {})
})

test('a project filament slot keeps the raw filament_settings_id, not just the display name', () => {
  // `filamentName` is a DISPLAY value: it strips the `@BBL…` machine suffix, which collapses a
  // built-in and any workspace preset inheriting it onto one string. Since no installed preset is
  // literally named that, binding a slot by it can never match exactly and falls through to ranked
  // inference — which is how a project naming "Bambu PLA Basic @BBL H2D" bound to a workspace
  // "… - 55 degree plate" variant and reported bed-temperature changes the user never made.
  // BambuStudio binds on this raw string (`find_preset_internal(original_name)`), so we keep it.
  const projectSettings = JSON.stringify({
    filament_settings_id: ['Bambu PLA Basic @BBL H2D', 'Bambu PLA Basic @BBL H2D - 55 degree plate'],
    filament_type: ['PLA', 'PLA'],
    filament_colour: ['#408080', '#545454']
  })

  const index = buildThreeMfIndex(null, projectSettings, [], new Map(), null)

  assert.deepEqual(
    index.projectFilaments.map((filament) => [filament.filamentName, filament.filamentPresetName]),
    [
      // Both slots share a display name; only the raw one tells them apart.
      ['Bambu PLA Basic', 'Bambu PLA Basic @BBL H2D'],
      ['Bambu PLA Basic', 'Bambu PLA Basic @BBL H2D - 55 degree plate']
    ]
  )
})
