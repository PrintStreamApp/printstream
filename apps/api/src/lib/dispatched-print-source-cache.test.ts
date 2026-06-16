process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { after, beforeEach, test } from 'node:test'

const testRoot = mkdtempSync(path.join(tmpdir(), 'bambu-dispatched-source-cache-test-'))
process.env.LIBRARY_DIR = path.join(testRoot, 'library')

const cacheFile = path.join(testRoot, 'dispatched-print-sources.json')
const localPrintPath = path.join(testRoot, 'library', 'cube.gcode.3mf')

after(async () => {
  await rm(testRoot, { recursive: true, force: true })
})

beforeEach(async () => {
  await rm(testRoot, { recursive: true, force: true })
  await mkdir(process.env.LIBRARY_DIR!, { recursive: true })
  await writeFile(localPrintPath, Buffer.from('3mf'))
})

test('registerDispatchedPrintSource survives a module reload', async () => {
  const firstModule = await loadModule('first')
  await firstModule.registerDispatchedPrintSource({
    printerId: 'printer-1',
    taskId: 'task-1',
    localPath: localPrintPath,
    sourceKind: '3mf'
  })

  const persisted = JSON.parse(await readFile(cacheFile, 'utf8')) as { entries: Array<{ localPath: string }> }
  assert.equal(persisted.entries.length, 1)
  assert.equal(persisted.entries[0]?.localPath, localPrintPath)

  const reloadedModule = await loadModule('second')
  const resolved = await reloadedModule.getDispatchedPrintSource('printer-1', 'task-1')

  assert.equal(resolved, localPrintPath)
})

test('getDispatchedPrintSource does not reuse a dispatched source when the tracked task id differs', async () => {
  const firstModule = await loadModule('archive-name-first')
  await firstModule.registerDispatchedPrintSource({
    printerId: 'printer-1',
    taskId: 'task-1',
    localPath: localPrintPath,
    sourceKind: '3mf'
  })

  const reloadedModule = await loadModule('archive-name-second')
  const resolved = await reloadedModule.getDispatchedPrintSource('printer-1', 'task-2')

  assert.equal(resolved, null)
})

test('getDispatchedPrintSource does not reuse a dispatched source when the task id is missing', async () => {
  const firstModule = await loadModule('missing-gcode-first')
  await firstModule.registerDispatchedPrintSource({
    printerId: 'printer-1',
    taskId: 'task-1',
    localPath: localPrintPath,
    sourceKind: '3mf'
  })

  const reloadedModule = await loadModule('missing-gcode-second')
  const resolved = await reloadedModule.getDispatchedPrintSource('printer-1', null)

  assert.equal(resolved, null)
})

test('getDispatchedPrintSource drops persisted entries when the local file is gone', async () => {
  const firstModule = await loadModule('stale-first')
  await firstModule.registerDispatchedPrintSource({
    printerId: 'printer-2',
    taskId: 'task-stale',
    localPath: localPrintPath,
    sourceKind: '3mf'
  })

  await rm(localPrintPath, { force: true })

  const reloadedModule = await loadModule('stale-second')
  const resolved = await reloadedModule.getDispatchedPrintSource('printer-2', 'task-stale')

  assert.equal(resolved, null)
  const persisted = JSON.parse(await readFile(cacheFile, 'utf8')) as { entries: unknown[] }
  assert.equal(persisted.entries.length, 0)
})

test('reassignDispatchedPrintSourceTask migrates the tracked source to the printer task id', async () => {
  const firstModule = await loadModule('reassign-first')
  await firstModule.registerDispatchedPrintSource({
    printerId: 'printer-3',
    taskId: 'dispatch-task',
    localPath: localPrintPath,
    sourceKind: '3mf'
  })

  await firstModule.reassignDispatchedPrintSourceTask('printer-3', 'dispatch-task', 'printer-task')

  assert.equal(await firstModule.getDispatchedPrintSource('printer-3', 'dispatch-task'), null)
  assert.equal(await firstModule.getDispatchedPrintSource('printer-3', 'printer-task'), localPrintPath)
})

test('assignPendingDispatchedPrintSourceTask binds a pending dispatched source once the printer task id is known', async () => {
  const firstModule = await loadModule('pending-bind-first')
  await firstModule.registerPendingDispatchedPrintSource({
    printerId: 'printer-4',
    jobId: 'job-4',
    localPath: localPrintPath,
    sourceKind: '3mf'
  })

  await firstModule.assignPendingDispatchedPrintSourceTask('printer-4', 'job-4', 'printer-task')

  assert.equal(await firstModule.getDispatchedPrintSource('printer-4', 'printer-task'), localPrintPath)
})

async function loadModule(suffix: string) {
  return await import(`./dispatched-print-source-cache.js?${suffix}=${Date.now()}`)
}