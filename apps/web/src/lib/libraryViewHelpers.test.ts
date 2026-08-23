import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ThreeMfProjectFilament } from '@printstream/shared'
import { buildCreateSlicingJobBody, buildPrinterTrayGroups, buildSlicedOutputFileName, buildSlicedPlateLabel, filamentsForMapping, visibleMappingFilaments, type SliceFileSubmitInput } from './libraryViewHelpers'
import { filterTrayGroupsForFilament } from './printerTrayMapping'

const filament = (id: number, color: string): ThreeMfProjectFilament => ({
	id,
	filamentType: 'PLA',
	filamentName: 'Bambu PLA Basic',
	color,
	nozzleId: null,
	chamberTemperature: null
})

const white = filament(1, '#FFFFFF')
const black = filament(2, '#000000')

test('visibleMappingFilaments: sliced plate narrows the project list to the plate-used ids', () => {
	const visible = visibleMappingFilaments([white, black], new Set([1]), true)
	assert.deepEqual(visible.map((f) => f.id), [1])
})

test('visibleMappingFilaments: UNSLICED plate keeps every project filament even when the geometry estimate misses one', () => {
	// Regression: an unsliced colour-painted project (white base + painted black)
	// records only the base extruder (id 1) in its geometry estimate, so filtering
	// by usedIds would hide the painted black (id 2) from AMS mapping. The unsliced
	// path must surface the full project palette instead.
	const visible = visibleMappingFilaments([white, black], new Set([1]), false)
	assert.deepEqual(visible.map((f) => f.id), [1, 2])
})

test('filamentsForMapping: an empty used set surfaces all filaments', () => {
	const visible = filamentsForMapping([white, black], new Set())
	assert.deepEqual(visible.map((f) => f.id), [1, 2])
})

const printSubmitInput = (overrides: Partial<SliceFileSubmitInput> = {}): SliceFileSubmitInput => ({
	slicerTargetId: 'target-1',
	target: {
		mode: 'realPrinter',
		printerId: 'printer-1',
		printerProfileId: 'machine-1',
		processProfileId: 'process-1',
		processSettingOverrides: { wall_loops: '3' },
		filamentMappings: []
	},
	outputFileName: 'plate-1.gcode.3mf',
	plate: 1,
	...overrides
})

test('buildCreateSlicingJobBody: forwards per-object selection, overrides, and scene edit (the printers-flow regression)', () => {
	// Regression: the printers-view mutation used to hand-build the request body and silently drop
	// selectedObjectIds, so a "print only these objects" selection sliced the whole plate. The shared
	// builder must always carry the object-scoped fields through.
	const sceneEdit = { plates: [] } as unknown as NonNullable<SliceFileSubmitInput['sceneEdit']>
	const body = buildCreateSlicingJobBody(
		printSubmitInput({
			selectedObjectIds: [7, 9],
			objectProcessOverrides: { '7': { wall_loops: '4' } },
			sceneEdit
		}),
		{ sourceFileId: 'file-1', outputFolderId: null, hiddenOutput: true }
	)
	assert.deepEqual(body.selectedObjectIds, [7, 9])
	assert.deepEqual(body.objectProcessOverrides, { '7': { wall_loops: '4' } })
	assert.equal(body.sceneEdit, sceneEdit)
	assert.equal(body.sourceFileId, 'file-1')
	assert.equal(body.plate, 1)
	assert.equal(body.hiddenOutput, true)
	assert.equal(body.outputFolderId, null)
	assert.equal(body.target.mode === 'realPrinter' && body.target.printerId, 'printer-1')
	// The target's per-slice process overrides must survive too (also dropped by the old printers body).
	assert.deepEqual(body.target.processSettingOverrides, { wall_loops: '3' })
})

test('buildCreateSlicingJobBody: passes through source version and unset object selection', () => {
	const body = buildCreateSlicingJobBody(
		printSubmitInput(),
		{ sourceFileId: 'file-1', sourceVersionId: 'v-2', outputFolderId: 'folder-9', hiddenOutput: false }
	)
	assert.equal(body.sourceVersionId, 'v-2')
	assert.equal(body.outputFolderId, 'folder-9')
	assert.equal(body.hiddenOutput, false)
	// No selection ⇒ omitted, so the slicer keeps every object.
	assert.equal(body.selectedObjectIds, undefined)
	assert.equal(body.objectProcessOverrides, undefined)
	assert.equal(body.sceneEdit, undefined)
})

