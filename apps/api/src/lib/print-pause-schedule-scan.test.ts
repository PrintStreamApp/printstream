import assert from 'node:assert/strict'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import yazl from 'yazl'
import { readRecordedPrintPauseSchedule, scanDispatchedPrintPauseSchedule } from './print-pause-schedule-scan.js'

function plateGcode(options: { layers: number; pauseAtLayer: number | null }): string {
  const lines = [`; total layer number: ${options.layers}`, '; machine_pause_gcode = M400 U1', 'M73 P0 R60']
  for (let layer = 1; layer <= options.layers; layer++) {
    lines.push('; CHANGE_LAYER')
    if (layer === options.pauseAtLayer) lines.push('; PAUSE_PRINTING', 'M400 U1')
    lines.push(`M73 P${layer * 10} R${60 - layer * 6}`)
  }
  return lines.join('\n')
}

/** A `.gcode.3mf` with two sliced plates, so a scan has to pick the right one. */
async function createSlicedArchive(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'print-pause-scan-'))
  const filePath = path.join(dir, 'fixture.gcode.3mf')
  const zip = new yazl.ZipFile()

  zip.addBuffer(Buffer.from(plateGcode({ layers: 5, pauseAtLayer: null }), 'utf8'), 'Metadata/plate_1.gcode')
  zip.addBuffer(Buffer.from(plateGcode({ layers: 5, pauseAtLayer: 3 }), 'utf8'), 'Metadata/plate_2.gcode')

  await new Promise<void>((resolve, reject) => {
    zip.outputStream.pipe(createWriteStream(filePath)).on('close', resolve).on('error', reject)
    zip.end()
  })
  return filePath
}

test('scans the dispatched plate, not another plate in the same archive', async () => {
  const filePath = await createSlicedArchive()
  try {
    const schedule = await scanDispatchedPrintPauseSchedule({ localPath: filePath, plate: 2 })

    assert.equal(schedule?.source, 'slicedFile')
    assert.equal(schedule?.total, 1)
    assert.equal(schedule?.totalLayers, 5)
    assert.deepEqual(schedule?.points, [
      { index: 1, layer: 3, progressPercent: 20, remainingMinutes: 48 }
    ])
  } finally {
    await rm(path.dirname(filePath), { recursive: true, force: true })
  }
})

test('a plate with no pauses states that, rather than reading as unknown', async () => {
  const filePath = await createSlicedArchive()
  try {
    const schedule = await scanDispatchedPrintPauseSchedule({ localPath: filePath, plate: 1 })

    assert.notEqual(schedule, null)
    assert.deepEqual(schedule?.points, [])
    assert.equal(schedule?.total, 0)
  } finally {
    await rm(path.dirname(filePath), { recursive: true, force: true })
  }
})

test('a plate the archive does not contain reads as unknown, not as no pauses', async () => {
  const filePath = await createSlicedArchive()
  try {
    assert.equal(await scanDispatchedPrintPauseSchedule({ localPath: filePath, plate: 7 }), null)
    assert.equal(await scanDispatchedPrintPauseSchedule({ localPath: filePath, plate: null }), null)
  } finally {
    await rm(path.dirname(filePath), { recursive: true, force: true })
  }
})

test('readRecordedPrintPauseSchedule round-trips what the scan writes', async () => {
  const filePath = await createSlicedArchive()
  try {
    const scanned = await scanDispatchedPrintPauseSchedule({ localPath: filePath, plate: 2 })

    assert.deepEqual(readRecordedPrintPauseSchedule({ pauseScheduleJson: JSON.stringify(scanned) }), scanned)
  } finally {
    await rm(path.dirname(filePath), { recursive: true, force: true })
  }
})

test('readRecordedPrintPauseSchedule reports junk as unknown instead of throwing', () => {
  // A jobs listing must not fail over one unreadable row.
  assert.equal(readRecordedPrintPauseSchedule({ pauseScheduleJson: 'not json' }), null)
  assert.equal(readRecordedPrintPauseSchedule({ pauseScheduleJson: '{"total":1}' }), null)
  assert.equal(readRecordedPrintPauseSchedule({ pauseScheduleJson: null }), null)
  assert.equal(readRecordedPrintPauseSchedule({}), null)
})
