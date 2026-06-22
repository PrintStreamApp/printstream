import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ThreeMfProjectFilament } from '@printstream/shared'
import { filamentsForMapping, visibleMappingFilaments } from './libraryViewHelpers'

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
