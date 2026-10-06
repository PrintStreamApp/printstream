import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { prepareInputThreeMf } from './slice-input-preparation.js'
import { readZipEntryText, writeZip } from './zip-io.js'

test('legacy input sanitizes stale nozzle groups in a rewritten project copy', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'printstream-input-prep-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  const inputPath = path.join(directory, 'input.3mf')
  const outputPath = path.join(directory, 'prepared.3mf')
  await writeZip(inputPath, [
    { name: 'Metadata/project_settings.config', buffer: Buffer.from('{"printer_model":"Generic"}') },
    { name: 'Metadata/slice_info.config', buffer: Buffer.from('<config><plate><filament id="1" group_id="0"/></plate></config>') }
  ])
  const outputLines: Array<{ stream: 'system' | 'stdout' | 'stderr'; text: string; createdAt: string }> = []

  const result = await prepareInputThreeMf({
    slicerTarget: { id: 'test', profileDir: directory } as never,
    inputPath,
    outputPath,
    request: {
      sourceFileId: 'source-1',
      target: { mode: 'manualProfile', printerModel: 'Generic', filamentMappings: [] },
      plate: 0
    } as never,
    profileFiles: [],
    stripEmbeddedProfileRefs: false,
    processSettingOverrides: {},
    outputLines
  })

  assert.equal(result.inputPath, outputPath)
  assert.equal(result.rewroteProjectSettings, true)
  assert.doesNotMatch(await readZipEntryText(outputPath, 'Metadata/slice_info.config'), /group_id/)
  assert.match(outputLines.map((line) => line.text).join('\n'), /Dropped a previous slice's nozzle groups/)
})
