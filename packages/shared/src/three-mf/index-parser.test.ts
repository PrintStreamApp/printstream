import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildThreeMfIndex, extractProjectVersion, extractSlicedWithFilamentTrackSwitch, normalizePrinterModelName, parseModelSettingsPlates, parseProjectFilaments } from './index-parser.js'

test('extractProjectVersion reads the Bambu Studio version that saved the project', () => {
  // Used to warn before a slice: BambuStudio refuses a project newer than the engine (exit 232).
  assert.equal(extractProjectVersion(JSON.stringify({ version: '02.08.00.50' })), '02.08.00.50')
  assert.equal(extractProjectVersion(JSON.stringify({ version: ' 01.09.05.51 ' })), '01.09.05.51')
  // Unknown must stay null, never guessed, or the dialog would warn (or not) on invented data.
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
  // name/extruder/matrix are identity and placement, not overrides: writing them back as process
  // settings on the next save would be junk.
  assert.equal(overridden?.processOverrides.name, undefined)
  assert.equal(overridden?.processOverrides.extruder, undefined)
  // An object with no overrides gets an empty map, never undefined, so callers need no guard.
  assert.deepEqual(objects.find((object) => object.id === 8)?.processOverrides, {})
})

test('per-plate filament orders reach the index without losing range boundaries', () => {
  const xml = [
    '<config>',
    '  <plate>',
    '    <metadata key="plater_id" value="1"/>',
    '    <metadata key="first_layer_print_sequence" value="3 1 2"/>',
    '    <metadata key="other_layers_print_sequence" value="2 12 2 3 1 13 2147483646 1 2 3"/>',
    '    <metadata key="other_layers_print_sequence_nums" value="2"/>',
    '  </plate>',
    '</config>'
  ].join('\n')

  const plate = parseModelSettingsPlates(xml)[0]
  assert.deepEqual(plate?.firstLayerFilamentSequence, [3, 1, 2])
  assert.deepEqual(plate?.otherLayerFilamentSequences, [
    { startLayer: 2, endLayer: 12, filamentIds: [2, 3, 1] },
    { startLayer: 13, endLayer: null, filamentIds: [1, 2, 3] }
  ])
})

test('malformed per-plate filament orders fall back to Auto', () => {
  const xml = [
    '<config><plate>',
    '  <metadata key="plater_id" value="1"/>',
    '  <metadata key="first_layer_print_sequence" value="2 nope 1"/>',
    '  <metadata key="other_layers_print_sequence" value="2 10 1 2"/>',
    '  <metadata key="other_layers_print_sequence_nums" value="2"/>',
    '</plate></config>'
  ].join('\n')

  const plate = parseModelSettingsPlates(xml)[0]
  assert.equal(plate?.firstLayerFilamentSequence, null)
  assert.equal(plate?.otherLayerFilamentSequences, null)
})

