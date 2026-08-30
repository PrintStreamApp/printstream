import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolvePrinterCardFooterOverflowKeys, shouldShowSkipObjectsAction } from './printerCardFooterActions'

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
test('shouldShowSkipObjectsAction hides the action on a single-object plate', () => {
	// Skipping the only object is a stop, so the control should not be offered. This had no gate
	// at all: the object list was fetched lazily when the dialog opened, so the card could not
	// know the count at render time.
	assert.equal(shouldShowSkipObjectsAction({ printerCanSkipObjects: true, objectCount: 1 }), false)
	assert.equal(shouldShowSkipObjectsAction({ printerCanSkipObjects: true, objectCount: 2 }), true)
})

test('shouldShowSkipObjectsAction keeps the action while the count is unknown', () => {
	// Loading, errored, or unreportable (internal-storage models): the dialog explains itself,
	// which is more useful than a button that silently vanishes.
	assert.equal(shouldShowSkipObjectsAction({ printerCanSkipObjects: true, objectCount: null }), true)
	// Zero is "we read the plate and found nothing", NOT a single-object plate.
	assert.equal(shouldShowSkipObjectsAction({ printerCanSkipObjects: true, objectCount: 0 }), true)
})

test('shouldShowSkipObjectsAction never overrides the printer-state gate', () => {
	assert.equal(shouldShowSkipObjectsAction({ printerCanSkipObjects: false, objectCount: 8 }), false)
	assert.equal(shouldShowSkipObjectsAction({ printerCanSkipObjects: false, objectCount: null }), false)
})
