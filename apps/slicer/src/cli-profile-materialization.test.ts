import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { prepareProfileArgs } from './cli-profile-materialization.js'
import { writeZip } from './zip-io.js'

test('two slots sharing a preset get separate materialized files and tunes', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'printstream-profile-args-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  const profileDir = path.join(directory, 'catalogue')
  await mkdir(path.join(profileDir, 'filament_full'), { recursive: true })
  await writeFile(path.join(profileDir, 'filament_full', 'PLA.json'), JSON.stringify({ name: 'PLA' }))
  const inputPath = path.join(directory, 'input.3mf')
  await writeZip(inputPath, [{
    name: 'Metadata/project_settings.config',
    buffer: Buffer.from('{"filament_settings_id":["PLA","PLA"]}')
  }])

  const args = await prepareProfileArgs({
    profileFiles: [{ id: 'filament-pla', source: 'builtin', kind: 'filament', name: 'PLA' }],
    workDir: directory,
    profileDir,
    inputPath,
    filamentSlots: [
      { projectFilamentId: 1, profileId: 'filament-pla' },
      { projectFilamentId: 2, profileId: 'filament-pla' }
    ],
    perMaterialFilamentOverrides: {
      1: { nozzle_temperature: ['200'] },
      2: { nozzle_temperature: ['220'] }
    }
  })

  assert.equal(args[0], '--load-filaments')
  const paths = args[1]?.split(';') ?? []
  assert.equal(paths.length, 2)
  assert.notEqual(paths[0], paths[1])
  assert.deepEqual(JSON.parse(await readFile(paths[0] as string, 'utf8')).nozzle_temperature, ['200'])
  assert.deepEqual(JSON.parse(await readFile(paths[1] as string, 'utf8')).nozzle_temperature, ['220'])
})

test('prepared input skips request filament profiles before reading embedded settings', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'printstream-profile-args-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })

  const args = await prepareProfileArgs({
    profileFiles: [],
    workDir: directory,
    profileDir: directory,
    inputPath: path.join(directory, 'missing.3mf'),
    filamentSlots: [{ projectFilamentId: 1, profileId: null }],
    includeFilamentProfiles: false
  })

  assert.deepEqual(args, [])
})
