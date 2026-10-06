import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { extractGcodeFromPackagedOutput, normalizeCliOutput, normalizeOutputFileName } from './slice-output-files.js'
import { readZipEntryText, writeZip } from './zip-io.js'

test('normalizes an engine-named package and repairs its legacy project settings', async (t) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), 'printstream-slice-output-'))
  t.after(async () => { await rm(outputDir, { recursive: true, force: true }) })
  const enginePath = path.join(outputDir, 'engine.gcode.3mf')
  const outputPath = path.join(outputDir, 'chosen.gcode.3mf')
  await writeZip(enginePath, [
    { name: 'Metadata/project_settings.config', buffer: Buffer.from('{}') },
    { name: 'Metadata/plate_1.gcode', buffer: Buffer.from('G1 X1\n') }
  ])

  await normalizeCliOutput({
    outputDir,
    outputPath,
    outputFileName: 'chosen.gcode.3mf',
    metadata: {
      printerModel: null,
      printerProfileName: 'Bambu Lab A1 0.4 nozzle',
      processProfileName: null,
      filamentByProjectId: new Map()
    }
  })

  const projectSettings = JSON.parse(await readZipEntryText(outputPath, 'Metadata/project_settings.config')) as Record<string, unknown>
  assert.deepEqual(projectSettings.printer_settings_id, ['Bambu Lab A1 0.4 nozzle'])
  assert.equal(await readZipEntryText(outputPath, 'Metadata/plate_1.gcode'), 'G1 X1\n')
})

test('prepared output keeps embedded settings when no metadata rewrite is requested', async (t) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), 'printstream-slice-output-'))
  t.after(async () => { await rm(outputDir, { recursive: true, force: true }) })
  const outputPath = path.join(outputDir, 'prepared.gcode.3mf')
  await writeZip(path.join(outputDir, 'engine.gcode.3mf'), [
    { name: 'Metadata/project_settings.config', buffer: Buffer.from('{"printer_settings_id":["original"]}') }
  ])

  await normalizeCliOutput({ outputDir, outputPath, outputFileName: 'prepared.gcode.3mf', metadata: null })

  assert.equal(await readZipEntryText(outputPath, 'Metadata/project_settings.config'), '{"printer_settings_id":["original"]}')
})

test('ambiguous engine output is left for the caller to reject', async (t) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), 'printstream-slice-output-'))
  t.after(async () => { await rm(outputDir, { recursive: true, force: true }) })
  const outputPath = path.join(outputDir, 'chosen.gcode')
  await writeFile(path.join(outputDir, 'first.gcode'), 'G1 X1\n')
  await writeFile(path.join(outputDir, 'second.gcode'), 'G1 X2\n')

  await normalizeCliOutput({ outputDir, outputPath, outputFileName: 'chosen.gcode', metadata: null })

  assert.equal(await extractGcodeFromPackagedOutput(outputPath), false)
  assert.equal(await readFile(path.join(outputDir, 'first.gcode'), 'utf8'), 'G1 X1\n')
  assert.equal(await readFile(path.join(outputDir, 'second.gcode'), 'utf8'), 'G1 X2\n')
})

test('plain G-code extraction selects a package entry and preserves already plain output', async (t) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), 'printstream-slice-output-'))
  t.after(async () => { await rm(outputDir, { recursive: true, force: true }) })
  const outputPath = path.join(outputDir, 'chosen.gcode')
  await writeZip(outputPath, [
    { name: 'Metadata/plate_1.gcode', buffer: Buffer.from('G1 X2\n') },
    { name: 'Metadata/unrelated.txt', buffer: Buffer.from('keep') }
  ])

  assert.equal(await extractGcodeFromPackagedOutput(outputPath), true)
  assert.equal(await readFile(outputPath, 'utf8'), 'G1 X2\n')
  assert.equal(await extractGcodeFromPackagedOutput(outputPath), true)
  await writeFile(outputPath, 'G1 X3\n')
  assert.equal(await extractGcodeFromPackagedOutput(outputPath), true)
})

test('output name keeps readable punctuation while removing path and FAT-reserved characters', () => {
  assert.equal(normalizeOutputFileName('Mount (ABS).gcode.3mf'), 'Mount (ABS).gcode.3mf')
  assert.equal(normalizeOutputFileName('Mount/ABS?.3mf'), 'Mount_ABS_.gcode.3mf')
})
