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

  mock.method(printerManager, 'getTenantId', () => 'tenant-1')

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

  mock.method(printerManager, 'getTenantId', () => 'tenant-1')

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

  mock.method(printerManager, 'getTenantId', () => 'tenant-1')

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

  mock.method(printerManager, 'getTenantId', () => 'tenant-1')

  events.emit('job.finished', {
    printer: { id: 'printer-1' },
    jobName: 'Cube',
    result: 'failed'
  } as never)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(settings.get('cleared:printer-1'), 'false')
})

async function registerPlateClearingPlugin(initialSettings: Record<string, string>) {
  const settings = new Map(Object.entries(initialSettings))
  const events = new PrinterEventBus()

  Object.defineProperty(rootPrisma.printer, 'findMany', {
    value: async () => [{ id: 'printer-1' }],
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
    isEnabledForTenant: () => true,
    router: express.Router(),
    settings: {
      async get(key: string) {
        return settings.get(key) ?? null
      },
      async set(key: string, value: string) {
        settings.set(key, value)
      },
      async delete(key: string) {
        settings.delete(key)
      },
      forTenant() {
        throw new Error('Tenant-scoped settings are not used in this plugin test')
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

  return { events, settings }
}
