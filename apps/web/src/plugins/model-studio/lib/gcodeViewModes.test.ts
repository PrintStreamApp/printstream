import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  emptyValueRange,
  gcodeViewModeInfo,
  gcodeViewModeMetric,
  hasRangeSamples,
  isGcodeViewMode,
  rangeColorAt,
  rangeLegendRows,
  rangeValueAtStep,
  roundToBin,
  updateValueRange,
  GCODE_RANGE_COLORS,
  GCODE_RANGE_OUT_OF_RANGE_COLOR,
  GCODE_TRAVEL_COLORS,
  GCODE_VIEW_MODES
} from './gcodeViewModes'

/** A range spanning [0, 90], so each of the ramp's nine steps is exactly 10 units wide. */
function decadeRange() {
  const range = emptyValueRange()
  updateValueRange(range, 0)
  updateValueRange(range, 45)
  updateValueRange(range, 90)
  return range
}

test('the ramp is BambuStudio Range_Colors: ten stops, magenta to green', () => {
  // Pinned against src/slic3r/GUI/GCodeRenderer/BaseRenderer.cpp:157-169. The `// bluish` and
  // `// reddish` comments there are stale; the values are magenta and green.
  assert.equal(GCODE_RANGE_COLORS.length, 10)
  assert.equal(GCODE_RANGE_COLORS[0], 0xff00ff)
  assert.equal(GCODE_RANGE_COLORS[9], 0x00ff00)
  assert.deepEqual([...GCODE_RANGE_COLORS], [
    0xff00ff, 0xff55a9, 0xfe8778, 0xffb847, 0xffd925,
    0xffff00, 0xd8ff00, 0xadff04, 0x76ff01, 0x00ff00
  ])
})

test('Travel_Colors are Move / Extrude / Retract in BambuStudio order', () => {
  // BaseRenderer.cpp:150-154, floats rounded to bytes.
  assert.deepEqual([...GCODE_TRAVEL_COLORS], [0x38489b, 0x1d6c1a, 0x811007])
})

test('a value lands exactly on a stop at each ninth of the range', () => {
  const range = decadeRange()
  for (let step = 0; step <= 9; step++) {
    assert.equal(rangeColorAt(range, step * 10), GCODE_RANGE_COLORS[step],
      `step ${step} (value ${step * 10}) should be stop ${step}`)
  }
})

test('the ramp INTERPOLATES between stops rather than snapping to the nearest', () => {
  // This is the CPU renderer's behaviour (Range::get_color_at, BaseRenderer.cpp:3870). The GPU
  // renderer samples a 10-texel texture instead, which squashes the ends; the CPU form is
  // canonical and is what the legend's labels describe.
  const range = decadeRange()
  // Halfway between stop 0 (#FF00FF) and stop 1 (#FF55A9).
  const mid = rangeColorAt(range, 5)
  assert.equal(mid, 0xff2bd4)
  assert.notEqual(mid, GCODE_RANGE_COLORS[0])
  assert.notEqual(mid, GCODE_RANGE_COLORS[1])
})

test('edge behaviour matches Studio: hard clamp above max, grey only far below min', () => {
  const range = decadeRange()
  assert.equal(rangeColorAt(range, 1000), GCODE_RANGE_COLORS[9], 'above max clamps to the last stop')
  // Within the 0.01 tolerance below min, Studio returns the FIRST stop, not grey.
  assert.equal(rangeColorAt(range, -0.005), GCODE_RANGE_COLORS[0])
  assert.equal(rangeColorAt(range, -5), GCODE_RANGE_OUT_OF_RANGE_COLOR, 'well below min is grey')
})

test('a range nothing ever sampled colours as the first stop rather than throwing', () => {
  const empty = emptyValueRange()
  assert.equal(hasRangeSamples(empty), false)
  assert.equal(rangeColorAt(empty, 42), GCODE_RANGE_COLORS[0])
  assert.deepEqual(rangeLegendRows(empty), [])
})

