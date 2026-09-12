import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSlicingJobSchema, type ThreeMfProjectFilament } from '@printstream/shared'
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
const mixed = {
	...filament(3, '#808080'),
	mixedFilament: {
		componentIds: [1, 2], ratios: [0.5, 0.5], gradient: false,
		gradientRange: [0.1, 0.9] as [number, number], gradientCurve: null,
		gradientPerPart: false, issues: []
	}
}

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

test('visibleMappingFilaments: a used mixed slot maps its physical components, never the virtual slot', () => {
	const visible = visibleMappingFilaments([white, black, mixed], new Set([3]), true)
	assert.deepEqual(visible.map((f) => f.id), [1, 2])
})

test('visibleMappingFilaments: an unsliced project offers every physical slot but no mixed virtual slot', () => {
	const visible = visibleMappingFilaments([white, black, mixed], new Set([3]), false)
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

test('buildCreateSlicingJobBody: carries the editor content base alongside the scene edit', () => {
	// Regression (the inverted two-colour print): a `sceneEdit` is a diff against the bytes the
	// editor session OPENED, but the slice body named only the source FILE, so the API baked it
	// against that file's head. After a save the head IS the session's own output, so the edit
	// applied twice -- `partOrder` is not idempotent, and the second application permuted the
	// object's parts while the per-part `extruder` values stayed on their old positions. The body
	// printed in the logo's material and the logo in the body's.
	const sceneEdit = { plates: [] } as unknown as NonNullable<SliceFileSubmitInput['sceneEdit']>
	const body = buildCreateSlicingJobBody(
		printSubmitInput({ sceneEdit, contentBase: { fileId: 'file-1', versionId: 'version-opened' } }),
		{ sourceFileId: 'file-1', outputFolderId: null }
	)
	assert.deepEqual(body.contentBase, { fileId: 'file-1', versionId: 'version-opened' })
	assert.equal(body.sceneEdit, sceneEdit)
})

test('buildCreateSlicingJobBody: omits the content base when there is no scene edit to re-apply', () => {
	// A plain library slice bakes nothing, so it must read the file exactly as it stands. Pinning it
	// to some earlier version would slice stale bytes.
	const body = buildCreateSlicingJobBody(
		printSubmitInput(),
		{ sourceFileId: 'file-1', outputFolderId: null }
	)
	assert.equal(body.contentBase, undefined)
	assert.equal(body.sceneEdit, undefined)
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

test('a post-save staged source keeps its archived content-base pin separate from history lineage', () => {
	// The bytes already contain the edit. Sending both would ask the server to apply it a second
	// time over a file that has it, and `partOrder`/`removedParts` are not idempotent under that.
	const sceneEdit = { plates: [] } as unknown as NonNullable<SliceFileSubmitInput['sceneEdit']>
	const body = buildCreateSlicingJobBody(
		printSubmitInput({
			sceneEdit,
			contentBase: { fileId: 'file-1', versionId: 'version-opened' },
			preparedSourceId: 'prepared-9'
		}),
		{ sourceFileId: 'file-1' }
	)
	assert.equal(body.sourceFileId, 'file-1')
	assert.deepEqual(body.preparedSource, { id: 'prepared-9', contractVersion: 1 })
	assert.equal(body.sceneEdit, undefined)
	assert.deepEqual(body.contentBase, { fileId: 'file-1', versionId: 'version-opened' })
	assert.equal(createSlicingJobSchema.safeParse(body).success, true, 'the emitted prepared request must pass its wire schema')
	// The current head remains history lineage; the archived pin exists only to validate the proof.
	assert.equal(body.sourceVersionId, undefined)
})

test('a staged source suppresses the per-object overrides it already contains', () => {
	// Removing the edit flips the API's `!sceneEdit` guard, so its object-customization pass would
	// re-apply the map WITHOUT the re-key an edit-backed slice performed: an override on an object
	// created by "Replace with..." lands against a placeholder id the baked file never used.
	const sceneEdit = { plates: [] } as unknown as NonNullable<SliceFileSubmitInput['sceneEdit']>
	const body = buildCreateSlicingJobBody(
		printSubmitInput({
			sceneEdit,
			selectedObjectIds: [1],
			objectProcessOverrides: { 'object-1': { layer_height: ['0.2'] } },
			filamentChanges: [{ plateIndex: 1, changes: [] }],
			pauses: [{ plateIndex: 1, pauses: [] }],
			preparedSourceId: 'prepared-9'
		}),
		{ sourceFileId: 'file-1' }
	)
	assert.equal(body.selectedObjectIds, undefined)
	assert.equal(body.objectProcessOverrides, undefined)
	assert.equal(body.filamentChanges, undefined)
	assert.equal(body.pauses, undefined)
})
