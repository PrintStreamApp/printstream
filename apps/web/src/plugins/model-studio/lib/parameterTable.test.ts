/**
 * The parameter table's row model.
 *
 * Every case here is a shape this plugin has got wrong before, or one where being wrong is silent.
 * The three that matter most: linked copies must collapse to ONE row (a row per instance shows the
 * same override several times and implies several places to change it), volume rows must come from
 * `instanceVolumeRows` rather than `parts.length` (the bug that hid a baked part until the next
 * save), and a volume must inherit its OBJECT's overrides before the globals (or a part reports a
 * value it will never print at).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import {
  buildParameterTableRows,
  filterOverriddenRows,
  filterParameterTableRows,
  isUnsetCellValue,
  sortParameterTableRows,
  type ParameterTableInput
} from './parameterTable.js'
import { INHERITED_PLATE_SETTINGS } from './editorModel.js'
import type { EditorAddedPart, EditorInstance, EditorInstancePart, EditorPlate, EditorState } from './editorModel.js'

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]

function part(partIndex: number, overrides: Partial<EditorInstancePart> = {}): EditorInstancePart {
  return {
    entryPath: '/3D/Objects/object_1.model',
    // Deliberately NOT equal to partIndex: a mixup between the two type-checks and fails only at
    // runtime, so no fixture here may let the wrong one pass by coincidence.
    componentObjectId: 900 + partIndex,
    partIndex,
    transform: [...IDENTITY],
    filamentId: 1,
    name: `Part ${partIndex + 1}`,
    color: null,
    subtype: null,
    ...overrides
  }
}

function addedPart(key: string, overrides: Partial<EditorAddedPart> = {}): EditorAddedPart {
  return {
    key,
    importId: `import-${key}`,
    subtype: 'normal_part',
    name: key,
    position: new THREE.Vector3(),
    rotation: new THREE.Euler(),
    scale: new THREE.Vector3(1, 1, 1),
    soup: new Float32Array(),
    ...overrides
  }
}

function instance(objectId: number, overrides: Partial<EditorInstance> = {}): EditorInstance {
  return {
    key: `instance-${objectId}-${overrides.instanceId ?? 0}`,
    source: { kind: 'object' },
    objectId,
    instanceId: 0,
    name: `Object ${objectId}`,
    position: new THREE.Vector3(),
    rotation: new THREE.Euler(),
    scale: new THREE.Vector3(1, 1, 1),
    filamentId: 1,
    printable: true,
    parts: [],
    color: null,
    ...overrides
  }
}

function plate(index: number, instances: EditorInstance[]): EditorPlate {
  return {
    index,
    plateId: index * 100,
    sourcePlateIndex: index,
    name: null,
    ...INHERITED_PLATE_SETTINGS,
    bed: { minX: 0, maxX: 256, minY: 0, maxY: 256, maxZ: null, excludeAreas: [] },
    instances,
    primeTower: null
  }
}

function stateOf(plates: EditorPlate[], extra: Partial<EditorState> = {}): EditorState {
  return { plates, ...extra } as EditorState
}

const EMPTY_INPUT = {
  objectOverrides: {},
  globalOverrides: {},
  baseConfig: null,
  columns: ['layer_height']
} satisfies Omit<ParameterTableInput, 'state'>

test('linked copies collapse to one row carrying the copy count', () => {
  const state = stateOf([
    plate(1, [instance(1, { instanceId: 0 }), instance(1, { instanceId: 1 })]),
    plate(2, [instance(1, { instanceId: 2 })])
  ])

  const rows = buildParameterTableRows({ ...EMPTY_INPUT, state })

  assert.equal(rows.length, 1, 'three instances of one object must be one row')
  assert.equal(rows[0]!.copies, 3)
  assert.deepEqual(rows[0]!.plateIndexes, [1, 2], 'an object placed on two plates reports both')
})

test('an import with no identity yet contributes no row', () => {
  // It can carry no per-object settings at all, so a row for it would offer an edit that lands
  // nowhere.
  const orphan = instance(0, { source: { kind: 'import', importId: 'i1', meshUrl: 'x' } as EditorInstance['source'] })
  const rows = buildParameterTableRows({ ...EMPTY_INPUT, state: stateOf([plate(1, [orphan])]) })
  assert.deepEqual(rows, [])
})

test('an unsaved import with a synthetic id gets a row like any object', () => {
  const staged = instance(0, {
    source: { kind: 'import', importId: 'i1', meshUrl: 'x', replacedObjectId: -7 } as EditorInstance['source']
  })
  const rows = buildParameterTableRows({ ...EMPTY_INPUT, state: stateOf([plate(1, [staged])]) })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.objectId, -7, 'addressed by its editor-side identity, not a real object id')
})

test('a single-volume object lists no volume rows, and a two-volume one lists both', () => {
  const single = stateOf([plate(1, [instance(1, { parts: [part(0)] })])])
  assert.deepEqual(
    buildParameterTableRows({ ...EMPTY_INPUT, state: single }).map((row) => row.kind),
    ['object']
  )

  // The historical bug: one baked part plus one session-added volume listed only the added one, so
  // the baked part lost every control until the next save turned it into a second baked part.
  const mixed = stateOf(
    [plate(1, [instance(1, { parts: [part(0)] })])],
    { addedParts: { 1: [addedPart('vol-a')] } }
  )
  const rows = buildParameterTableRows({ ...EMPTY_INPUT, state: mixed })
  assert.deepEqual(rows.map((row) => row.kind), ['object', 'part', 'part'])
  assert.deepEqual(rows.slice(1).map((row) => row.name), ['Part 1', 'vol-a'])
})

test('an object with no part list gets a body row once a volume is added beside it', () => {
  const state = stateOf(
    [plate(1, [instance(1, { parts: [], name: 'Cube' })])],
    { addedParts: { 1: [addedPart('text')] } }
  )
  const rows = buildParameterTableRows({ ...EMPTY_INPUT, state })
  assert.deepEqual(rows.map((row) => row.member?.kind ?? 'object'), ['object', 'body', 'added'])
  assert.equal(rows[1]!.name, 'Cube', "the body row carries the object's own name, with no suffix")
})

test('cut connectors are not volume rows', () => {
  // A cut half with a body and one peg must read as a single-volume object, as it does everywhere
  // else, rather than growing a row per peg. Note this case is decided by `instanceVolumeRows`
  // alone (one real volume, so no rows at all), which is why the multi-volume case below exists.
  const oneVolume = stateOf([plate(1, [instance(1, { parts: [part(0), part(1, { cutConnector: true })] })])])
  assert.deepEqual(buildParameterTableRows({ ...EMPTY_INPUT, state: oneVolume }).map((row) => row.kind), ['object'])

  // The case that exercises the row loop's own filter: with TWO real volumes the object does list
  // rows, and the connector must not be one of them. Without this the filter is untested -- the
  // fixture above passes with it removed, because the rows are suppressed before the loop runs.
  const twoVolumes = stateOf([plate(1, [instance(1, {
    parts: [part(0), part(1), part(2, { cutConnector: true })]
  })])])
  assert.deepEqual(
    buildParameterTableRows({ ...EMPTY_INPUT, state: twoVolumes }).map((row) => row.name),
    ['Object 1', 'Part 1', 'Part 2']
  )
})

test('a cell resolves override over global over preset, and says which decided it', () => {
  const state = stateOf([plate(1, [instance(1)]), plate(1, [instance(2)]), plate(1, [instance(3)])])
  const rows = buildParameterTableRows({
    state,
    objectOverrides: { 1: { layer_height: '0.12' } },
    globalOverrides: { layer_height: '0.20' },
    baseConfig: { layer_height: '0.28' },
    columns: ['layer_height']
  })

  const own = rows.find((row) => row.objectId === 1)!
  assert.deepEqual(own.cells.layer_height, { value: '0.12', overridden: true, redundant: false })
  assert.equal(own.overrideCount, 1)

  const inherited = rows.find((row) => row.objectId === 2)!
  assert.deepEqual(inherited.cells.layer_height, { value: '0.20', overridden: false, redundant: false })
  assert.equal(inherited.overrideCount, 0)
})

test('a cell falls through to the preset when nothing overrides it', () => {
  const rows = buildParameterTableRows({
    state: stateOf([plate(1, [instance(1)])]),
    objectOverrides: {},
    globalOverrides: {},
    baseConfig: { layer_height: '0.28' },
    columns: ['layer_height']
  })
  assert.equal(rows[0]!.cells.layer_height!.value, '0.28')
})

test('a cell is null, not blank, when nothing supplies a value', () => {
  // The preset has not resolved yet. The grid still has to be useful, so an OVERRIDDEN cell must
  // resolve from the override alone.
  const rows = buildParameterTableRows({
    state: stateOf([plate(1, [instance(1)]), plate(1, [instance(2)])]),
    objectOverrides: { 2: { layer_height: '0.12' } },
    globalOverrides: {},
    baseConfig: null,
    columns: ['layer_height']
  })
  assert.equal(rows.find((row) => row.objectId === 1)!.cells.layer_height!.value, null)
  assert.equal(rows.find((row) => row.objectId === 2)!.cells.layer_height!.value, '0.12')
})

test('an override matching what would be inherited is flagged redundant, not hidden', () => {
  const rows = buildParameterTableRows({
    state: stateOf([plate(1, [instance(1)])]),
    objectOverrides: { 1: { layer_height: '0.20' } },
    globalOverrides: { layer_height: '0.20' },
    baseConfig: null,
    columns: ['layer_height']
  })
  assert.deepEqual(rows[0]!.cells.layer_height, { value: '0.20', overridden: true, redundant: true })
})

test('redundancy is decided by the value comparator, not string equality', () => {
  // BambuStudio writes a percent both ways; `===` would call this a meaningful override.
  const rows = buildParameterTableRows({
    state: stateOf([plate(1, [instance(1)])]),
    objectOverrides: { 1: { sparse_infill_density: '15%' } },
    globalOverrides: { sparse_infill_density: '15' },
    baseConfig: null,
    columns: ['sparse_infill_density']
  })
  assert.equal(rows[0]!.cells.sparse_infill_density!.redundant, true)
})

test("a volume inherits its object's override before the global", () => {
  const state = stateOf(
    [plate(1, [instance(1, { parts: [part(0), part(1)] })])],
    { partProcessOverrides: { '1:1': { layer_height: '0.08' } } }
  )
  const rows = buildParameterTableRows({
    state,
    objectOverrides: { 1: { layer_height: '0.12' } },
    globalOverrides: { layer_height: '0.20' },
    baseConfig: null,
    columns: ['layer_height']
  })

  const first = rows[1]!
  const second = rows[2]!
  assert.deepEqual(first.cells.layer_height, { value: '0.12', overridden: false, redundant: false },
    "an unoverridden volume shows its OBJECT's value, not the global")
  assert.deepEqual(second.cells.layer_height, { value: '0.08', overridden: true, redundant: false })
})

test("a session-added volume's overrides come off the volume, not the slot map", () => {
  const state = stateOf(
    [plate(1, [instance(1, { parts: [part(0)] })])],
    { addedParts: { 1: [addedPart('vol-a', { settings: { layer_height: '0.06' } })] } }
  )
  const rows = buildParameterTableRows({ ...EMPTY_INPUT, state })
  const added = rows.find((row) => row.member?.kind === 'added')!
  assert.deepEqual(added.cells.layer_height, { value: '0.06', overridden: true, redundant: false })
  assert.equal(added.overrideCount, 1)
})

test('sorting reorders objects and keeps every volume with its own object', () => {
  const state = stateOf([
    plate(1, [
      instance(1, { name: 'Zebra', parts: [part(0), part(1)] }),
      instance(2, { name: 'Apple' })
    ])
  ])
  const rows = buildParameterTableRows({ ...EMPTY_INPUT, state })
  const sorted = sortParameterTableRows(rows, 'name', 'asc')

  assert.deepEqual(
    sorted.map((row) => `${row.kind}:${row.name}`),
    ['object:Apple', 'object:Zebra', 'part:Part 1', 'part:Part 2']
  )
})

test('a setting column sorts numerically, not as text', () => {
  const rows = buildParameterTableRows({
    state: stateOf([plate(1, [instance(1), instance(2), instance(3)])]),
    objectOverrides: { 1: { wall_loops: '10' }, 2: { wall_loops: '2' }, 3: { wall_loops: '3' } },
    globalOverrides: {},
    baseConfig: null,
    columns: ['wall_loops']
  })
  assert.deepEqual(
    sortParameterTableRows(rows, 'wall_loops', 'asc').map((row) => row.cells.wall_loops!.value),
    ['2', '3', '10']
  )
})

test('rows with no value for the sorted column stay last in BOTH directions', () => {
  const rows = buildParameterTableRows({
    state: stateOf([plate(1, [instance(1), instance(2), instance(3)])]),
    objectOverrides: { 1: { wall_loops: '4' }, 3: { wall_loops: '2' } },
    globalOverrides: {},
    baseConfig: null,
    columns: ['wall_loops']
  })

  // Descending must not fill the top of the table with rows that have no answer for the column.
  for (const direction of ['asc', 'desc'] as const) {
    const sorted = sortParameterTableRows(rows, 'wall_loops', direction)
    assert.equal(sorted[sorted.length - 1]!.objectId, 2, `unset sorts last when ${direction}`)
  }
  assert.deepEqual(
    sortParameterTableRows(rows, 'wall_loops', 'desc').slice(0, 2).map((row) => row.cells.wall_loops!.value),
    ['4', '2']
  )
})

test('an EMPTY value sorts last in both directions, not just when ascending', () => {
  // Regression: the comparator called an empty value unset while the sign rule tested only `null`,
  // so descending flipped the comparator's verdict and the empty row jumped to the TOP. An empty
  // serialized value is a real shape -- `isUnsetProcessValue` recognises it and `String([])`
  // produces it for an empty vector.
  const rows = buildParameterTableRows({
    state: stateOf([plate(1, [instance(1), instance(2), instance(3)])]),
    objectOverrides: { 1: { wall_loops: '' }, 2: { wall_loops: '5' }, 3: { wall_loops: '2' } },
    globalOverrides: {},
    baseConfig: null,
    columns: ['wall_loops']
  })

  for (const direction of ['asc', 'desc'] as const) {
    const sorted = sortParameterTableRows(rows, 'wall_loops', direction)
    assert.equal(sorted[sorted.length - 1]!.objectId, 1, `the empty value sorts last when ${direction}`)
  }
  assert.deepEqual(
    sortParameterTableRows(rows, 'wall_loops', 'desc').slice(0, 2).map((row) => row.cells.wall_loops!.value),
    ['5', '2']
  )
})

test('an empty ARRAY value counts as unset too', () => {
  const rows = buildParameterTableRows({
    state: stateOf([plate(1, [instance(1), instance(2)])]),
    objectOverrides: { 1: { wall_loops: [] }, 2: { wall_loops: '3' } },
    globalOverrides: {},
    baseConfig: null,
    columns: ['wall_loops']
  })
  for (const direction of ['asc', 'desc'] as const) {
    assert.equal(sortParameterTableRows(rows, 'wall_loops', direction)[1]!.objectId, 1, direction)
  }
})

test('printability is three-valued, because copies can disagree', () => {
  // Printability is PER INSTANCE while a row collapses every copy, so reading the first instance's
  // value gave an arbitrary answer that flipped with plate order.
  const state = stateOf([plate(1, [
    instance(1, { instanceId: 0, printable: true }),
    instance(1, { instanceId: 1, printable: false }),
    instance(2, { printable: true }),
    instance(3, { printable: false })
  ])])
  const rows = buildParameterTableRows({ ...EMPTY_INPUT, state })

  assert.equal(rows.find((row) => row.objectId === 1)!.printability, 'mixed')
  assert.equal(rows.find((row) => row.objectId === 2)!.printability, 'all')
  assert.equal(rows.find((row) => row.objectId === 3)!.printability, 'none')
})

test('a skipped FIRST copy does not make the whole object read as skipped', () => {
  // The inverse of the case above, and the one that made the old bug visible in the other
  // direction: whichever copy the walk saw first decided the answer for all of them.
  const state = stateOf([plate(1, [
    instance(1, { instanceId: 0, printable: false }),
    instance(1, { instanceId: 1, printable: true })
  ])])
  assert.equal(buildParameterTableRows({ ...EMPTY_INPUT, state })[0]!.printability, 'mixed')
})

test('an unsorted table keeps the project order', () => {
  const state = stateOf([plate(1, [instance(9, { name: 'Zebra' }), instance(2, { name: 'Apple' })])])
  const rows = buildParameterTableRows({ ...EMPTY_INPUT, state })
  assert.deepEqual(sortParameterTableRows(rows, null, 'asc').map((row) => row.name), ['Zebra', 'Apple'])
})

test('a search matching a volume keeps its object row above it', () => {
  const state = stateOf(
    [plate(1, [instance(1, { name: 'Bracket', parts: [part(0, { name: 'Insert' }), part(1, { name: 'Shell' })] })])]
  )
  const rows = buildParameterTableRows({ ...EMPTY_INPUT, state })

  assert.deepEqual(
    filterParameterTableRows(rows, 'insert').map((row) => row.name),
    ['Bracket', 'Insert'],
    'an indented row under nothing reads as an object with a strange name'
  )
  assert.deepEqual(
    filterParameterTableRows(rows, 'bracket').map((row) => row.name),
    ['Bracket'],
    "matching an object's name must not list every volume it has"
  )
})

test('the overridden-only filter keeps an object row above a surviving volume', () => {
  const state = stateOf(
    [plate(1, [
      instance(1, { name: 'Bracket', parts: [part(0), part(1)] }),
      instance(2, { name: 'Plain' })
    ])],
    { partProcessOverrides: { '1:1': { layer_height: '0.08' } } }
  )
  const rows = buildParameterTableRows({ ...EMPTY_INPUT, state })

  assert.deepEqual(
    filterOverriddenRows(rows).map((row) => `${row.kind}:${row.name}`),
    ['object:Bracket', 'part:Part 2']
  )
})

test('a per-extruder value blank on EVERY extruder is unset, not a value', () => {
  // `['', ''].join(',')` is `','`, so a joined test called a dual-extruder blank SET: it sorted
  // above genuinely unset rows, and the grid (which defers to this predicate) would render a bare
  // ", " instead of the em-dash and its "Not set by this project or its preset" tooltip. `['']`
  // happened to work, which is why only the dual-nozzle case showed it.
  assert.equal(isUnsetCellValue(['', '']), true)
  assert.equal(isUnsetCellValue(['']), true)
  assert.equal(isUnsetCellValue([]), true)
  assert.equal(isUnsetCellValue(''), true)
  assert.equal(isUnsetCellValue(null), true)
  assert.equal(isUnsetCellValue(undefined), true)

  // A value on ANY extruder is a value: the row has an answer, even a partial one.
  assert.equal(isUnsetCellValue(['0.2', '']), false)
  assert.equal(isUnsetCellValue(['', '0.2']), false)
  assert.equal(isUnsetCellValue('0.2'), false)
})
