import assert from 'node:assert/strict'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import yazl from 'yazl'
import { readEntry } from './three-mf-internal.js'
import { repairProjectSettingsThreeMf } from './library-settings-repair.js'

const PROJECT_SETTINGS_ENTRY = 'Metadata/project_settings.config'

async function writeThreeMf(filePath: string, entries: Array<[string, Buffer]>): Promise<void> {
  const zip = new yazl.ZipFile()
  for (const [entryPath, buffer] of entries) zip.addBuffer(buffer, entryPath)
  await new Promise<void>((resolve, reject) => {
    zip.outputStream.pipe(createWriteStream(filePath)).on('close', resolve).on('error', reject)
    zip.end()
  })
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'printstream-settings-repair-test-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function readSettings(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse((await readEntry(filePath, PROJECT_SETTINGS_ENTRY)).toString('utf8')) as Record<string, unknown>
}

test('repairs a dual-nozzle project whose flush matrix is sized for one extruder', async () => {
  // The shape seen in the field: 1 filament, 2 extruders, a 1-entry matrix.
  // BambuStudio read the missing second block out of bounds and segfaulted at ~71%.
  await withTempDir(async (dir) => {
    const source = path.join(dir, 'source.3mf')
    const output = path.join(dir, 'repaired.3mf')
    await writeThreeMf(source, [
      ['3D/3dmodel.model', Buffer.from('<model/>', 'utf8')],
      [PROJECT_SETTINGS_ENTRY, Buffer.from(JSON.stringify({
        printer_model: 'Bambu Lab X2D',
        filament_colour: ['#F2754E'],
        nozzle_diameter: ['0.4', '0.4'],
        flush_volumes_matrix: ['0']
      }), 'utf8')]
    ])

    const result = await repairProjectSettingsThreeMf(source, output)
    assert.equal(result.repaired, true)
    assert.deepEqual(result.matrix, { before: 1, after: 2, filaments: 1, extruders: 2 })

    const settings = await readSettings(output)
    assert.deepEqual(settings.flush_volumes_matrix, ['0', '0'])
    // Everything else is carried through untouched — a repair must not re-author the project.
    assert.equal(settings.printer_model, 'Bambu Lab X2D')
    assert.deepEqual(settings.nozzle_diameter, ['0.4', '0.4'])
    // Other entries survive the rewrite.
    assert.equal((await readEntry(output, '3D/3dmodel.model')).toString('utf8'), '<model/>')
  })
})

test('leaves an already-consistent project alone and writes no output', async () => {
  await withTempDir(async (dir) => {
    const source = path.join(dir, 'source.3mf')
    const output = path.join(dir, 'repaired.3mf')
    await writeThreeMf(source, [[PROJECT_SETTINGS_ENTRY, Buffer.from(JSON.stringify({
      filament_colour: ['#F2754E'],
      nozzle_diameter: ['0.4'],
      flush_volumes_matrix: ['0']
    }), 'utf8')]])

    const result = await repairProjectSettingsThreeMf(source, output)
    assert.equal(result.repaired, false)
    // Callers persist only when `repaired` is true, so no file may be produced here.
    await assert.rejects(() => readEntry(output, PROJECT_SETTINGS_ENTRY))
  })
})

test('reports nothing to repair for a project with no embedded settings', async () => {
  // Geometry-only / settings-less 3MFs are unaffected by this defect; failing the user's
  // action for them would be wrong.
  await withTempDir(async (dir) => {
    const source = path.join(dir, 'source.3mf')
    await writeThreeMf(source, [['3D/3dmodel.model', Buffer.from('<model/>', 'utf8')]])
    const result = await repairProjectSettingsThreeMf(source, path.join(dir, 'out.3mf'))
    assert.equal(result.repaired, false)
    assert.equal(result.matrix, null)
  })
})
