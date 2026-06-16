process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { after, beforeEach, test } from 'node:test'

const testRoot = mkdtempSync(path.join(tmpdir(), 'bambu-library-paths-test-'))
process.env.LIBRARY_DIR = path.join(testRoot, 'library')
process.env.PUBLIC_DEMO_BRIDGE_LIBRARY_DIR = path.join(testRoot, 'demo-library')

const { libraryDir, locateLibraryFile, publicDemoLibraryDir, resolveLibraryPath } = await import('./library-paths.js')

after(async () => {
  await rm(testRoot, { recursive: true, force: true })
})

beforeEach(async () => {
  await rm(testRoot, { recursive: true, force: true })
  await mkdir(process.env.LIBRARY_DIR!, { recursive: true })
  await mkdir(process.env.PUBLIC_DEMO_BRIDGE_LIBRARY_DIR!, { recursive: true })
})

test('resolveLibraryPath joins relative stored paths under the library directory', () => {
  assert.equal(resolveLibraryPath('file.3mf'), path.join(libraryDir, 'file.3mf'))
})

test('locateLibraryFile falls back from a stale absolute path to the current library basename', async () => {
  const staleAbsolutePath = path.join(testRoot, 'old-root', 'file.3mf')
  const fallbackPath = path.join(libraryDir, 'file.3mf')
  await writeFile(fallbackPath, Buffer.from('3mf'))

  const located = await locateLibraryFile(staleAbsolutePath)
  assert.equal(located, fallbackPath)
})

test('locateLibraryFile falls back to the public demo library basename when the normal library file is missing', async () => {
  const storedPath = 'demo-file.3mf'
  const fallbackPath = path.join(publicDemoLibraryDir, storedPath)
  await writeFile(fallbackPath, Buffer.from('3mf'))

  const located = await locateLibraryFile(storedPath)
  assert.equal(located, fallbackPath)
})