/**
 * What the prune must remove, and what it must never touch.
 *
 * The risk here is not "did it delete the .pdb" -- it is deleting something the
 * slicer loads at runtime and only finding out on a slice. So the negative
 * cases carry the weight: real payload, and near-misses like a directory whose
 * NAME ends in `.map` or a file called `map.json`.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pruneDebugFiles } from './prune-debug-files.js'

async function buildTree(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'prune-'))
  await mkdir(path.join(root, 'resources', 'profiles'), { recursive: true })
  await mkdir(path.join(root, 'assets.map'), { recursive: true })

  // Debug artifacts, including one nested and one upper-cased.
  await writeFile(path.join(root, 'BambuStudio.pdb'), 'x'.repeat(2048))
  await writeFile(path.join(root, 'bambu_networking.PDB'), 'x'.repeat(512))
  await writeFile(path.join(root, 'resources', 'ckeditor5.js.map'), 'x'.repeat(256))

  // Payload that must survive.
  await writeFile(path.join(root, 'bambu-studio.exe'), 'x'.repeat(64))
  await writeFile(path.join(root, 'BambuStudio.dll'), 'x'.repeat(64))
  await writeFile(path.join(root, 'resources', 'profiles', 'BBL.json'), '{}')
  await writeFile(path.join(root, 'map.json'), '{}')
  await writeFile(path.join(root, 'assets.map', 'keep.dll'), 'x'.repeat(32))
  return root
}

test('pruneDebugFiles removes debug symbols and source maps, and reports the saving', async () => {
  const root = await buildTree()
  try {
    const result = await pruneDebugFiles(root)

    assert.equal(result.files, 3, 'both .pdb files and the .js.map should go')
    assert.equal(result.bytes, 2048 + 512 + 256, 'reported saving must be the real byte count')

    assert.equal(existsSync(path.join(root, 'BambuStudio.pdb')), false)
    assert.equal(existsSync(path.join(root, 'bambu_networking.PDB')), false, 'extension match is case-insensitive')
    assert.equal(existsSync(path.join(root, 'resources', 'ckeditor5.js.map')), false, 'nested files are reached')

    // The whole point: the engine must still be able to slice.
    for (const kept of [
      'bambu-studio.exe',
      'BambuStudio.dll',
      path.join('resources', 'profiles', 'BBL.json'),
      'map.json',
      path.join('assets.map', 'keep.dll')
    ]) {
      assert.ok(existsSync(path.join(root, kept)), `${kept} must survive the prune`)
    }

    // A directory named *.map is not a file and must not be removed.
    assert.deepEqual((await readdir(path.join(root, 'assets.map'))), ['keep.dll'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pruneDebugFiles is best-effort on a directory that is not there', async () => {
  // A failed unpack must not turn into a failed install via this path.
  const result = await pruneDebugFiles(path.join(tmpdir(), 'prune-does-not-exist-12345'))
  assert.deepEqual(result, { files: 0, bytes: 0 })
})
