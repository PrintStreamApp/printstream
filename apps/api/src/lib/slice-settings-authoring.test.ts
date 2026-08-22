process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { buildBuiltinSlicingPresetId, type SlicingTarget } from '@printstream/shared'
import yazl from 'yazl'
import { rootPrisma } from './prisma.js'
import { slicerClient } from './slicer-client.js'
import { authorSliceSettingsIntoProject } from './slice-settings-authoring.js'
import { readEntry } from './three-mf-internal.js'

const PROJECT_SETTINGS_ENTRY = 'Metadata/project_settings.config'

const originalResolveProcessConfig = slicerClient.resolveProcessConfig
const originalResolveFilamentConfig = slicerClient.resolveFilamentConfig
const originalSettingFindUnique = rootPrisma.setting.findUnique

afterEach(() => {
  slicerClient.resolveProcessConfig = originalResolveProcessConfig
  slicerClient.resolveFilamentConfig = originalResolveFilamentConfig
  rootPrisma.setting.findUnique = originalSettingFindUnique
})

test('the preserved project gains the process preset the slice ran with, plus its overrides', async () => {
  // The whole point of keeping the project: a slice hands the process preset to the CLI on the
  // command line and never writes it into the file, so an un-authored project reopens showing the
  // preset it happened to be saved with and silently drops the dialog's overrides.
  const dir = await mkdtemp(path.join(tmpdir(), 'authoring-process-'))
  try {
    const projectPath = path.join(dir, 'part.3mf')
    await writeProject(projectPath, {
      print_settings_id: '0.20mm Standard @BBL X1C',
      layer_height: '0.2',
      wall_loops: '2'
    })
    stubNoCustomPresets()
    slicerClient.resolveProcessConfig = (async () => ({
      name: '0.08mm Extra Fine @BBL X1C',
      layer_height: '0.08',
      wall_loops: '2'
    })) as typeof slicerClient.resolveProcessConfig

    const authoredPath = await authorSliceSettingsIntoProject({
      workspaceId: 'workspace-1',
      slicerTargetId: 'bambustudio-2-7-1',
      target: makeTarget({
        processProfileId: buildBuiltinSlicingPresetId('process', '0.08mm Extra Fine @BBL X1C'),
        processSettingOverrides: { wall_loops: '4' }
      }),
      projectPath,
      fileName: 'part.3mf'
    })

    assert.ok(authoredPath, 'expected an authored copy')
    const authored = await readProjectSettings(authoredPath)
    assert.equal(authored.print_settings_id, '0.08mm Extra Fine @BBL X1C', 'the preset the slice used')
    assert.equal(authored.layer_height, '0.08', 'and its values, not the project\'s old ones')
    assert.equal(authored.wall_loops, '4', 'with the dialog override on top of the preset')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the resolved preset wins over the project\'s declared changes, because the engine does too', async () => {
  // Established by A/B against the real engine: the same project sliced with and without this pass
  // produced identical G-code (`grid/5/monotonicline`) while the project declared
  // `3dhoneycomb/4/monotonic` — a process preset loaded on the command line overrides the project's
  // embedded process values outright. So restoring the project's deltas here would leave the kept
  // project describing a print that never happened, and they are inert on a re-slice anyway.
  const dir = await mkdtemp(path.join(tmpdir(), 'authoring-declared-'))
  try {
    const projectPath = path.join(dir, 'part.3mf')
    await writeProject(projectPath, {
      print_settings_id: '0.20mm Standard @BBL X1C',
      different_settings_to_system: ['wall_loops;sparse_infill_density'],
      wall_loops: '3',
      sparse_infill_density: '25%',
      layer_height: '0.2'
    })
    stubNoCustomPresets()
    slicerClient.resolveProcessConfig = (async () => ({
      name: '0.08mm Extra Fine @BBL X1C',
      layer_height: '0.08',
      wall_loops: '2',
      sparse_infill_density: '15%'
    })) as typeof slicerClient.resolveProcessConfig

    const authoredPath = await authorSliceSettingsIntoProject({
      workspaceId: 'workspace-1',
      slicerTargetId: 'bambustudio-2-7-1',
      target: makeTarget({
        processProfileId: buildBuiltinSlicingPresetId('process', '0.08mm Extra Fine @BBL X1C'),
        processSettingOverrides: { sparse_infill_density: '40%' }
      }),
      projectPath,
      fileName: 'part.3mf'
    })

    assert.ok(authoredPath, 'expected an authored copy')
    const authored = await readProjectSettings(authoredPath)
    assert.equal(authored.wall_loops, '2', 'a declared key still takes the preset\'s value, as the engine used')
    assert.equal(authored.sparse_infill_density, '40%', 'and a session override outranks the preset')
    assert.equal(authored.layer_height, '0.08', 'as do undeclared keys')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the preserved project binds each filament slot to the preset that slot was sliced with', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'authoring-filament-'))
  try {
    const projectPath = path.join(dir, 'part.3mf')
    await writeProject(projectPath, {
      filament_settings_id: ['Bambu PLA Basic @BBL X1C', 'Bambu PLA Basic @BBL X1C'],
      filament_colour: ['#FFFFFF', '#000000'],
      nozzle_temperature: ['220', '220']
    })
    stubNoCustomPresets()
    slicerClient.resolveFilamentConfig = (async (_target, profile) => (
      profile.name.includes('PETG')
        ? { name: profile.name, nozzle_temperature: '255' }
        : { name: profile.name, nozzle_temperature: '220' }
    )) as typeof slicerClient.resolveFilamentConfig

    const authoredPath = await authorSliceSettingsIntoProject({
      workspaceId: 'workspace-1',
      slicerTargetId: 'bambustudio-2-7-1',
      target: makeTarget({
        filamentMappings: [
          { projectFilamentId: 1, source: 'manual', profileId: buildBuiltinSlicingPresetId('filament', 'Bambu PETG HF @BBL X1C') },
          { projectFilamentId: 2, source: 'manual', profileId: buildBuiltinSlicingPresetId('filament', 'Bambu PLA Basic @BBL X1C') }
        ]
      }),
      projectPath,
      fileName: 'part.3mf'
    })

    assert.ok(authoredPath, 'expected an authored copy')
    const authored = await readProjectSettings(authoredPath)
    assert.deepEqual(
      authored.filament_settings_id,
      ['Bambu PETG HF @BBL X1C', 'Bambu PLA Basic @BBL X1C'],
      'slot 1 was sliced as PETG; only that slot rebinds'
    )
    // The slot's physics follow its preset, or the reopened project would print PETG at PLA temps.
    assert.deepEqual(authored.nozzle_temperature, ['255', '220'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a per-material override is recorded as a user change, not baked in silently', async () => {
  // `different_settings_to_system` is what makes an override reopen as the user's own edit with a
  // working reset, instead of looking like the preset's own value.
  const dir = await mkdtemp(path.join(tmpdir(), 'authoring-override-'))
  try {
    const projectPath = path.join(dir, 'part.3mf')
    await writeProject(projectPath, {
      filament_settings_id: ['Bambu PLA Basic @BBL X1C'],
      filament_colour: ['#FFFFFF'],
      filament_flow_ratio: ['0.98']
    })
    stubNoCustomPresets()
    slicerClient.resolveFilamentConfig = (async (_target, profile) => (
      { name: profile.name, filament_flow_ratio: '0.98' }
    )) as typeof slicerClient.resolveFilamentConfig

    const authoredPath = await authorSliceSettingsIntoProject({
      workspaceId: 'workspace-1',
      slicerTargetId: 'bambustudio-2-7-1',
      target: makeTarget({
        filamentMappings: [{
          projectFilamentId: 1,
          source: 'manual',
          profileId: buildBuiltinSlicingPresetId('filament', 'Bambu PLA Basic @BBL X1C'),
          settingOverrides: { filament_flow_ratio: '0.955' }
        }]
      }),
      projectPath,
      fileName: 'part.3mf'
    })

    assert.ok(authoredPath, 'expected an authored copy')
    const authored = await readProjectSettings(authoredPath)
    assert.deepEqual(authored.filament_flow_ratio, ['0.955'])
    const declared = authored.different_settings_to_system
    assert.ok(Array.isArray(declared), 'the override must be declared')
    assert.match(String(declared[1] ?? declared[0]), /filament_flow_ratio/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an unresolvable process preset leaves the project its own settings', async () => {
  // A `project:` preset has no file to resolve — the project's embedded settings ARE that preset,
  // so overwriting them with nothing would be strictly destructive.
  const dir = await mkdtemp(path.join(tmpdir(), 'authoring-project-preset-'))
  try {
    const projectPath = path.join(dir, 'part.3mf')
    await writeProject(projectPath, { print_settings_id: 'Custom For This Project', layer_height: '0.16' })
    stubNoCustomPresets()
    let resolveCalls = 0
    slicerClient.resolveProcessConfig = (async () => { resolveCalls += 1; return null }) as typeof slicerClient.resolveProcessConfig

    const authoredPath = await authorSliceSettingsIntoProject({
      workspaceId: 'workspace-1',
      slicerTargetId: 'bambustudio-2-7-1',
      target: makeTarget({ processProfileId: 'project:process:Custom For This Project' }),
      projectPath,
      fileName: 'part.3mf'
    })

    // Nothing changed, so nothing is written — the caller keeps the prepared bytes.
    assert.equal(authoredPath, null)
    assert.equal(resolveCalls, 0, 'a project preset is not even sent to the slicer')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the project records the Filament Track Switch machine it was sliced for', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'authoring-fts-'))
  try {
    stubNoCustomPresets()

    // Sliced for an FTS machine: the flag is written so the file states what it was made for.
    const withSwitch = path.join(dir, 'with.3mf')
    await writeProject(withSwitch, { layer_height: '0.2' })
    const authored = await authorSliceSettingsIntoProject({
      workspaceId: 'workspace-1',
      slicerTargetId: 'bambustudio-2-7-1',
      target: makeTarget({}),
      projectPath: withSwitch,
      fileName: 'with.3mf',
      hasFilamentTrackSwitch: true
    })
    assert.ok(authored)
    assert.equal((await readProjectSettings(authored)).has_filament_switcher, true)

    // Sliced WITHOUT one: nothing is written, because an absent key already means "no switch" to
    // BambuStudio's CLI. Writing `false` everywhere would rewrite every project on every slice.
    const withoutSwitch = path.join(dir, 'without.3mf')
    await writeProject(withoutSwitch, { layer_height: '0.2' })
    assert.equal(await authorSliceSettingsIntoProject({
      workspaceId: 'workspace-1',
      slicerTargetId: 'bambustudio-2-7-1',
      target: makeTarget({}),
      projectPath: withoutSwitch,
      fileName: 'without.3mf',
      hasFilamentTrackSwitch: false
    }), null)

    // A project carrying a STALE `true`, re-sliced for a machine without the switch, is corrected —
    // otherwise the file would keep claiming a machine it was not sliced for and be refused.
    const stale = path.join(dir, 'stale.3mf')
    await writeProject(stale, { layer_height: '0.2', has_filament_switcher: true })
    const cleared = await authorSliceSettingsIntoProject({
      workspaceId: 'workspace-1',
      slicerTargetId: 'bambustudio-2-7-1',
      target: makeTarget({}),
      projectPath: stale,
      fileName: 'stale.3mf',
      hasFilamentTrackSwitch: false
    })
    assert.ok(cleared)
    assert.equal('has_filament_switcher' in await readProjectSettings(cleared), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

function makeTarget(overrides: Partial<Extract<SlicingTarget, { mode: 'manualProfile' }>>): SlicingTarget {
  return {
    mode: 'manualProfile',
    printerProfileId: 'builtin:machine:Bambu Lab X1 Carbon 0.4 nozzle',
    printerModel: 'X1C',
    ...overrides
  } as SlicingTarget
}

/** No workspace custom presets, so every id resolves as a builtin (name only). */
function stubNoCustomPresets(): void {
  rootPrisma.setting.findUnique = (async () => null) as typeof rootPrisma.setting.findUnique
}

async function readProjectSettings(filePath: string): Promise<Record<string, unknown>> {
  const raw = await readEntry(filePath, PROJECT_SETTINGS_ENTRY)
  assert.ok(raw, 'expected project settings in the authored file')
  return JSON.parse(raw.toString('utf8')) as Record<string, unknown>
}

async function writeProject(filePath: string, settings: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const zip = new yazl.ZipFile()
    const output = createWriteStream(filePath)
    zip.outputStream.pipe(output)
    zip.outputStream.on('error', reject)
    output.on('error', reject)
    output.on('finish', () => resolve())
    zip.addBuffer(Buffer.from(JSON.stringify(settings), 'utf8'), PROJECT_SETTINGS_ENTRY)
    zip.addBuffer(Buffer.from('<model/>', 'utf8'), '3D/3dmodel.model')
    zip.end()
  })
}