test('a project filament slot keeps the raw filament_settings_id, not just the display name', () => {
  // `filamentName` is a DISPLAY value: it strips the `@BBL…` machine suffix, which collapses a
  // built-in and any workspace preset inheriting it onto one string. Since no installed preset is
  // literally named that, binding a slot by it can never match exactly and falls through to ranked
  // inference, which is how a project naming "Bambu PLA Basic @BBL H2D" bound to a workspace
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

// A project's model decides its bed, its compatible presets, and what the editor's printer picker
// shows. A model the normalizer does not recognize is not a soft miss: the index reports NO
// compatible model and the target falls back to the first machine in the catalogue, so an X1
// project silently opened as an A1.
test('normalizePrinterModelName tells the X1 family apart, plain X1 included', () => {
  assert.equal(normalizePrinterModelName('Bambu Lab X1'), 'X1')
  assert.equal(normalizePrinterModelName('Bambu Lab X1 0.4 nozzle'), 'X1')
  assert.equal(normalizePrinterModelName('X1'), 'X1')
  // The suffixed siblings must never fall through to the plain branch.
  assert.equal(normalizePrinterModelName('Bambu Lab X1 Carbon'), 'X1C')
  assert.equal(normalizePrinterModelName('X1C'), 'X1C')
  assert.equal(normalizePrinterModelName('Bambu Lab X1E'), 'X1E')
  // Nor may a model that merely CONTAINS the digits reach it: the A1-vs-A1-mini trap's twin.
  assert.equal(normalizePrinterModelName('Bambu Lab X2D'), 'X2D')
  assert.equal(normalizePrinterModelName('Bambu Lab H2D'), 'H2D')
  assert.equal(normalizePrinterModelName('Bambu Lab A1 mini'), 'A1mini')
})

test('has_filament_switcher is read as the machine the project was sliced for', () => {
  // BambuStudio writes bools into project_settings several ways depending on the writer, and the
  // string forms are what a round-trip through its own serializer produces.
  assert.equal(extractSlicedWithFilamentTrackSwitch('{"has_filament_switcher": true}'), true)
  assert.equal(extractSlicedWithFilamentTrackSwitch('{"has_filament_switcher": "1"}'), true)
  assert.equal(extractSlicedWithFilamentTrackSwitch('{"has_filament_switcher": 1}'), true)

  assert.equal(extractSlicedWithFilamentTrackSwitch('{"has_filament_switcher": false}'), false)
  assert.equal(extractSlicedWithFilamentTrackSwitch('{"has_filament_switcher": "0"}'), false)

  // ABSENT is false, not unknown, that is how BambuStudio's CLI defaults it, and it is what every
  // project saved before the switch existed has to read as.
  assert.equal(extractSlicedWithFilamentTrackSwitch('{}'), false)
  assert.equal(extractSlicedWithFilamentTrackSwitch(null), false)
  // Unparseable settings must not throw or report true.
  assert.equal(extractSlicedWithFilamentTrackSwitch('{not json'), false)
})

// A preset's BRAND is not derivable from its name: Polymaker ships "PolyLite PLA", so a project
// preset minted without the vendor brands itself differently from the installed preset of the very
// same name, and any comparison between the two fails to match a preset against ITSELF. The 3MF
// records the vendor per slot, so carry it rather than re-deriving a guess downstream.
test('a project filament carries its slot vendor, so a project preset can brand like its twin', () => {
  const slots = parseProjectFilaments(JSON.stringify({
    filament_settings_id: ['PolyLite PLA @BBL H2D', 'Bambu PLA Basic @BBL H2D'],
    filament_type: ['PLA', 'PLA'],
    filament_vendor: ['Polymaker', 'Bambu Lab'],
    filament_colour: ['#C12E1F', '#FFFFFF']
  }))

  // Verbatim, not folded to a display label: "Bambu Lab" normalizes to "Bambu" only when rendered.
  assert.deepEqual(slots.map((slot) => slot.filamentVendor), ['Polymaker', 'Bambu Lab'])

  // Absent stays NULL rather than guessed from the name, which is what "vendor unknown" has to
  // mean for a 3MF that records none (or a bridge on an older parser).
  const noVendor = parseProjectFilaments(JSON.stringify({
    filament_settings_id: ['PolyLite PLA @BBL H2D'],
    filament_type: ['PLA']
  }))
  assert.equal(noVendor[0]?.filamentVendor, null)
})

// The vendor array counts toward the slot total like every other parallel array: a project whose
// vendor list outruns the rest must not have its material list silently truncated.
test('the vendor array counts toward the slot total', () => {
  const slots = parseProjectFilaments(JSON.stringify({
    filament_type: ['PLA'],
    filament_vendor: ['Polymaker', 'Bambu Lab', 'Bambu Lab']
  }))
  assert.equal(slots.length, 3)
})

test('project filaments distinguish virtual mixed slots from physical trays', () => {
  const slots = parseProjectFilaments(JSON.stringify({
    filament_colour: ['#FF0000', '#0000FF', '#800080'],
    filament_type: ['PLA', 'PLA', 'PLA'],
    filament_is_mixed: ['0', '0', '1'],
    filament_mixed_components: ['', '', '1,2'],
    filament_mixed_sublayer_ratios: ['', '', '0.5,0.5']
  }))

  assert.equal(slots[0]?.mixedFilament, null)
  assert.deepEqual(slots[2]?.mixedFilament?.componentIds, [1, 2])
  assert.deepEqual(slots[2]?.mixedFilament?.ratios, [0.5, 0.5])
  assert.deepEqual(slots[2]?.mixedFilament?.issues, [])
})

test('the index carries the process preset\'s PARENT, which is what the engine judges it by', () => {
  // `inherits_group[0]` is the name BambuStudio resolves a project's process compatibility from, and
  // it survives a machine retarget untouched. Without it the browser sees a preset called
  // "0.20mm Speed - Tablet Mount", which names no printer, and calls it compatible with everything.
  const index = buildThreeMfIndex(null, JSON.stringify({
    print_settings_id: '0.20mm Speed - Tablet Mount',
    printer_settings_id: 'Bambu Lab X2D 0.4 nozzle',
    inherits_group: ['0.20mm Strength @BBL P1P', '', '']
  }))

  assert.equal(index.processProfileName, '0.20mm Speed - Tablet Mount')
  assert.equal(index.processProfileInherits, '0.20mm Strength @BBL P1P')
})

test('an EMPTY parent slot reports no parent, because the process is then a system preset itself', () => {
  // The engine reads an empty slot 0 as "this preset IS a system preset" and falls back to the
  // leaf's own name. Reporting the leaf here instead would double-count it as a lineage and let a
  // rename look like an inherited machine.
  const index = buildThreeMfIndex(null, JSON.stringify({
    print_settings_id: '0.20mm Standard @BBL X2D',
    inherits_group: ['', '', '']
  }))
  assert.equal(index.processProfileInherits, null)

  // Same answer for a project that states no lineage at all, and for one with no settings.
  assert.equal(buildThreeMfIndex(null, JSON.stringify({ print_settings_id: 'x' })).processProfileInherits, null)
  assert.equal(buildThreeMfIndex(null, null).processProfileInherits, null)
})

/** A minimal sliced project with two plates, so `optimalAssignment` has plates to attach to. */
const TWO_PLATE_SLICE_INFO = `<config>
  <plate><metadata key="index" value="1"/></plate>
  <plate><metadata key="index" value="2"/></plate>
</config>`

test('the slicer filament grouping is read per plate, positionally', () => {
  const index = buildThreeMfIndex(TWO_PLATE_SLICE_INFO, null, new Map(), new Map(), null, null, {
    filamentSequenceJson: JSON.stringify({
      plate_1: { sequence: [1, 2], nozzle_sequence: [], optimal_assignment: [0, 1, 0] },
      plate_2: { optimal_assignment: [1, 1] }
    })
  })

  assert.deepEqual(index.plates[0]?.optimalAssignment, [0, 1, 0])
  assert.deepEqual(index.plates[1]?.optimalAssignment, [1, 1])
})

test('a plate the sequence file does not mention carries no grouping at all', () => {
  // Absent must stay absent rather than becoming []: the arrangement hint reads absence as "not
  // sliced for a Filament Track Switch", which an empty array would not say.
  const index = buildThreeMfIndex(TWO_PLATE_SLICE_INFO, null, new Map(), new Map(), null, null, {
    filamentSequenceJson: JSON.stringify({ plate_1: { optimal_assignment: [0, 1] } })
  })

  assert.deepEqual(index.plates[0]?.optimalAssignment, [0, 1])
  assert.equal('optimalAssignment' in (index.plates[1] ?? {}), false)
})

test('an unreadable or partial grouping is dropped rather than salvaged', () => {
  // Keeping only the integers out of a mixed array would shift every later filament's group by
  // one, which silently proposes moving the wrong spools.
  const partial = buildThreeMfIndex(TWO_PLATE_SLICE_INFO, null, new Map(), new Map(), null, null, {
    filamentSequenceJson: JSON.stringify({ plate_1: { optimal_assignment: [0, 'x', 1] } })
  })
  assert.equal('optimalAssignment' in (partial.plates[0] ?? {}), false)

  const malformed = buildThreeMfIndex(TWO_PLATE_SLICE_INFO, null, new Map(), new Map(), null, null, {
    filamentSequenceJson: '{not json'
  })
  assert.equal('optimalAssignment' in (malformed.plates[0] ?? {}), false)

  const absent = buildThreeMfIndex(TWO_PLATE_SLICE_INFO, null)
  assert.equal('optimalAssignment' in (absent.plates[0] ?? {}), false)
})
