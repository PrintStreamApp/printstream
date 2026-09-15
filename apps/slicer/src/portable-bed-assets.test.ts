import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setPortableMachineBedAsset, type ProcessConfig } from '@printstream/shared'
import { materializePortableBedAssets } from './portable-bed-assets.js'

test('materializes portable model and texture bytes into an engine-facing config', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'printstream-bed-assets-'))
  try {
    const withModel = setPortableMachineBedAsset({}, 'model', {
      name: 'printer.stl',
      bytes: Uint8Array.from([0, 1, 255])
    })
    const config = setPortableMachineBedAsset(withModel, 'texture', {
      name: 'surface.SVG',
      bytes: new TextEncoder().encode('<svg/>')
    })

    const materialized = await materializePortableBedAssets(config, directory)
    assert.equal(materialized.printstream_bed_model_content, undefined)
    assert.equal(materialized.printstream_bed_texture_content, undefined)
    assert.deepEqual([...await readFile(materialized.bed_custom_model as string)], [0, 1, 255])
    assert.equal(await readFile(materialized.bed_custom_texture as string, 'utf8'), '<svg/>')
    assert.equal(path.extname(materialized.bed_custom_texture as string), '.svg')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('leaves a path-only BambuStudio preset unchanged', async () => {
  const config: ProcessConfig = { bed_custom_model: '/host/custom-bed.stl' }
  assert.deepEqual(await materializePortableBedAssets(config, os.tmpdir()), config)
})
