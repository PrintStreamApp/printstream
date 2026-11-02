/** Metadata-only regressions for sliced nozzle-group resolution; no customer geometry. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildThreeMfIndex } from './index-parser.js'
import { applyNozzleAssignmentToProjectSettings, rewriteSliceInfoNozzleGroups } from './bake-filament-settings.js'

const projectSettings = JSON.stringify({
  filament_type: Array(6).fill('PLA'),
  physical_extruder_map: ['1', '0'],
  filament_nozzle_map: ['1', '0', '0', '0', '0', '0'],
  extruder_nozzle_stats: ['Standard#1', 'High Flow#6']
})

function plate(index: number, groups: number[], extruders: number[]): string {
  return `<plate><metadata key="index" value="${index}"/>${groups.map((group, i) =>
    `<filament id="${i + 1}" group_id="${group}" type="PLA" used_g="1"/>`
  ).join('')}${extruders.map((extruder, id) =>
    `<nozzle id="${id}" extruder_id="${extruder}" nozzle_diameter="0.4"/>`
  ).join('')}</plate>`
}

const slicedPlate = plate(1, [5, 4, 3, 0, 2, 1], [1, 2, 2, 2, 2, 2])
const expected = [0, 0, 0, 1, 0, 0]

test('sliced group ids resolve through nozzle ids and one-based extruder ids', () => {
  const index = buildThreeMfIndex(`<config>${slicedPlate}</config>`, projectSettings, new Map(), new Map())
  assert.deepEqual(index.projectFilaments.map((f) => f.nozzleId), expected)
  assert.deepEqual(index.plates[0]?.filaments.map((f) => f.nozzleId), expected)
})

test('each plate resolves its own nozzle table and filament assignment', () => {
  const xml = `<config>${slicedPlate}${plate(2, [0, 1], [2, 1])}</config>`
  const index = buildThreeMfIndex(xml, projectSettings, new Map(), new Map())
  assert.deepEqual(index.plates[0]?.filaments.map((f) => f.nozzleId), expected)
  assert.deepEqual(index.plates[1]?.filaments.map((f) => f.nozzleId), [0, 1])
  // The project-wide summary retains its legacy last-record precedence; plate values are scoped.
  assert.deepEqual(index.projectFilaments.slice(0, 2).map((f) => f.nozzleId), [0, 1])
})

test('explicit sliced nozzle records outrank stale single-active project statistics', () => {
  const settings = JSON.stringify({ ...JSON.parse(projectSettings), extruder_nozzle_stats: ['Standard#1', 'High Flow#0'] })
  const index = buildThreeMfIndex(slicedPlate, settings, new Map(), new Map())
  assert.deepEqual(index.plates[0]?.filaments.map((f) => f.nozzleId), expected)
})

test('legacy slices without nozzle records retain their direct extruder groups', () => {
  const xml = plate(1, [0, 1], [])
  const index = buildThreeMfIndex(xml, projectSettings, new Map(), new Map())
  assert.deepEqual(index.plates[0]?.filaments.map((f) => f.nozzleId), [1, 0])
})

test('missing nozzle references never fall back to treating a group as an extruder', () => {
  const xml = plate(1, [0, 1], [2])
  const index = buildThreeMfIndex(xml, projectSettings, new Map(), new Map())
  assert.deepEqual(index.plates[0]?.filaments.map((f) => f.nozzleId), [0, null])
})

test('multiple groups on one extruder resolve, while multiple physical heads stay unknown', () => {
  const xml = plate(1, [0, 1], [1, 2, 2]).replace('group_id="0"', 'group_id="1,2"').replace('group_id="1"', 'group_id="0,1"')
  const index = buildThreeMfIndex(xml, projectSettings, new Map(), new Map())
  assert.deepEqual(index.plates[0]?.filaments.map((f) => f.nozzleId), [0, null])
})

test('plate scoping preserves ordinal indexes when legacy metadata omits explicit indexes', () => {
  const xml = `<config>${slicedPlate}${plate(2, [0, 1], [2, 1])}</config>`
    .replaceAll(/<metadata key="index" value="\d+"\/>/g, '')
  const index = buildThreeMfIndex(xml, projectSettings, new Map(), new Map())
  assert.deepEqual(index.plates[0]?.filaments.map((f) => f.nozzleId), expected)
  assert.deepEqual(index.plates[1]?.filaments.map((f) => f.nozzleId), [0, 1])
})

test('editor nozzle assignments round-trip through existing plate-local nozzle records', () => {
  const filaments = expected.map((nozzleId, sourceIndex) => ({ color: '#FFFFFF', sourceIndex, nozzleId: 1 - nozzleId }))
  const settings = applyNozzleAssignmentToProjectSettings(projectSettings, filaments)
  const xml = rewriteSliceInfoNozzleGroups(slicedPlate, filaments, ['1', '0'])
  const index = buildThreeMfIndex(xml, settings, new Map(), new Map())
  assert.deepEqual(index.projectFilaments.map((f) => f.nozzleId), expected.map((id) => 1 - id))
  assert.deepEqual(index.plates[0]?.filaments.map((f) => f.nozzleId), expected.map((id) => 1 - id))
})

test('a partial editor nozzle reassignment preserves the other filament groups and table rows', () => {
  const xml = rewriteSliceInfoNozzleGroups(slicedPlate, [{ color: '#FFFFFF', sourceIndex: 0, nozzleId: 1 }], ['1', '0'])
  const index = buildThreeMfIndex(xml, projectSettings, new Map(), new Map())
  assert.deepEqual(index.plates[0]?.filaments.map((f) => f.nozzleId), [1, 0, 0, 1, 0, 0])
  assert.ok(xml.includes('<nozzle id="5" extruder_id="2" nozzle_diameter="0.4"/>'))
})

test('moving to a previously unused head creates a table row without changing the other filaments', () => {
  const original = plate(1, [0, 0], [1])
  const xml = rewriteSliceInfoNozzleGroups(original, [{ color: '#FFFFFF', sourceIndex: 0, nozzleId: 0 }], ['1', '0'])
  const index = buildThreeMfIndex(xml, projectSettings, new Map(), new Map())
  assert.deepEqual(index.plates[0]?.filaments.map((f) => f.nozzleId), [0, 1])
  assert.ok(xml.includes('<nozzle id="1" extruder_id="2" nozzle_diameter="0.4"/>'))
})

test('the editor writer resolves nozzle ids independently for each plate', () => {
  const original = `<config>${plate(1, [0, 1], [1, 2])}${plate(2, [0, 1], [2, 1])}</config>`
  const filaments = [0, 1].map((nozzleId, sourceIndex) => ({ color: '#FFFFFF', sourceIndex, nozzleId }))
  const xml = rewriteSliceInfoNozzleGroups(original, filaments, ['1', '0'])
  const index = buildThreeMfIndex(xml, applyNozzleAssignmentToProjectSettings(projectSettings, filaments), new Map(), new Map())
  assert.deepEqual(index.plates.map((p) => p.filaments.map((f) => f.nozzleId)), [[0, 1], [0, 1]])
})
