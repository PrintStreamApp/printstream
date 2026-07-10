import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import yazl from 'yazl'
import { copyThreeMfWithProjectSettings, ensureEmbeddedProjectSettings, hasCompleteEmbeddedProjectSettings, hasEmbeddedProjectSettings } from './project-settings-fallback.js'
import { readZipEntryText } from './zip-io.js'

// Carries all three cross-domain sentinel keys (machine/process/filament), like every genuine
// BambuStudio project or --export-settings merge.
const COMPLETE_SETTINGS_JSON = '{"from":"project","printable_area":["0x0"],"layer_height":"0.2","nozzle_temperature":["220"]}'

async function writeThreeMf(dir: string, name: string, entries: Record<string, string>): Promise<string> {
  const filePath = path.join(dir, name)
  const zip = new yazl.ZipFile()
  const output = createWriteStream(filePath)
  zip.outputStream.pipe(output)
  for (const [entryName, content] of Object.entries(entries)) zip.addBuffer(Buffer.from(content, 'utf8'), entryName)
  zip.end()
  await new Promise<void>((resolve, reject) => { output.on('close', () => resolve()); output.on('error', reject) })
  return filePath
}

test('copyThreeMfWithProjectSettings adds project_settings.config and preserves other entries', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ps-fallback-'))
  try {
    const input = await writeThreeMf(dir, 'in.3mf', {
      '3D/3dmodel.model': '<model/>',
      'Metadata/model_settings.config': '<config/>',
      'Metadata/custom_gcode_per_layer.xml': '<custom_gcodes_per_layer/>'
    })
    assert.equal(await hasEmbeddedProjectSettings(input), false)

    const output = path.join(dir, 'out.3mf')
    await copyThreeMfWithProjectSettings(input, output, '{"from":"project","name":"project_settings"}')

    assert.equal(await hasEmbeddedProjectSettings(output), true)
    assert.equal(await readZipEntryText(output, 'Metadata/project_settings.config'), '{"from":"project","name":"project_settings"}')
    // Other entries survive unchanged — the injected 3MF must still carry the model + custom gcode.
    assert.equal(await readZipEntryText(output, '3D/3dmodel.model'), '<model/>')
    assert.equal(await readZipEntryText(output, 'Metadata/custom_gcode_per_layer.xml'), '<custom_gcodes_per_layer/>')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('hasEmbeddedProjectSettings detects a present (non-empty) project_settings.config', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ps-fallback-'))
  try {
    const present = await writeThreeMf(dir, 'present.3mf', { 'Metadata/project_settings.config': '{"from":"project"}' })
    const empty = await writeThreeMf(dir, 'empty.3mf', { 'Metadata/project_settings.config': '   ' })
    assert.equal(await hasEmbeddedProjectSettings(present), true)
    assert.equal(await hasEmbeddedProjectSettings(empty), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ensureEmbeddedProjectSettings is a no-op (no CLI) for a project that embeds COMPLETE settings', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ps-fallback-'))
  try {
    const input = await writeThreeMf(dir, 'real.3mf', {
      '3D/3dmodel.model': '<model/>',
      'Metadata/project_settings.config': COMPLETE_SETTINGS_JSON
    })
    const result = await ensureEmbeddedProjectSettings({
      inputPath: input,
      cliPath: '/nonexistent/should-not-run',
      appDir: null,
      profileArgs: ['--load-settings', 'a.json;b.json', '--load-filaments', 'f.json'],
      workDir: dir,
      env: {},
      log: () => {}
    })
    // Same path back, and the CLI was never spawned (path is bogus) — proves normal slicing is untouched.
    assert.equal(result, input)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('hasCompleteEmbeddedProjectSettings distinguishes a full config from the partial one a scaffold save embeds', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ps-fallback-'))
  try {
    const complete = await writeThreeMf(dir, 'complete.3mf', { 'Metadata/project_settings.config': COMPLETE_SETTINGS_JSON })
    // What the editor's save path writes for a settings-less new project: filaments + plate type only.
    const partial = await writeThreeMf(dir, 'partial.3mf', {
      'Metadata/project_settings.config': '{"filament_colour":["#00AE42"],"filament_type":["PLA"],"curr_bed_type":"Textured PEI Plate"}'
    })
    const absent = await writeThreeMf(dir, 'absent.3mf', { '3D/3dmodel.model': '<model/>' })
    assert.equal(await hasCompleteEmbeddedProjectSettings(complete), true)
    assert.equal(await hasCompleteEmbeddedProjectSettings(partial), false)
    assert.equal(await hasCompleteEmbeddedProjectSettings(absent), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ensureEmbeddedProjectSettings completes a PARTIAL embedded config, overlaying its values on the export', async () => {
  // Regression: a new-project save embeds only the chosen filaments/plate type (and possibly a
  // retargeted machine). Embedding that as-is is as unsafe for the CLI's BBL-project loader as no
  // config at all, so the fallback must still synthesize — while keeping the project's values on top.
  const dir = await mkdtemp(path.join(tmpdir(), 'ps-fallback-'))
  try {
    // Stand-in for the CLI's --export-settings: writes a "genuine merged config" to the last arg.
    const fakeCli = path.join(dir, 'fake-cli.sh')
    await writeFile(
      fakeCli,
      '#!/bin/sh\nfor last; do :; done\nprintf %s \'{"printable_area":["0x0"],"layer_height":"0.2","nozzle_temperature":["220"],"curr_bed_type":"Cool Plate","filament_colour":["#FFFFFF"]}\' > "$last"\n',
      { mode: 0o755 }
    )
    const input = await writeThreeMf(dir, 'partial.3mf', {
      '3D/3dmodel.model': '<model/>',
      'Metadata/project_settings.config': '{"curr_bed_type":"Textured PEI Plate","filament_colour":["#00AE42"]}'
    })
    const result = await ensureEmbeddedProjectSettings({
      inputPath: input,
      cliPath: fakeCli,
      appDir: null,
      profileArgs: ['--load-settings', 'a.json;b.json'],
      workDir: dir,
      env: {},
      log: () => {}
    })
    assert.notEqual(result, input)
    const merged = JSON.parse(await readZipEntryText(result, 'Metadata/project_settings.config') ?? '{}') as Record<string, unknown>
    // Structural completeness from the export…
    assert.deepEqual(merged.printable_area, ['0x0'])
    assert.equal(merged.layer_height, '0.2')
    // …with the project's own choices winning where both define a key.
    assert.equal(merged.curr_bed_type, 'Textured PEI Plate')
    assert.deepEqual(merged.filament_colour, ['#00AE42'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ensureEmbeddedProjectSettings is a no-op when there are no --load-settings and nothing to derive them from', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ps-fallback-'))
  try {
    const input = await writeThreeMf(dir, 'noload.3mf', { '3D/3dmodel.model': '<model/>' })
    const result = await ensureEmbeddedProjectSettings({
      inputPath: input,
      cliPath: '/nonexistent/should-not-run',
      appDir: null,
      profileArgs: [],
      workDir: dir,
      env: {},
      log: () => {}
    })
    assert.equal(result, input)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ensureEmbeddedProjectSettings completes a project-preset slice (no load args) via the presets the settings name', async () => {
  // Regression for the deterministic exit-139: a slice using the PROJECT process preset loads no
  // external profiles, so the CLI reads the embedded settings bare — and a partial config (what a
  // pre-fix scaffold save embedded, or any incomplete third-party file) segfaults the loader at
  // "Start to load files". The fallback must derive its export args from the preset NAMES the
  // settings carry, resolved against the slicer's builtin catalog.
  const dir = await mkdtemp(path.join(tmpdir(), 'ps-fallback-'))
  try {
    const fakeCli = path.join(dir, 'fake-cli.sh')
    // Records its args so the test can assert which presets the export loaded.
    await writeFile(
      fakeCli,
      '#!/bin/sh\necho "$@" > "$(dirname "$0")/cli-args.txt"\nfor last; do :; done\nprintf %s \'{"printable_area":["0x0"],"layer_height":"0.2","nozzle_temperature":["220"]}\' > "$last"\n',
      { mode: 0o755 }
    )
    const profileDir = path.join(dir, 'profiles')
    const machineName = 'Bambu Lab P1S 0.4 nozzle'
    const processName = '0.20mm Standard @BBL X1C'
    const filamentName = 'Bambu PLA Basic @BBL P1S 0.4 nozzle'
    await mkdir(path.join(profileDir, 'machine_full'), { recursive: true })
    await mkdir(path.join(profileDir, 'process_full'), { recursive: true })
    await mkdir(path.join(profileDir, 'filament_full'), { recursive: true })
    await writeFile(path.join(profileDir, 'machine_full', `${machineName}.json`), '{"type":"machine"}')
    await writeFile(path.join(profileDir, 'process_full', `${processName}.json`), '{"type":"process"}')
    await writeFile(path.join(profileDir, 'filament_full', `${filamentName}.json`), '{"type":"filament"}')

    const input = await writeThreeMf(dir, 'partial-project-preset.3mf', {
      '3D/3dmodel.model': '<model/>',
      'Metadata/project_settings.config': JSON.stringify({
        printer_settings_id: machineName,
        print_settings_id: processName,
        filament_settings_id: [filamentName],
        curr_bed_type: 'Supertack Plate',
        filament_colour: ['#FFFFFF']
      })
    })
    const result = await ensureEmbeddedProjectSettings({
      inputPath: input,
      cliPath: fakeCli,
      appDir: null,
      profileArgs: [],
      profileDir,
      workDir: dir,
      env: {},
      log: () => {}
    })
    assert.notEqual(result, input)
    const merged = JSON.parse(await readZipEntryText(result, 'Metadata/project_settings.config') ?? '{}') as Record<string, unknown>
    assert.deepEqual(merged.printable_area, ['0x0'])
    assert.equal(merged.curr_bed_type, 'Supertack Plate')
    const cliArgs = await readFile(path.join(dir, 'cli-args.txt'), 'utf8')
    assert.match(cliArgs, /--load-settings/)
    assert.match(cliArgs, new RegExp(machineName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(cliArgs, /--load-filaments/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ensureEmbeddedProjectSettings falls back to Generic PLA when the named filament does not resolve', async () => {
  // The exact failing shape from the field: the pre-slice metadata rewrite stores filament
  // DISPLAY names ("Bambu PLA Basic") in filament_settings_id, which match no catalog file — and
  // an export with NO filament preset omits the per-filament override arrays
  // (filament_retraction_length, …), on which the bare loader still segfaults. The export args
  // must cover the filament domain via the Generic PLA fallback.
  const dir = await mkdtemp(path.join(tmpdir(), 'ps-fallback-'))
  try {
    const fakeCli = path.join(dir, 'fake-cli.sh')
    await writeFile(
      fakeCli,
      '#!/bin/sh\necho "$@" > "$(dirname "$0")/cli-args.txt"\nfor last; do :; done\nprintf %s \'{"printable_area":["0x0"],"layer_height":"0.2","nozzle_temperature":["220"]}\' > "$last"\n',
      { mode: 0o755 }
    )
    const profileDir = path.join(dir, 'profiles')
    await mkdir(path.join(profileDir, 'machine_full'), { recursive: true })
    await mkdir(path.join(profileDir, 'process_full'), { recursive: true })
    await mkdir(path.join(profileDir, 'filament_full'), { recursive: true })
    await writeFile(path.join(profileDir, 'machine_full', 'Bambu Lab P1S 0.4 nozzle.json'), '{"type":"machine"}')
    await writeFile(path.join(profileDir, 'process_full', '0.20mm Standard @BBL X1C.json'), '{"type":"process"}')
    await writeFile(path.join(profileDir, 'filament_full', 'Generic PLA.json'), '{"type":"filament"}')

    const input = await writeThreeMf(dir, 'display-name-filament.3mf', {
      '3D/3dmodel.model': '<model/>',
      'Metadata/project_settings.config': JSON.stringify({
        printer_settings_id: ['Bambu Lab P1S 0.4 nozzle'],
        print_settings_id: ['0.20mm Standard @BBL X1C'],
        filament_settings_id: ['Bambu PLA Basic'],
        filament_colour: ['#FFFFFF']
      })
    })
    const result = await ensureEmbeddedProjectSettings({
      inputPath: input,
      cliPath: fakeCli,
      appDir: null,
      profileArgs: [],
      profileDir,
      workDir: dir,
      env: {},
      log: () => {}
    })
    assert.notEqual(result, input)
    const cliArgs = await readFile(path.join(dir, 'cli-args.txt'), 'utf8')
    assert.match(cliArgs, /--load-filaments/)
    assert.match(cliArgs, /Generic PLA/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ensureEmbeddedProjectSettings slices as-is when a partial project-preset config names unknown presets', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ps-fallback-'))
  try {
    const profileDir = path.join(dir, 'profiles')
    const input = await writeThreeMf(dir, 'unknown-presets.3mf', {
      '3D/3dmodel.model': '<model/>',
      'Metadata/project_settings.config': '{"printer_settings_id":"My Custom Machine","filament_colour":["#FFFFFF"]}'
    })
    const result = await ensureEmbeddedProjectSettings({
      inputPath: input,
      cliPath: '/nonexistent/should-not-run',
      appDir: null,
      profileArgs: [],
      profileDir,
      workDir: dir,
      env: {},
      log: () => {}
    })
    assert.equal(result, input)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
