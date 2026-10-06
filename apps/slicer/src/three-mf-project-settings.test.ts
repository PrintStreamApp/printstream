import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { readThreeMfProjectSettings } from './three-mf-project-settings.js'
import { writeZip } from './zip-io.js'

test('embedded project settings distinguish a missing entry from valid settings', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'printstream-project-settings-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  const archivePath = path.join(directory, 'project.3mf')

  await writeZip(archivePath, [{ name: 'other.txt', buffer: Buffer.from('other') }])
  assert.equal(await readThreeMfProjectSettings(archivePath), null)

  await writeZip(archivePath, [{
    name: 'Metadata/project_settings.config',
    buffer: Buffer.from('{"filament_settings_id":["PLA"]}')
  }])
  assert.deepEqual(await readThreeMfProjectSettings(archivePath), { filament_settings_id: ['PLA'] })
})

test('malformed embedded settings reject instead of leaving a read pending', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'printstream-project-settings-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  const archivePath = path.join(directory, 'project.3mf')
  await writeZip(archivePath, [{ name: 'Metadata/project_settings.config', buffer: Buffer.from('[]') }])

  await assert.rejects(readThreeMfProjectSettings(archivePath), /must be a JSON object/)
})
