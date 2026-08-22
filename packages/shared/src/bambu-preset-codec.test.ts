import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  bambuPresetCodecInternals,
  decodeCloudPresetSetting,
  encodeCloudPresetSetting
} from './bambu-preset-codec.js'

const { escapeStringsCStyle, unescapeStringsCStyle } = bambuPresetCodecInternals

test('string vector elements are written quoted, and read either way', () => {
  // Quoted is the form the cloud actually stores, so writing it back that way keeps a
  // pulled preset byte-identical on re-push. Bare elements still parse, because
  // BambuStudio's own serializer omits the quotes when nothing forces them.
  assert.equal(escapeStringsCStyle(['PLA']), '"PLA"')
  assert.equal(escapeStringsCStyle(['PLA', 'PETG']), '"PLA";"PETG"')
  assert.deepEqual(unescapeStringsCStyle('PLA'), ['PLA'])
  assert.deepEqual(unescapeStringsCStyle('PLA;PETG'), ['PLA', 'PETG'])
  assert.deepEqual(unescapeStringsCStyle('"PLA";"PETG"'), ['PLA', 'PETG'])
})

test('an element containing the separator survives because it is quoted', () => {
  // A naive split on ';' would turn one printer name into two compatible printers.
  const values = ['Bambu Lab X1 Carbon; 0.4 nozzle']
  const serialized = escapeStringsCStyle(values)
  assert.deepEqual(unescapeStringsCStyle(serialized), values)
})

test('elements with spaces, quotes and newlines round-trip', () => {
  const values = ['Bambu Lab P1P 0.2 nozzle', 'say "hi"', 'a\\b', 'line1\nline2', 'tab\there']
  assert.deepEqual(unescapeStringsCStyle(escapeStringsCStyle(values)), values)
})

test('a single empty element is quoted so it is not read as an empty list', () => {
  assert.equal(escapeStringsCStyle(['']), '""')
  assert.deepEqual(unescapeStringsCStyle('""'), [''])
})

test('a trailing separator keeps the final empty element', () => {
  assert.deepEqual(unescapeStringsCStyle('PLA;'), ['PLA', ''])
})

test('a malformed value is rejected rather than half-parsed', () => {
  // An unterminated quote must not silently produce a truncated value that then gets
  // written back to the user's preset.
  assert.equal(unescapeStringsCStyle('"unterminated'), null)
})

test('cloud string vectors decode to the arrays a local preset stores', () => {
  const decoded = decodeCloudPresetSetting({
    filament_type: '"PLA"',
    compatible_printers: '"Bambu Lab P1P 0.2 nozzle";"Bambu Lab X1C 0.4 nozzle"'
  })

  assert.deepEqual(decoded.filament_type, ['PLA'])
  assert.deepEqual(decoded.compatible_printers, ['Bambu Lab P1P 0.2 nozzle', 'Bambu Lab X1C 0.4 nozzle'])
})

test('cloud numeric vectors decode on the comma separator, not the string one', () => {
  // ConfigOptionFloats/Ints/Bools serialize with ',' while string vectors use ';'.
  const decoded = decodeCloudPresetSetting({ nozzle_temperature: '220,225' })
  assert.deepEqual(decoded.nozzle_temperature, ['220', '225'])
})

test('a scalar option stays a scalar even when it looks like a list', () => {
  // The generated shape table is the only thing that can tell a one-element vector from
  // a scalar once serialized, which is why the shape is never inferred from the value.
  const decoded = decodeCloudPresetSetting({ layer_height: '0.2' })
  assert.equal(decoded.layer_height, '0.2')
})

test('a numeric JSON value becomes a string, because the local form is strings', () => {
  // Bambu sends some options as JSON numbers. `filament_flow_ratio` is a per-extruder
  // vector option, so it lands as a one-element array of strings — the shape a local
  // preset stores — rather than a bare number.
  const decoded = decodeCloudPresetSetting({ filament_flow_ratio: 0.98 } as Record<string, unknown>)
  assert.deepEqual(decoded.filament_flow_ratio, ['0.98'])
})

test('a local preset encodes back to exactly what the cloud sent', () => {
  const cloud = {
    filament_type: '"PLA"',
    compatible_printers: '"Bambu Lab P1P 0.2 nozzle";"Bambu Lab X1C 0.4 nozzle"',
    nozzle_temperature: '220,225',
    filament_settings_id: '"My PLA"',
    layer_height: '0.2'
  }

  assert.deepEqual(encodeCloudPresetSetting(decodeCloudPresetSetting(cloud)), cloud)
})

test('an option newer than the generated shape table passes through untouched', () => {
  // Guessing at an unknown option's shape is how a preset loses a setting it arrived
  // with; an unrecognised key is carried verbatim in both directions.
  const decoded = decodeCloudPresetSetting({ some_future_option: 'a;b' })
  assert.equal(decoded.some_future_option, 'a;b')
  assert.equal(encodeCloudPresetSetting(decoded).some_future_option, 'a;b')
})

test('a numeric vector option omitted from every hand-maintained catalog still round-trips numerically', () => {
  // hotend_cooling_rate/hotend_heating_rate/grab_length/nozzle_flush_dataset/
  // physical_extruder_map are real coFloats/coInts PrintConfig options, but none of them
  // appear in filament/process/machine-settings.generated.ts (those are scoped to what
  // the tune DIALOG shows) or in the old hand-maintained exception list — only the
  // generated BAMBU_PRESET_OPTION_SHAPES table, built from every `this->add()` in the
  // vendored source, sees them. Treating them as string-like by mistake would c-style-
  // quote and semicolon-join them instead of comma-joining, corrupting the value.
  const decoded = decodeCloudPresetSetting({ hotend_cooling_rate: '25,30', nozzle_flush_dataset: '0,1,2' })
  assert.deepEqual(decoded.hotend_cooling_rate, ['25', '30'])
  assert.deepEqual(decoded.nozzle_flush_dataset, ['0', '1', '2'])

  const encoded = encodeCloudPresetSetting({ hotend_cooling_rate: ['25', '30'] })
  assert.equal(encoded.hotend_cooling_rate, '25,30')
})

test('envelope fields never leak into a pushed payload', () => {
  // Bambu carries these alongside `setting`, not inside it.
  const encoded = encodeCloudPresetSetting({
    setting_id: 'PFUS1',
    base_id: 'GFSA00',
    update_time: '2026-04-06 19:03:50',
    type: 'filament',
    from: 'system',
    filament_type: ['PLA']
  })

  assert.deepEqual(Object.keys(encoded), ['filament_type'])
})
