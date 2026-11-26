/** Real filesystem cases for printer-service reloads after compiled dependency builds. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { scanServiceWatchRoots } from './service-watch-state.mjs'

/** Isolate every scan from the live dev stack and restore all temporary files. */
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'printstream-service-watch-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('compiler rewrites and declaration/test output do not reload unchanged runtime code', (t) => {
  const root = fixture(t)
  const file = path.join(root, 'index.js')
  writeFileSync(file, 'export const version = 1\n')
  const seeded = scanServiceWatchRoots([root])
  assert.equal(seeded.changedPath, null)
  writeFileSync(file, 'export const version = 1\n')
  utimesSync(file, new Date(), new Date(Date.now() + 1000))
  writeFileSync(path.join(root, 'index.d.ts'), 'export declare const version = 2\n')
  writeFileSync(path.join(root, 'index.test.js'), 'throw new Error("test only")\n')
  const scan = scanServiceWatchRoots([root], seeded.observations)
  assert.equal(scan.changedPath, null)
  assert.deepEqual([...scan.observations.keys()], [file])
})

test('runtime edits, additions and file deletion each trigger a reload', (t) => {
  const root = fixture(t)
  const file = path.join(root, 'index.js')
  writeFileSync(file, 'export const version = 1\n')
  let scan = scanServiceWatchRoots([root])
  writeFileSync(file, 'export const version = 2\n')
  scan = scanServiceWatchRoots([root], scan.observations)
  assert.equal(scan.changedPath, file)
  const added = path.join(root, 'new.json')
  writeFileSync(added, '{"enabled":true}')
  scan = scanServiceWatchRoots([root], scan.observations)
  assert.equal(scan.changedPath, added)
  rmSync(added)
  scan = scanServiceWatchRoots([root], scan.observations)
  assert.equal(scan.changedPath, added)
  assert.equal(scanServiceWatchRoots([root], scan.observations).changedPath, null)
})

test('dependency/fixture trees and missing roots do not create spurious reloads', (t) => {
  const root = fixture(t)
  const file = path.join(root, 'index.ts')
  writeFileSync(file, 'export const alive = true\n')
  const seeded = scanServiceWatchRoots([root])
  for (const name of ['node_modules', '__fixtures__', 'test-utils', '.cache']) {
    mkdirSync(path.join(root, name))
    writeFileSync(path.join(root, name, 'module.js'), 'fixture only')
  }
  assert.equal(scanServiceWatchRoots([root], seeded.observations).changedPath, null)
  rmSync(root, { recursive: true })
  const missing = scanServiceWatchRoots([root], seeded.observations)
  assert.equal(missing.changedPath, null)
  assert.equal(missing.observations.has(file), true)
})

test('an explicitly watched hidden config reloads on creation, edit and deletion', (t) => {
  const root = fixture(t)
  const config = path.join(root, '.env')
  let scan = scanServiceWatchRoots([root, config])
  assert.equal(scan.changedPath, null)

  writeFileSync(config, 'DEV_AUTH_ACCESS_KEY=first-test-value\n')
  scan = scanServiceWatchRoots([root, config], scan.observations)
  assert.equal(scan.changedPath, config)
  assert.equal(scan.observations.size, 1)
  assert.equal(scanServiceWatchRoots([root]).observations.has(config), false)

  writeFileSync(config, 'DEV_AUTH_ACCESS_KEY=second-test-value\n')
  scan = scanServiceWatchRoots([root, config], scan.observations)
  assert.equal(scan.changedPath, config)

  // Identical writes must not disrupt the API's printer connections.
  writeFileSync(config, 'DEV_AUTH_ACCESS_KEY=second-test-value\n')
  scan = scanServiceWatchRoots([root, config], scan.observations)
  assert.equal(scan.changedPath, null)

  rmSync(config)
  scan = scanServiceWatchRoots([root, config], scan.observations)
  assert.equal(scan.changedPath, config)
  assert.equal(scan.observations.has(config), false)
  assert.equal(scanServiceWatchRoots([root, config], scan.observations).changedPath, null)
})
