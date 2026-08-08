process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import express from 'express'
import { PrinterEventBus } from '../../lib/printer-events.js'
import { printerManager } from '../../lib/printer-manager.js'
import { rootPrisma } from '../../lib/prisma.js'
import { plateClearingPlugin } from './index.js'

const originalPrinterFindMany = rootPrisma.printer.findMany

afterEach(() => {
  mock.restoreAll()
  Object.defineProperty(rootPrisma.printer, 'findMany', { value: originalPrinterFindMany, configurable: true })
})

test('plate-clearing does not mark the plate cleared when a print starts', async () => {
  const { events, settings } = await registerPlateClearingPlugin({
    ['cleared:printer-1']: 'false'
  })

  mock.method(printerManager, 'getWorkspaceId', () => 'workspace-1')

  events.emit('job.started', {
    printer: { id: 'printer-1' },
    jobName: 'Cube'
  } as never)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(settings.get('cleared:printer-1'), 'false')
})

test('plate-clearing marks the plate uncleared when a print finishes successfully', async () => {
  const { events, settings } = await registerPlateClearingPlugin({
    ['cleared:printer-1']: 'true'
  })

  mock.method(printerManager, 'getWorkspaceId', () => 'workspace-1')

  events.emit('job.finished', {
    printer: { id: 'printer-1' },
    jobName: 'Cube',
    result: 'success'
  } as never)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(settings.get('cleared:printer-1'), 'false')
})

test('plate-clearing marks the plate uncleared when a print is cancelled', async () => {
  const { events, settings } = await registerPlateClearingPlugin({
    ['cleared:printer-1']: 'true'
  })

  mock.method(printerManager, 'getWorkspaceId', () => 'workspace-1')

  events.emit('job.finished', {
    printer: { id: 'printer-1' },
    jobName: 'Cube',
    result: 'cancelled'
  } as never)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(settings.get('cleared:printer-1'), 'false')
})

test('plate-clearing marks the plate uncleared when a print fails', async () => {
  const { events, settings } = await registerPlateClearingPlugin({
    ['cleared:printer-1']: 'true'
  })

  mock.method(printerManager, 'getWorkspaceId', () => 'workspace-1')

  events.emit('job.finished', {
    printer: { id: 'printer-1' },
    jobName: 'Cube',
    result: 'failed'
  } as never)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(settings.get('cleared:printer-1'), 'false')
})

async function registerPlateClearingPlugin(initialSettings: Record<string, string>) {
  // The plugin stores all state per-workspace via `forWorkspace`; printer-1 is workspace-1.
  const workspace1 = new Map(Object.entries(initialSettings))
  const workspaceSettings = new Map<string, Map<string, string>>([['workspace-1', workspace1]])
  const events = new PrinterEventBus()

  const makeStore = (map: Map<string, string>) => ({
    async get(key: string) { return map.get(key) ?? null },
    async set(key: string, value: string) { map.set(key, value) },
    async delete(key: string) { map.delete(key) },
    forWorkspace() { throw new Error('nested forWorkspace not supported') }
  })

  Object.defineProperty(rootPrisma.printer, 'findMany', {
    value: async () => [{ id: 'printer-1', workspaceId: 'workspace-1' }],
    configurable: true
  })

  await plateClearingPlugin.register({
    pluginName: 'plate-clearing',
    logger: { info() {}, warn() {}, error() {} },
    prisma: {
      printer: {
        findMany: async () => [{ id: 'printer-1' }]
      }
    },
    printerEvents: events,
    ws: { broadcast() {} },
    isEnabledForWorkspace: () => true,
    router: express.Router(),
    settings: {
      // Platform-global store is unused by this plugin now.
      ...makeStore(new Map<string, string>()),
      forWorkspace(workspaceId: string) {
        let map = workspaceSettings.get(workspaceId)
        if (!map) { map = new Map(); workspaceSettings.set(workspaceId, map) }
        return makeStore(map)
      }
    },
    onShutdown() {},
    registerPrintGuard() {
      return () => {}
    },
    registerAuthProvider() {
      return () => {}
    }
  } as never)

  // `settings` is workspace-1's store, where this printer's state lives.
  return { events, settings: workspace1, workspaceSettings }
}