test('roundToBin keeps two digits of resolution below 0.095 and two decimals above', () => {
  // Ported from BaseRenderer.cpp:97-111. Note the C++ comment claiming "%.2g" equivalence is
  // wrong above ~0.095, and the CODE is what the legend must match.
  assert.equal(roundToBin(0.42), 0.42)
  assert.equal(roundToBin(0.2), 0.2)
  assert.equal(roundToBin(0.084), 0.084)
  assert.ok(Math.abs(roundToBin(0.0084) - 0.0084) < 1e-9)
  // Compared with a tolerance because the port keeps Studio's `round(v*scale) * invscale` shape,
  // and 12346 * 0.01 is 123.46000000000001 in binary floating point.
  assert.ok(Math.abs(roundToBin(123.456) - 123.46) < 1e-9,
    'above the top threshold it is two DECIMALS, not two significant figures')
})

test('the legend runs max-first and collapses when almost nothing varied', () => {
  const range = decadeRange()
  const rows = rangeLegendRows(range)
  assert.equal(rows.length, 10)
  assert.equal(rows[0]!.color, GCODE_RANGE_COLORS[9], 'top row is the maximum')
  assert.equal(rows[0]!.value, 90)
  assert.equal(rows[9]!.color, GCODE_RANGE_COLORS[0], 'bottom row is the minimum')
  assert.equal(rows[9]!.value, 0)

  // A plate printed at ONE temperature must not draw ten identical rows: Studio switches on its
  // sample counter, and so do we (BaseRenderer.cpp:1550-1570).
  const flat = emptyValueRange()
  updateValueRange(flat, 220)
  assert.equal(flat.count, 1)
  assert.deepEqual(rangeLegendRows(flat), [{ color: GCODE_RANGE_COLORS[0], value: 220 }])

  const twoEnded = emptyValueRange()
  updateValueRange(twoEnded, 200)
  updateValueRange(twoEnded, 260)
  assert.equal(rangeLegendRows(twoEnded).length, 2)
})

test('updateValueRange tracks the extent, and its counter ignores repeats of the ends', () => {
  const range = emptyValueRange()
  updateValueRange(range, 5)
  updateValueRange(range, 5)
  updateValueRange(range, 5)
  assert.deepEqual({ min: range.min, max: range.max }, { min: 5, max: 5 })
  assert.equal(range.count, 1, 'a repeat of the current min/max does not count')
  updateValueRange(range, 9)
  assert.equal(range.max, 9)
})

test('legend labels are evenly spaced across the range', () => {
  const range = emptyValueRange()
  updateValueRange(range, 1)
  updateValueRange(range, 10)
  updateValueRange(range, 1000)
  assert.ok(Math.abs(rangeValueAtStep(range, 0) - 1) < 1e-6)
  assert.ok(Math.abs(rangeValueAtStep(range, 9) - 1000) < 1e-6)
  assert.ok(Math.abs(rangeValueAtStep(range, 4.5) - 500.5) < 1e-6)
})

test('every offered mode has a metric except the categorical one, and none repeat', () => {
  const modes = GCODE_VIEW_MODES.map((entry) => entry.mode)
  assert.equal(new Set(modes).size, modes.length, 'mode ids are unique')
  const metrics = GCODE_VIEW_MODES.filter((entry) => entry.metric !== null).map((entry) => entry.metric)
  assert.equal(new Set(metrics).size, metrics.length, 'metrics are unique')
  assert.equal(gcodeViewModeMetric('feature'), null)
  assert.equal(gcodeViewModeMetric('flow'), 'volumetric')
  // Every range mode must state a unit in its legend title, or the number is unreadable.
  for (const entry of GCODE_VIEW_MODES) {
    if (entry.metric === null) continue
    assert.match(entry.legendTitle, /\(.+\)$/, `${entry.mode} legend title needs a unit`)
  }
})

test('an unknown stored preference is rejected and falls back to the feature view', () => {
  // The preference is persisted per device, so a build that drops a mode must not restore into it.
  assert.equal(isGcodeViewMode('speed'), true)
  assert.equal(isGcodeViewMode('layerTime'), false, 'a mode we do not offer is not accepted')
  assert.equal(isGcodeViewMode(undefined), false)
  assert.equal(gcodeViewModeInfo('layerTime' as never).mode, 'feature')
})
