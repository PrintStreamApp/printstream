import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { rewriteThreeMfProjectSettings } from './three-mf-project-rewrite.js'
import { readZipEntryText, writeZip } from './zip-io.js'

test('input rewrite changes selected entries and keeps unrelated bytes', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'printstream-project-rewrite-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  const sourcePath = path.join(directory, 'source.3mf')
  const outputPath = path.join(directory, 'prepared.3mf')
  await writeZip(sourcePath, [
    { name: 'Metadata/project_settings.config', buffer: Buffer.from('{"printer_settings_id":["old"]}') },
    { name: 'Metadata/slice_info.config', buffer: Buffer.from('<config>old</config>') },
    { name: 'Metadata/plate_1.png', buffer: Buffer.from('stale') },
    { name: 'Metadata/keep.bin', buffer: Buffer.from([0, 1, 2, 3]) }
  ])

  const foundSettings = await rewriteThreeMfProjectSettings(sourcePath, outputPath, (settings) => ({
    ...settings,
    printer_settings_id: ['new']
  }), {
    sliceInfoTransform: (xml) => xml.replace('old', 'new'),
    omitEntry: (name) => name === 'Metadata/plate_1.png'
  })

  assert.equal(foundSettings, true)
  assert.deepEqual(JSON.parse(await readZipEntryText(outputPath, 'Metadata/project_settings.config')), {
    printer_settings_id: ['new']
  })
  assert.equal(await readZipEntryText(outputPath, 'Metadata/slice_info.config'), '<config>new</config>')
  assert.equal(await readZipEntryText(outputPath, 'Metadata/keep.bin'), '\u0000\u0001\u0002\u0003')
  await assert.rejects(readZipEntryText(outputPath, 'Metadata/plate_1.png'), /Entry not found/)
})

test('input rewrite rejects malformed settings and asynchronous transform failures', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'printstream-project-rewrite-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  const sourcePath = path.join(directory, 'source.3mf')
  const outputPath = path.join(directory, 'prepared.3mf')
  await writeZip(sourcePath, [{ name: 'Metadata/project_settings.config', buffer: Buffer.from('[]') }])
  await assert.rejects(
    rewriteThreeMfProjectSettings(sourcePath, outputPath, (settings) => settings),
    /must be a JSON object/
  )

  await writeZip(sourcePath, [{ name: 'Metadata/project_settings.config', buffer: Buffer.from('{}') }])
  await assert.rejects(
    rewriteThreeMfProjectSettings(sourcePath, outputPath, async () => { throw new Error('transform failed') }),
    /transform failed/
  )
})
