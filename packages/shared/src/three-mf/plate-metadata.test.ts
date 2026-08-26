/**
 * A save re-renders every `<plate>` block from the SceneEdit, so any key the edit cannot express was
 * discarded. These are not cosmetic: `print_sequence` is per-plate print-by-object, `spiral_mode` is
 * vase mode, `bed_type` is the plate's build surface and therefore its first-layer temperature.
 * Losing them does not fail a slice, it slices something the user did not ask for.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSourcePlateMetadata, preservedPlateMetadata, remapSliceInfoPlates, sourcePlateMapping } from './plate-metadata.js'

const MODEL_SETTINGS = [
  '<config>',
  '  <plate>',
  '    <metadata key="plater_id" value="1"/>',
  '    <metadata key="plater_name" value="Plate 1"/>',
  '    <metadata key="bed_type" value="Textured PEI Plate"/>',
  '    <metadata key="print_sequence" value="by object"/>',
  '    <metadata key="spiral_mode" value="1"/>',
  '    <metadata key="locked" value="true"/>',
  '    <metadata key="filament_maps" value="1 2"/>',
  '    <metadata key="gcode_file" value="Metadata/plate_1.gcode"/>',
  '    <model_instance>',
  '      <metadata key="object_id" value="4"/>',
  '      <metadata key="instance_id" value="0"/>',
  '    </model_instance>',
  '  </plate>',
  '  <plate>',
  '    <metadata key="plater_id" value="2"/>',
  '    <metadata key="bed_type" value="Cool Plate"/>',
  '  </plate>',
  '</config>'
].join('\n')

const keys = (entries: Array<{ key: string }>) => entries.map((entry) => entry.key)

test('plates are keyed by plater_id, not by document position', () => {
  // Position and id disagree the moment a plate is reordered, and attaching one plate's bed type to
  // another is exactly the failure this is meant to stop.
  const parsed = parseSourcePlateMetadata(MODEL_SETTINGS)
  assert.deepEqual([...parsed.keys()], [1, 2])
  assert.equal(parsed.get(2)?.find((entry) => entry.key === 'bed_type')?.rawValue, 'Cool Plate')
})

test('instance metadata is not mistaken for plate metadata', () => {
  // `object_id` lives in a `<model_instance>` and is re-authored per instance; carrying it would
  // duplicate it at plate level.
  const parsed = parseSourcePlateMetadata(MODEL_SETTINGS)
  assert.ok(!keys(parsed.get(1) ?? []).includes('object_id'))
})

test('settings the user chose survive a re-render', () => {
  const carried = keys(preservedPlateMetadata(parseSourcePlateMetadata(MODEL_SETTINGS).get(1), true))
  for (const key of ['print_sequence', 'spiral_mode', 'locked']) {
    assert.ok(carried.includes(key), `${key} was dropped`)
  }
})

test('bed_type is NOT carried, because we author the project-global one', () => {
  // The engine prefers a plate's own bed type over the project value (`PartPlate.cpp:619-625`), and
  // the editor writes the plate type as the global `curr_bed_type`. Carrying a stale per-plate
  // value silently outlives the user's Settings-tab change.
  const carried = keys(preservedPlateMetadata(parseSourcePlateMetadata(MODEL_SETTINGS).get(1), true))
  assert.ok(!carried.includes('bed_type'))
})

test('the keys we author ourselves are not carried', () => {
  // Carrying them would let the source value win over the one the save just computed.
  const carried = keys(preservedPlateMetadata(parseSourcePlateMetadata(MODEL_SETTINGS).get(1), true))
  assert.ok(!carried.includes('plater_id'))
  assert.ok(!carried.includes('plater_name'))
})

test('slice-output pointers stay dropped', () => {
  // We cannot tell whether this save invalidated the slice they describe, and claiming a stale
  // slice is worse than claiming none.
  const carried = keys(preservedPlateMetadata(parseSourcePlateMetadata(MODEL_SETTINGS).get(1), true))
  assert.ok(!carried.includes('gcode_file'))
})

test('a filament-scoped key survives an untouched filament list and drops when it changes', () => {
  // `filament_maps` is positional over the filaments. Re-keying a permutation is possible, resizing
  // a count change is not, and a wrong nozzle grouping is worse than none: dropping returns the
  // engine to the automatic assignment a user who never pinned one gets.
  const entries = parseSourcePlateMetadata(MODEL_SETTINGS).get(1)
  assert.ok(keys(preservedPlateMetadata(entries, true)).includes('filament_maps'))
  assert.ok(!keys(preservedPlateMetadata(entries, false)).includes('filament_maps'))
})

test('an unrecognised key is NOT carried', () => {
  // Deliberately an allow-list. A plate block is engine-authoritative config applied OVER the
  // project-global values we author (`BambuStudio.cpp:6866`), so an unknown key here is not inert
  // data, it is a per-plate override that can beat the user's own choice.
  const withFuture = MODEL_SETTINGS.replace(
    '    <metadata key="locked" value="true"/>',
    '    <metadata key="some_future_bambu_key" value="7"/>'
  )
  const carried = keys(preservedPlateMetadata(parseSourcePlateMetadata(withFuture).get(1), true))
  assert.ok(!carried.includes('some_future_bambu_key'))
})

test('the print-sequence lists follow the filament set, since their values are filament ids', () => {
  // The project-level copy of the same key is re-keyed value-wise for exactly this reason; carrying
  // the plate-level copy unchanged leaves it naming filaments that no longer exist, and the plate
  // copy is the one the engine applies last.
  const withSequence = MODEL_SETTINGS.replace(
    '    <metadata key="locked" value="true"/>',
    '    <metadata key="first_layer_print_sequence" value="1 2 3"/>'
  )
  const entries = parseSourcePlateMetadata(withSequence).get(1)
  assert.ok(keys(preservedPlateMetadata(entries, true)).includes('first_layer_print_sequence'))
  assert.ok(!keys(preservedPlateMetadata(entries, false)).includes('first_layer_print_sequence'))
})

test('the map MODE is dropped with its map, not left pinning Manual', () => {
  // A plate left on Manual with no map falls back to the project-global map rather than to auto
  // (`PartPlate.cpp:266-289`), which is the opposite of what dropping the map is meant to achieve.
  const withMode = MODEL_SETTINGS.replace(
    '    <metadata key="locked" value="true"/>',
    '    <metadata key="filament_map_mode" value="Manual"/>'
  )
  const entries = parseSourcePlateMetadata(withMode).get(1)
  assert.ok(!keys(preservedPlateMetadata(entries, false)).includes('filament_map_mode'))
})

test('a plate the source never had contributes nothing', () => {
  assert.deepEqual(preservedPlateMetadata(undefined, true), [])
})

test('an escaped value round-trips unchanged', () => {
  const escaped = '<config><plate><metadata key="plater_id" value="1"/><metadata key="print_sequence" value="by &amp; object"/></plate></config>'
  const carried = preservedPlateMetadata(parseSourcePlateMetadata(escaped).get(1), true)
  assert.equal(carried[0]?.rawValue, 'by &amp; object', 'the value was double-escaped or decoded')
})

const SLICE_INFO = [
  '<config>',
  '  <plate>',
  '    <metadata key="index" value="1"/>',
  '    <metadata key="weight" value="11"/>',
  '  </plate>',
  '  <plate>',
  '    <metadata key="index" value="2"/>',
  '    <metadata key="weight" value="22"/>',
  '  </plate>',
  '  <plate>',
  '    <metadata key="index" value="3"/>',
  '    <metadata key="weight" value="33"/>',
  '  </plate>',
  '</config>'
].join('\n')

/** Each surviving record's index paired with the weight that proves WHICH plate it came from. */
const sliceInfoPairs = (xml: string) =>
  [...xml.matchAll(/<plate\b[^>]*>([\s\S]*?)<\/plate>/g)].map((block) => [
    /<metadata\s+key="index"\s+value="(\d+)"/.exec(block[1] ?? '')?.[1],
    /<metadata\s+key="weight"\s+value="(\d+)"/.exec(block[1] ?? '')?.[1]
  ])

