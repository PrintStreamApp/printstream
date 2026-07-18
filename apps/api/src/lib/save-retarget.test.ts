/**
 * Save-side dual-nozzle machine heal (`healSavedProjectMachineTopology`): a damaged H2-family
 * project (extruder-indexed machine arrays stripped by an old filament rewrite) is re-authored
 * from its own machine preset on the next save; intact or non-H2 projects are left alone.
 */
import assert from 'node:assert/strict'
import { test, afterEach } from 'node:test'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import yazl from 'yazl'
import type { SceneEditFilament } from '@printstream/shared'
import { healSavedProjectMachineTopology } from './save-retarget.js'
import { slicerClient } from './slicer-client.js'
import { readEntry } from './three-mf-internal.js'

const originalResolveMachineConfig = slicerClient.resolveMachineConfig.bind(slicerClient)
const cleanupDirs: string[] = []

afterEach(async () => {
  slicerClient.resolveMachineConfig = originalResolveMachineConfig
  for (const dir of cleanupDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

async function writeThreeMf(entries: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'save-retarget-test-'))
  cleanupDirs.push(dir)
  const filePath = path.join(dir, 'project.3mf')
  const zip = new yazl.ZipFile()
  const output = createWriteStream(filePath)
  zip.outputStream.pipe(output)
  for (const [entryName, content] of Object.entries(entries)) zip.addBuffer(Buffer.from(content, 'utf8'), entryName)
  zip.end()
  await new Promise<void>((resolve, reject) => { output.on('close', () => resolve()); output.on('error', reject) })
  return filePath
}

/** The resolved H2D machine preset the stubbed slicer returns (dual-nozzle shape included). */
const H2D_MACHINE_CONFIG: Record<string, string | string[]> = {
  printer_model: 'Bambu Lab H2D',
  nozzle_diameter: ['0.4', '0.4'],
  physical_extruder_map: ['1', '0'],
  extruder_type: ['Direct Drive', 'Direct Drive'],
  extruder_variant_list: ['Direct Drive Standard,Direct Drive High Flow', 'Direct Drive Standard,Direct Drive High Flow'],
  extruder_max_nozzle_count: ['1', '1'],
  default_nozzle_volume_type: ['Standard', 'Standard'],
  printable_area: ['0x0', '350x0', '350x320', '0x320']
}

// The incident shape: printer_model says H2D but every extruder-indexed machine array is gone.
const DAMAGED_H2D_SETTINGS = {
  printer_settings_id: 'Bambu Lab H2D 0.4 nozzle',
  printer_model: 'Bambu Lab H2D',
  filament_colour: ['#001489', '#FFFFFF'],
  filament_type: ['PETG', 'ABS-S'],
  filament_settings_id: ['Bambu PETG Basic @BBL H2D 0.4 nozzle', 'Bambu Support for ABS @BBL H2D'],
  filament_nozzle_map: ['0', '0'],
  printable_area: ['0x0', '350x0', '350x320', '0x320']
}

test('heals a damaged H2D project: re-authors the machine block and re-applies the nozzle assignment', async () => {
  slicerClient.resolveMachineConfig = (async (_targetId, profile) => {
    assert.equal(profile.name, 'Bambu Lab H2D 0.4 nozzle')
    return H2D_MACHINE_CONFIG
  }) as typeof slicerClient.resolveMachineConfig
  const arrangedPath = await writeThreeMf({
    '3D/3dmodel.model': '<model/>',
    'Metadata/project_settings.config': JSON.stringify(DAMAGED_H2D_SETTINGS)
  })
  // The edit assigns slot 0 to the LEFT nozzle (1) and slot 1 to the RIGHT (0).
  const filaments: SceneEditFilament[] = [
    { color: '#001489', sourceIndex: 0, type: 'PETG', settingsId: null, nozzleId: 1 },
    { color: '#FFFFFF', sourceIndex: 1, type: 'ABS-S', settingsId: null, nozzleId: 0 }
  ]

  const healedPath = await healSavedProjectMachineTopology({
    tenantId: 'tenant-1',
    arrangedPath,
    fileName: 'project.3mf',
    slicerTargetId: null,
    filaments
  })
  assert.ok(healedPath)
  cleanupDirs.push(path.dirname(healedPath))
  const healed = JSON.parse((await readEntry(healedPath, 'Metadata/project_settings.config')).toString('utf8')) as Record<string, unknown>

  // Machine topology restored from the preset…
  assert.deepEqual(healed.physical_extruder_map, ['1', '0'])
  assert.deepEqual(healed.nozzle_diameter, ['0.4', '0.4'])
  assert.deepEqual(healed.extruder_type, ['Direct Drive', 'Direct Drive'])
  // …the filament identity untouched…
  assert.deepEqual(healed.filament_settings_id, DAMAGED_H2D_SETTINGS.filament_settings_id)
  // …and the edit's L/R nozzle choice applied ON TOP of the retarget's default map (which the
  // heal would otherwise leave as the machine default — the exact "my nozzle pick doesn't save"
  // symptom).
  assert.deepEqual(healed.filament_nozzle_map, ['1', '0'])
})

test('returns null for an intact H2D project and for non-H2 machines', async () => {
  slicerClient.resolveMachineConfig = (async () => {
    throw new Error('must not be called')
  }) as typeof slicerClient.resolveMachineConfig

  const intactPath = await writeThreeMf({
    'Metadata/project_settings.config': JSON.stringify({
      ...DAMAGED_H2D_SETTINGS,
      physical_extruder_map: ['1', '0'],
      extruder_nozzle_stats: ['Standard#1', 'Standard#1'],
      extruder_max_nozzle_count: ['1', '1'],
      default_nozzle_volume_type: ['Standard', 'Standard']
    })
  })
  assert.equal(await healSavedProjectMachineTopology({
    tenantId: 'tenant-1', arrangedPath: intactPath, fileName: 'a.3mf', slicerTargetId: null, filaments: null
  }), null)

  const p1sPath = await writeThreeMf({
    'Metadata/project_settings.config': JSON.stringify({
      printer_settings_id: 'Bambu Lab P1S 0.4 nozzle',
      printer_model: 'Bambu Lab P1S',
      filament_colour: ['#FFFFFF']
    })
  })
  assert.equal(await healSavedProjectMachineTopology({
    tenantId: 'tenant-1', arrangedPath: p1sPath, fileName: 'b.3mf', slicerTargetId: null, filaments: null
  }), null)
})

test('returns null (never throws) when the machine preset cannot be resolved', async () => {
  slicerClient.resolveMachineConfig = (async () => null) as typeof slicerClient.resolveMachineConfig
  const arrangedPath = await writeThreeMf({
    'Metadata/project_settings.config': JSON.stringify(DAMAGED_H2D_SETTINGS)
  })
  assert.equal(await healSavedProjectMachineTopology({
    tenantId: 'tenant-1', arrangedPath, fileName: 'c.3mf', slicerTargetId: null, filaments: null
  }), null)
})
