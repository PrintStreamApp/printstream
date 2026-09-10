import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrintPauseSchedule, PrinterStatus } from '@printstream/shared'
import { buildPrintPauseMarkerView } from './printPauseMarkers'

type PauseStatus = Parameters<typeof buildPrintPauseMarkerView>[0]

function scheduleOf(overrides: Partial<PrintPauseSchedule> = {}): PrintPauseSchedule {
  return {
    total: 3,
    points: [
      { index: 1, layer: 20, progressPercent: 18, remainingMinutes: 240 },
      { index: 2, layer: 60, progressPercent: 55, remainingMinutes: 120 },
      { index: 3, layer: 140, progressPercent: 88, remainingMinutes: 30 }
    ],
    totalLayers: 200,
    source: 'slicedFile',
    ...overrides
  }
}

/** Nine pauses at layers 20..180, more than the bar will draw. */
function manyPoints(): PrintPauseSchedule['points'] {
  return Array.from({ length: 9 }, (_, index) => ({
    index: index + 1,
    layer: (index + 1) * 20,
    progressPercent: (index + 1) * 10,
    remainingMinutes: 300 - (index + 1) * 30
  }))
}

function statusOf(overrides: Partial<PrinterStatus> = {}): PauseStatus {
  return {
    stage: 'printing',
    progressPercent: 40,
    currentLayer: 45,
    totalLayers: 200,
    remainingMinutes: 130,
    pauseSchedule: null,
    ...overrides
  }
}

test('marks every pause at the percent the printer will report there', () => {
  const view = buildPrintPauseMarkerView(statusOf(), { pauseSchedule: scheduleOf() })

  assert.deepEqual(view.markers.map((marker) => marker.percent), [18, 55, 88])
  // Not 10 / 30 / 70, which is what layer / totalLayers would have given.
  assert.notDeepEqual(view.markers.map((marker) => marker.percent), [10, 30, 70])
})

test('keeps marks for pauses already passed', () => {
  // The bar is a picture of the whole print; a tick vanishing as the printer crosses it would
  // look like the pause was cancelled.
  const view = buildPrintPauseMarkerView(statusOf({ currentLayer: 150 }), { pauseSchedule: scheduleOf() })

  assert.equal(view.markers.length, 3)
})

test('names the next pause and how far off it is', () => {
  const view = buildPrintPauseMarkerView(statusOf(), { pauseSchedule: scheduleOf() })

  assert.equal(view.readout, 'Next pause: layer 60, 10m away')
})

test('numbers the pause the printer is stopped at, without repeating the word "paused"', () => {
  const view = buildPrintPauseMarkerView(
    statusOf({ stage: 'paused', currentLayer: 60, remainingMinutes: 120 }),
    { pauseSchedule: scheduleOf() }
  )

  assert.equal(view.readout, 'Pause 2 of 3')
})

test('falls back to naming the next pause when a stopped printer is not at one of ours', () => {
  // Paused by the user mid-layer, not by a baked pause.
  const view = buildPrintPauseMarkerView(
    statusOf({ stage: 'paused', currentLayer: 45 }),
    { pauseSchedule: scheduleOf() }
  )

  assert.equal(view.readout, 'Next pause: layer 60, 10m away')
})

test('says nothing at all when no producer knows the pauses', () => {
  const view = buildPrintPauseMarkerView(statusOf(), { pauseSchedule: null })

  assert.deepEqual(view.markers, [])
  assert.equal(view.readout, null)
})

test('says nothing when the plate genuinely has no pauses', () => {
  const view = buildPrintPauseMarkerView(statusOf(), {
    pauseSchedule: scheduleOf({ total: 0, points: [] })
  })

  assert.deepEqual(view.markers, [])
  assert.equal(view.readout, null)
})

test('prefers the printer-reported schedule over the dispatched file', () => {
  const view = buildPrintPauseMarkerView(
    statusOf({
      pauseSchedule: {
        total: 1,
        points: [{ index: 1, layer: 70, progressPercent: 64, remainingMinutes: 90 }],
        totalLayers: null,
        source: 'printer'
      }
    }),
    { pauseSchedule: scheduleOf() }
  )

  assert.deepEqual(view.markers.map((marker) => marker.percent), [64])
  assert.equal(view.readout, 'Next pause: layer 70, 40m away')
})

test('draws nothing from a scanned file the printer is not running', () => {
  // The job dispatched a 200-layer file; the printer reports 640 layers, so it is running
  // something else and every scanned tick would be in the wrong place.
  const view = buildPrintPauseMarkerView(statusOf({ totalLayers: 640 }), { pauseSchedule: scheduleOf() })

  assert.deepEqual(view.markers, [])
  assert.equal(view.readout, null)
})

test('caps the marks drawn but still names the next pause', () => {
  const view = buildPrintPauseMarkerView(
    statusOf({ currentLayer: 5, remainingMinutes: 300 }),
    { pauseSchedule: scheduleOf({ total: 9, points: manyPoints() }) }
  )

  assert.equal(view.markers.length, 5)
  assert.equal(view.readout, 'Next pause: layer 20, 30m away')
})

test('spends the cap on the pauses still ahead, not on ones already passed', () => {
  // 9 pauses at layers 20..180 with the printer at 150: the last two are the only ones the user
  // can still act on, so they must get ticks even though five earlier ones come first in the list.
  const view = buildPrintPauseMarkerView(
    statusOf({ currentLayer: 150, remainingMinutes: 60 }),
    { pauseSchedule: scheduleOf({ total: 9, points: manyPoints() }) }
  )

  const layers = view.markers.map((marker) => marker.label)
  assert.equal(view.markers.length, 5)
  assert.ok(layers.some((label) => label.startsWith('Pause at layer 160')))
  assert.ok(layers.some((label) => label.startsWith('Pause at layer 180')))
  // The spare room backfills with the most recent passed ones, nearest the fill edge.
  assert.ok(layers.some((label) => label.startsWith('Pause at layer 140')))
  assert.ok(!layers.some((label) => label.startsWith('Pause at layer 20')))
})

test('a pause the printer will not time is labelled without one', () => {
  const view = buildPrintPauseMarkerView(statusOf(), {
    pauseSchedule: scheduleOf({
      total: 1,
      points: [{ index: 1, layer: 60, progressPercent: 55, remainingMinutes: null }]
    })
  })

  assert.equal(view.markers[0]?.label, 'Pause at layer 60')
  assert.equal(view.readout, 'Next pause: layer 60')
})

test('labels a mark with its layer, and with the time only when one can be stated', () => {
  const withTime = buildPrintPauseMarkerView(statusOf(), { pauseSchedule: scheduleOf() })
  assert.equal(withTime.markers[1]?.label, 'Pause at layer 60, 10m away')

  const noTime = buildPrintPauseMarkerView(statusOf({ remainingMinutes: null }), {
    pauseSchedule: scheduleOf()
  })
  assert.equal(noTime.markers[1]?.label, 'Pause at layer 60')
})

test('says nothing for a printer reporting no status at all', () => {
  assert.deepEqual(buildPrintPauseMarkerView(undefined, { pauseSchedule: scheduleOf() }), {
    markers: [],
    readout: null
  })
})