test('a plate REORDER moves each slice record with its own plate', () => {
  // The nastiest case, because nothing misses: every record still resolves, so two plates simply
  // swap each other's weight and print time with no error anywhere. Weight is the witness - index 1
  // must still carry 11 after plates 1 and 2 trade places.
  const remapped = remapSliceInfoPlates(SLICE_INFO, new Map([[1, 2], [2, 1], [3, 3]]))
  assert.deepEqual(sliceInfoPairs(remapped).sort(), [['1', '22'], ['2', '11'], ['3', '33']].sort())
})

test('a deleted plate takes its slice record with it rather than renumbering onto a survivor', () => {
  // Delete plate 1 of three and the survivors renumber to 1 and 2. Keeping all three records would
  // hand the new plate 1 the DELETED plate's weight, which is the misattribution this prevents;
  // dropping is the only truthful answer, since the usage cannot be re-derived.
  const remapped = remapSliceInfoPlates(SLICE_INFO, new Map([[2, 1], [3, 2]]))
  assert.deepEqual(sliceInfoPairs(remapped), [['1', '22'], ['2', '33']])
})

test('an edit whose plates name no source is unmapped, never assumed to be the identity', () => {
  // Identity is exactly the WRONG guess for a reorder, so "the edit does not say" has to be its own
  // answer and the caller decides. A single named plate is enough to make the edit mappable.
  assert.equal(sourcePlateMapping([{ index: 1 }, { index: 2 }]), null)
  assert.deepEqual(sourcePlateMapping([{ index: 1, sourceIndex: 2 }, { index: 2 }]), new Map([[2, 1]]))
  // A session-added plate has no source record to carry, so it contributes nothing.
  assert.deepEqual(sourcePlateMapping([{ index: 1, sourceIndex: 3 }, { index: 2, sourceIndex: null }]), new Map([[3, 1]]))
})

