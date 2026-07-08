import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import yazl from 'yazl'
import { copyThreeMfWithProjectSettings, ensureEmbeddedProjectSettings, hasEmbeddedProjectSettings } from './project-settings-fallback.js'
import { readZipEntryText } from './zip-io.js'

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

test('ensureEmbeddedProjectSettings is a no-op (no CLI) for a project that already embeds settings', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ps-fallback-'))
  try {
    const input = await writeThreeMf(dir, 'real.3mf', {
      '3D/3dmodel.model': '<model/>',
      'Metadata/project_settings.config': '{"from":"project"}'
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

test('ensureEmbeddedProjectSettings is a no-op when there are no --load-settings to synthesize from', async () => {
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
