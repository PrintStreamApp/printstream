import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { prepareSlicedResult, SliceOutputLimitError } from './slice-result-preparation.js'

test('completed plain G-code is measured after output normalization', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'printstream-slice-result-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  const outputPath = path.join(directory, 'requested.gcode')
  const producedPath = path.join(directory, 'engine.gcode')
  const content = '; printable output\nG1 X10\n'
  await writeFile(producedPath, content)

  const result = await prepareSlicedResult({
    outputPath,
    outputDir: directory,
    outputFileName: 'requested.gcode',
    originalInputPath: path.join(directory, 'input.3mf'),
    retractionCalibration: false,
    metadata: null,
    maxOutputBytes: Buffer.byteLength(content)
  })

  assert.equal(result.size, Buffer.byteLength(content))
  assert.equal(result.metadata, undefined)
})

test('final G-code size is enforced after output normalization', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'printstream-slice-result-limit-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  await writeFile(path.join(directory, 'engine.gcode'), 'G1 X10\n')

  await assert.rejects(
    prepareSlicedResult({
      outputPath: path.join(directory, 'requested.gcode'),
      outputDir: directory,
      outputFileName: 'requested.gcode',
      originalInputPath: path.join(directory, 'input.3mf'),
      retractionCalibration: false,
      metadata: null,
      maxOutputBytes: 1
    }),
    SliceOutputLimitError
  )
})