test('getSelectedTrayWarningMessages: warns when the printer reports no storage (upload would fail)', async () => {
  const { getSelectedTrayWarningMessages } = await import('./libraryViewHelpers')
  const withoutStorage = getSelectedTrayWarningMessages({
    mapping: [],
    trayByMappingValue: new Map(),
    filaments: [],
    status: { sdCardPresent: false } as never
  })
  assert.equal(withoutStorage.length, 1)
  assert.match(withoutStorage[0] ?? '', /no storage/)

  // Unknown (null) storage state must NOT warn: the printer simply has not reported yet.
  const unknownStorage = getSelectedTrayWarningMessages({
    mapping: [],
    trayByMappingValue: new Map(),
    filaments: [],
    status: { sdCardPresent: null } as never
  })
  assert.deepEqual(unknownStorage, [])
})

test('a single-plate project does not get a "Plate 1" suffix it cannot be distinguished by', () => {
  // Numbering one plate out of one distinguishes nothing; it just makes every sliced file noisier.
  assert.equal(buildSlicedPlateLabel(null, 1, 1), null)
  assert.equal(buildSlicedOutputFileName('Test.3mf', { plateNumber: 1, plateCount: 1 }), 'Test.gcode.3mf')
  // A NAMED plate still shows even as the only one: the user named it, so it carries information
  // a bare number does not.
  assert.equal(buildSlicedPlateLabel('Left half', 1, 1), 'Left half')
  assert.equal(buildSlicedOutputFileName('Test.3mf', { plateName: 'Left half', plateNumber: 1, plateCount: 1 }), 'Test - Left half.gcode.3mf')
  // Multi-plate projects are unchanged, and an unknown count stays conservative (keeps the number).
  assert.equal(buildSlicedPlateLabel(null, 1, 3), 'Plate 1')
  assert.equal(buildSlicedOutputFileName('Test.3mf', { plateNumber: 2, plateCount: 4 }), 'Test - Plate 2.gcode.3mf')
  assert.equal(buildSlicedPlateLabel(null, 1), 'Plate 1')
  assert.equal(buildSlicedPlateLabel(null, 1, null), 'Plate 1')
})

test('an AMS behind a Filament Track Switch stays available to both nozzles', () => {
  const unit = (unitId: number, over: Record<string, unknown> = {}) => ({
    unitId,
    type: 'ams',
    nozzleId: 0,
    supportDrying: false,
    dryTimeRemainingMinutes: null,
    dryingActive: false,
    dryFilament: null,
    dryTemperature: null,
    dryDurationHours: null,
    humidityPercent: null,
    humidityLevel: null,
    temperature: null,
    slots: [{
      slot: 0,
      trayName: null,
      filamentType: 'PLA',
      color: null,
      colors: [],
      remainPercent: null,
      active: false,
      isReading: false,
      trayInfoIdx: 'GFA00',
      trayUuid: null,
      occupied: true
    }],
    ...over
  })

  const status = {
    nozzles: [{ extruderId: 0 }, { extruderId: 1 }],
    externalSpools: [],
    // Unit 0 is wired straight to nozzle 0; unit 1 reaches BOTH through switch input A, even though
    // its reported nozzleId still says 0, a stale binding the switch has made meaningless.
    ams: [unit(0), unit(1, { switchInput: 'A' })]
  } as never

  const groups = buildPrinterTrayGroups(status)
  const [direct, switched] = groups
  assert.equal(direct?.trays[0]?.nozzleId, 0)
  assert.equal(switched?.trays[0]?.nozzleId, null, 'a switched unit must carry no nozzle binding')

  // The group label says how it is reached rather than naming one nozzle it is not limited to.
  assert.match(direct?.label ?? '', /Right nozzle/)
  assert.match(switched?.label ?? '', /Track switch A/)

  // The point of all of it: filtering for the OTHER nozzle keeps the switched unit.
  const forLeftNozzle = filterTrayGroupsForFilament(groups, 1)
  assert.deepEqual(forLeftNozzle.map((group) => group.key), ['ams-1'])
})
