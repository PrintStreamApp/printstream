import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { tryReadSlicingMetadata } from './slice-result-metadata.js'

test('CLI result metadata keeps plate positions and combines material usage across plates', async (t) => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'printstream-slice-result-'))
  t.after(async () => { await rm(workDir, { recursive: true, force: true }) })
  await writeFile(path.join(workDir, 'result.json'), JSON.stringify({
    prepare_time: 9000,
    sliced_plates: [
      {
        total_predication: 60.4,
        filaments: [{ id: 2, type: 'PLA', color: '#FFFFFF', total_used_g: 3, total_used_m: 1.2 }]
      },
      {
        filaments: [
          { filament_id: '2', total_used_g: 4, used_m: 0.3 },
          { id: 1, total_used_g: 1, total_used_m: 0.2 }
        ]
      }
    ]
  }))

  const metadata = await tryReadSlicingMetadata(workDir, 'output.gcode.3mf')
  assert.equal(metadata?.estimatedPrintTimeSeconds, 60)
  assert.equal(metadata?.estimatedFilamentWeightGrams, 8)
  assert.deepEqual(metadata?.plates, [
    { index: 1, estimatedPrintTimeSeconds: 60 },
    { index: 2 }
  ])
  assert.deepEqual(metadata?.materials?.map(({ id, weightGrams, lengthMm }) => ({ id, weightGrams, lengthMm })), [
    { id: 1, weightGrams: 1, lengthMm: 200 },
    { id: 2, weightGrams: 7, lengthMm: 1500 }
  ])
  assert.equal(metadata?.estimatedPrepareTimeSeconds, undefined)
})

test('CLI result metadata falls back to another JSON after an unrecognized expected file', async (t) => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'printstream-slice-result-'))
  t.after(async () => { await rm(workDir, { recursive: true, force: true }) })
  await writeFile(path.join(workDir, 'output.gcode.json'), '{}')
  await writeFile(path.join(workDir, 'result.json'), JSON.stringify({
    time_cost_str: '2h 3m 4s',
    length: 1250,
    weight: 6,
    money_cost_str: '$1.50'
  }))

  const metadata = await tryReadSlicingMetadata(workDir, 'output.gcode.3mf')
  assert.equal(metadata?.estimatedPrintTimeSeconds, 7384)
  assert.equal(metadata?.estimatedFilamentLengthMm, 1250)
  assert.equal(metadata?.estimatedFilamentWeightGrams, 6)
  assert.equal(metadata?.estimatedFilamentCost, 1.5)
})
