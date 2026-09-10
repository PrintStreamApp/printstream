import assert from 'node:assert/strict'
import test from 'node:test'
import { createGcodePauseScanner, scanGcodePauseSchedule, toPrintPauseSchedule } from './gcode-pause-schedule.js'

/**
 * A miniature of what BambuStudio emits: a config block that mentions the pause command, then
 * layers each opened by the engine's reserved tag, with `M73` progress interleaved.
 */
function buildGcode(options: {
  layers: number
  pauseAtLayers: number[]
  totalLayerHeader?: boolean
}): string {
  const lines: string[] = [
    '; HEADER_BLOCK_START',
    '; BambuStudio 02.06.00.51',
    ...(options.totalLayerHeader === false ? [] : [`; total layer number: ${options.layers}`]),
    '; HEADER_BLOCK_END',
    '; CONFIG_BLOCK_START',
    // The trap this scanner exists to survive: the pause command and the reserved tag spelled out
    // inside single-line config values.
    '; machine_pause_gcode = M400 U1',
    '; layer_change_gcode = ; CHANGE_LAYER\\nM73 L{layer_num}',
    '; template_custom_gcode = ; PAUSE_PRINTING',
    '; CONFIG_BLOCK_END',
    'M73 P0 R100'
  ]
  for (let layer = 1; layer <= options.layers; layer++) {
    lines.push('; CHANGE_LAYER')
    lines.push(`; Z_HEIGHT: ${(layer * 0.2).toFixed(1)}`)
    lines.push(`M73 L${layer}`)
    if (options.pauseAtLayers.includes(layer)) {
      lines.push('; PAUSE_PRINTING')
      lines.push('M400 U1')
    }
    // Progress advances non-linearly against the layer index, exactly as a real file does.
    const percent = Math.min(100, Math.round((layer / options.layers) ** 0.5 * 100))
    lines.push(`M73 P${percent} R${100 - percent}`)
    lines.push('G1 X10 Y10 E1')
  }
  return lines.join('\n')
}

test('records a pause at the layer the engine emitted it on', () => {
  const result = scanGcodePauseSchedule(buildGcode({ layers: 10, pauseAtLayers: [4] }))

  assert.equal(result.points.length, 1)
  assert.equal(result.points[0]!.layer, 4)
  assert.equal(result.points[0]!.index, 1)
  assert.equal(result.totalLayers, 10)
})

test('takes the tick position from the M73 P in force, not from layer / totalLayers', () => {
  const result = scanGcodePauseSchedule(buildGcode({ layers: 10, pauseAtLayers: [4] }))

  // The pause is emitted just after layer 4 opens, so the progress in force is the last value
  // layer 3 reported: 55%. Layer 4 of 10 would be 40% on a layer-linear scale, and that 15-point
  // gap is the whole reason the percent is carried rather than derived.
  const point = result.points[0]!
  assert.equal(point.progressPercent, 55)
  assert.notEqual(point.progressPercent, 40)
  assert.equal(point.remainingMinutes, 45)
})

test('ignores the pause command and reserved tags quoted inside the config block', () => {
  // Nothing but the config block: a substring match would report pauses at layer 0.
  const configOnly = [
    '; total layer number: 5',
    '; machine_pause_gcode = M400 U1',
    '; template_custom_gcode = ; PAUSE_PRINTING',
    '; some_other_gcode = ; CHANGE_LAYER'
  ].join('\n')

  const result = scanGcodePauseSchedule(configOnly)

  assert.deepEqual(result.points, [])
})

test('numbers several pauses in print order', () => {
  const result = scanGcodePauseSchedule(buildGcode({ layers: 20, pauseAtLayers: [3, 11, 17] }))

  assert.deepEqual(result.points.map((point) => point.index), [1, 2, 3])
  assert.deepEqual(result.points.map((point) => point.layer), [3, 11, 17])
})

test('produces the same result however the stream is chunked', () => {
  const gcode = buildGcode({ layers: 12, pauseAtLayers: [2, 9] })
  const whole = scanGcodePauseSchedule(gcode)

  // One byte at a time: every line boundary lands mid-chunk.
  const scanner = createGcodePauseScanner()
  for (const character of gcode) scanner.push(character)
  const chunked = scanner.finish()

  assert.deepEqual(chunked, whole)
})

test('handles a file whose last line carries no trailing newline', () => {
  const gcode = `${buildGcode({ layers: 3, pauseAtLayers: [2] })}\n; CHANGE_LAYER`
  const result = scanGcodePauseSchedule(gcode)

  assert.equal(result.points.length, 1)
  assert.equal(result.points[0]!.layer, 2)
})

test('drops a pause emitted before any layer or any progress', () => {
  const result = scanGcodePauseSchedule(['; total layer number: 4', '; PAUSE_PRINTING'].join('\n'))

  assert.deepEqual(result.points, [])
})

test('reports a missing total layer header as unknown rather than zero', () => {
  const result = scanGcodePauseSchedule(
    buildGcode({ layers: 6, pauseAtLayers: [2], totalLayerHeader: false })
  )

  assert.equal(result.totalLayers, null)
  assert.equal(result.points.length, 1)
})

test('caps a pathological file at the plate pause limit but keeps the denominator true', () => {
  const pauseAtLayers = Array.from({ length: 80 }, (_, index) => index + 1)
  const result = scanGcodePauseSchedule(buildGcode({ layers: 80, pauseAtLayers }))

  assert.equal(result.points.length, 64)
  assert.equal(result.points.at(-1)!.index, 64)
  // Capping the kept points must not cap the count: "pause 64 of 64" with sixteen still to come
  // is a lie the user would act on.
  assert.equal(result.totalPauses, 80)
  assert.equal(toPrintPauseSchedule(result).total, 80)
})

test('a run with no newline cannot grow the line buffer without bound', () => {
  // A binary, CR-only or crafted entry has no `\n` at all; buffering it whole is exactly the
  // hundreds of megabytes the streaming design exists to avoid.
  const scanner = createGcodePauseScanner()
  for (let chunk = 0; chunk < 40; chunk++) scanner.push('x'.repeat(16 * 1024))
  const result = scanner.finish()

  assert.deepEqual(result.points, [])
  assert.equal(result.totalLayers, null)
})

test('a scan that found nothing still states that the plate has no pauses', () => {
  const schedule = toPrintPauseSchedule(scanGcodePauseSchedule(buildGcode({ layers: 5, pauseAtLayers: [] })))

  assert.deepEqual(schedule, { total: 0, points: [], totalLayers: 5, source: 'slicedFile' })
})
