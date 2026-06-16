import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolvePrinterCardFooterOverflowKeys } from './printerCardFooterActions'

test('resolvePrinterCardFooterOverflowKeys keeps actions inline when they fit', () => {
	const overflowKeys = resolvePrinterCardFooterOverflowKeys({
		actions: [
			{ key: 'pause' },
			{ key: 'skip-objects' },
			{ key: 'stop' }
		],
		actionWidths: {
			pause: 86,
			'skip-objects': 119,
			stop: 76
		},
		rowWidth: 358,
		overflowButtonWidth: 32,
		gapPx: 8
	})

	assert.deepEqual(Array.from(overflowKeys), [])
})

test('resolvePrinterCardFooterOverflowKeys overflows actions from the end when needed', () => {
	const overflowKeys = resolvePrinterCardFooterOverflowKeys({
		actions: [
			{ key: 'pause' },
			{ key: 'skip-objects' },
			{ key: 'stop' }
		],
		actionWidths: {
			pause: 86,
			'skip-objects': 119,
			stop: 76
		},
		rowWidth: 240,
		overflowButtonWidth: 32,
		gapPx: 8
	})

	assert.deepEqual(Array.from(overflowKeys), ['skip-objects', 'stop'])
})

test('resolvePrinterCardFooterOverflowKeys ignores optional zero-width actions', () => {
	const overflowKeys = resolvePrinterCardFooterOverflowKeys({
		actions: [
			{ key: 'plate-clearing', optional: true },
			{ key: 'pause' },
			{ key: 'skip-objects' },
			{ key: 'stop' }
		],
		actionWidths: {
			'plate-clearing': 0,
			pause: 86,
			'skip-objects': 119,
			stop: 76
		},
		rowWidth: 358,
		overflowButtonWidth: 32,
		gapPx: 8
	})

	assert.deepEqual(Array.from(overflowKeys), [])
})