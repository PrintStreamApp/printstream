import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readBedModel } from './bed-model.js'

/**
 * Builds a miniature BambuStudio resource tree: a model-level profile that declares the bed,
 * plus the nozzle-variant and gcode-template profiles that sit beside it in the real tree and
 * declare no bed of their own.
 */
async function buildAppDir(): Promise<string> {
  const appDir = await mkdtemp(path.join(tmpdir(), 'bed-model-test-'))
  const bbl = path.join(appDir, 'resources', 'profiles', 'BBL')
  await mkdir(path.join(bbl, 'machine'), { recursive: true })
  await writeFile(path.join(bbl, 'machine', 'Bambu Lab H2D.json'), JSON.stringify({ bed_model: 'bbl-3dp-H2D.stl' }))
  // Sorts BEFORE the model-level profile alphabetically and matches the same canonical key.
  await writeFile(path.join(bbl, 'machine', 'Bambu Lab H2D 0.2 nozzle.json'), JSON.stringify({ printer_variant: '0.2' }))
  await writeFile(path.join(bbl, 'machine', 'Bambu Lab H2D 0.4 nozzle template layer_change_gcode.json'), JSON.stringify({}))
  await writeFile(path.join(bbl, 'bbl-3dp-H2D.stl'), 'solid bed')
  return appDir
}

test('resolves the bed mesh from BambuStudio\'s model name', async () => {
  const appDir = await buildAppDir()
  try {
    const result = await readBedModel(appDir, 'Bambu Lab H2D')
    assert.equal(result?.fileName, 'bbl-3dp-H2D.stl')
    assert.equal(result?.bytes.toString(), 'solid bed')
  } finally {
    await rm(appDir, { recursive: true, force: true })
  }
})

test('resolves from our canonical model key, skipping variant profiles that declare no bed', async () => {
  // Regression: the editor passes the canonical key (`H2D`), and the first name-matching profile
  // in that directory is a nozzle VARIANT ("… 0.2 nozzle.json") which carries no bed_model — so
  // matching on name alone silently resolved to nothing and the plate never rendered.
  const appDir = await buildAppDir()
  try {
    const result = await readBedModel(appDir, 'H2D')
    assert.equal(result?.fileName, 'bbl-3dp-H2D.stl')
  } finally {
    await rm(appDir, { recursive: true, force: true })
  }
})

test('returns null for an unknown printer, a missing mesh, and traversal attempts', async () => {
  const appDir = await buildAppDir()
  try {
    assert.equal(await readBedModel(appDir, 'NotAPrinter'), null)
    assert.equal(await readBedModel(appDir, '../../etc/passwd'), null)
    assert.equal(await readBedModel(null, 'Bambu Lab H2D'), null)
    assert.equal(await readBedModel(appDir, '   '), null)
  } finally {
    await rm(appDir, { recursive: true, force: true })
  }
})

test('ignores a bed_model value that is not a plain .stl basename', async () => {
  const appDir = await mkdtemp(path.join(tmpdir(), 'bed-model-test-'))
  try {
    const bbl = path.join(appDir, 'resources', 'profiles', 'BBL')
    await mkdir(path.join(bbl, 'machine'), { recursive: true })
    await writeFile(path.join(bbl, 'machine', 'Bambu Lab H2D.json'), JSON.stringify({ bed_model: '../../../etc/passwd' }))
    assert.equal(await readBedModel(appDir, 'Bambu Lab H2D'), null)
  } finally {
    await rm(appDir, { recursive: true, force: true })
  }
})
