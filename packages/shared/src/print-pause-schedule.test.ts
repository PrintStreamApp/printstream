import assert from 'node:assert/strict'
import test from 'node:test'
import {
  currentPrintPauseNumber,
  minutesUntilPrintPause,
  nextPrintPause,
  partitionPrintPauses,
  printPauseScheduleSchema,
  resolvePrintPauseSchedule,
  type PrintPauseSchedule
} from './print-pause-schedule.js'

function schedule(overrides: Partial<PrintPauseSchedule> = {}): PrintPauseSchedule {
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

test('grades a pause on the layer the printer reports, not on percent', () => {
  // The printer's remaining time already puts it past the second pause's own 120 minutes, while
  // its layer does not. The layer wins, because a re-estimate moves the time and never moves the
  // layer -- and note the progress shape has no percent at all, so this cannot regress by
  // someone reaching for one.
  const { reached, upcoming } = partitionPrintPauses(schedule(), {
    currentLayer: 45,
    remainingMinutes: 110
  })

  assert.deepEqual(reached.map((point) => point.index), [1])
  assert.deepEqual(upcoming.map((point) => point.index), [2, 3])
})

test('counts the pause on the current layer as reached, not upcoming', () => {
  const { reached, upcoming } = partitionPrintPauses(schedule(), {
    currentLayer: 60,
    remainingMinutes: 120
  })

  assert.deepEqual(reached.map((point) => point.index), [1, 2])
  assert.deepEqual(upcoming.map((point) => point.index), [3])
})

test('treats every pause as upcoming while no layer has been reported', () => {
  const { reached, upcoming } = partitionPrintPauses(schedule(), {
    currentLayer: null,
    remainingMinutes: 300
  })

  assert.deepEqual(reached, [])
  assert.equal(upcoming.length, 3)
})

test('names the next pause and how long until the printer reaches it', () => {
  const progress = { currentLayer: 45, remainingMinutes: 130 }
  const next = nextPrintPause(schedule(), progress)

  assert.equal(next?.index, 2)
  assert.equal(next?.layer, 60)
  assert.equal(minutesUntilPrintPause(next!, progress), 10)
})

test('says nothing rather than "0 min" once the estimate has slipped past a pause', () => {
  const progress = { currentLayer: 45, remainingMinutes: 120 }

  assert.equal(minutesUntilPrintPause(schedule().points[1]!, progress), null)
})

test('cannot state a time to the next pause with no remaining time reported', () => {
  const progress = { currentLayer: 10, remainingMinutes: null }

  assert.equal(minutesUntilPrintPause(schedule().points[0]!, progress), null)
})

test('numbers the pause the printer is sitting on, and only that one', () => {
  assert.equal(currentPrintPauseNumber(schedule(), { currentLayer: 60, remainingMinutes: 120 }), 2)
  assert.equal(currentPrintPauseNumber(schedule(), { currentLayer: 61, remainingMinutes: 118 }), null)
})

test('prefers the printer schedule over one scanned from the dispatched file', () => {
  const printerSchedule = schedule({ source: 'printer', totalLayers: null, total: 1, points: [
    { index: 1, layer: 12, progressPercent: 9, remainingMinutes: 280 }
  ] })

  const resolved = resolvePrintPauseSchedule({
    printerSchedule,
    slicedFileSchedule: schedule(),
    reportedTotalLayers: 200
  })

  assert.equal(resolved, printerSchedule)
})

test('refuses a scanned schedule whose layer count is not the file the printer is running', () => {
  const resolved = resolvePrintPauseSchedule({
    slicedFileSchedule: schedule(),
    reportedTotalLayers: 640
  })

  assert.equal(resolved, null)
})

test('tolerates a one-layer counting difference rather than disabling the fallback', () => {
  // The file header and the printer's own count come from different places, and an off-by-one
  // convention must not silently switch the whole feature off.
  for (const reported of [199, 200, 201]) {
    assert.equal(
      resolvePrintPauseSchedule({ slicedFileSchedule: schedule(), reportedTotalLayers: reported })?.source,
      'slicedFile',
      `expected the fallback to survive a reported count of ${reported}`
    )
  }
  assert.equal(
    resolvePrintPauseSchedule({ slicedFileSchedule: schedule(), reportedTotalLayers: 202 }),
    null
  )
})

test('admits a scanned schedule before the printer has reported a layer count', () => {
  const fallback = schedule()

  assert.equal(resolvePrintPauseSchedule({ slicedFileSchedule: fallback, reportedTotalLayers: null }), fallback)
  assert.equal(
    resolvePrintPauseSchedule({ slicedFileSchedule: schedule({ totalLayers: null }), reportedTotalLayers: 200 })
      ?.source,
    'slicedFile'
  )
})

test('distinguishes "no pauses" from "we do not know"', () => {
  assert.equal(resolvePrintPauseSchedule({}), null)

  const none = resolvePrintPauseSchedule({
    slicedFileSchedule: schedule({ total: 0, points: [] }),
    reportedTotalLayers: 200
  })
  assert.deepEqual(none?.points, [])
  assert.equal(none?.total, 0)
})

test('defaults totalLayers so a payload from an older producer still parses', () => {
  const parsed = printPauseScheduleSchema.parse({
    total: 1,
    points: [{ index: 1, layer: 5, progressPercent: 3, remainingMinutes: 90 }],
    source: 'printer'
  })

  assert.equal(parsed.totalLayers, null)
})
