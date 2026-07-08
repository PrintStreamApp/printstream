import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ThreeMfProjectFilament } from '@printstream/shared'
import { buildCreateSlicingJobBody, filamentsForMapping, visibleMappingFilaments, type SliceFileSubmitInput } from './libraryViewHelpers'

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
