process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { recoverBridgePrinterAssignments } from './bridge-assignment-recovery.js'
import { bridgeSessionManager } from './bridge-session-manager.js'
import { printerDiscovery } from './printer-discovery.js'
import { printerManager } from './printer-manager.js'
import { rootPrisma } from './prisma.js'

const originalBridgeFindMany = rootPrisma.bridge.findMany
const originalPrinterFindMany = rootPrisma.printer.findMany
const originalPrinterUpdateMany = rootPrisma.printer.updateMany
const originalPrinterCount = rootPrisma.printer.count
const originalTransaction = rootPrisma.$transaction
const originalLibraryFileUpdateMany = rootPrisma.libraryFile.updateMany
const originalLibraryFolderUpdateMany = rootPrisma.libraryFolder.updateMany
const originalLibraryVersionUpdateMany = rootPrisma.libraryFileVersion.updateMany
const originalIsConnected = bridgeSessionManager.isConnected
const originalPrinterManagerUpdate = printerManager.update

beforeEach(() => {
  // Default library re-home stubs so the printer-only tests don't touch a DB: a
  // drained-source check that reports the sibling still has printers short-circuits
  // the library re-adoption before it runs.
  rootPrisma.printer.count = ((async () => 1) as unknown) as typeof rootPrisma.printer.count
  rootPrisma.$transaction = ((async (ops: Promise<unknown>[]) => Promise.all(ops)) as unknown) as typeof rootPrisma.$transaction
  rootPrisma.libraryFile.updateMany = ((async () => ({ count: 0 })) as unknown) as typeof rootPrisma.libraryFile.updateMany
  rootPrisma.libraryFolder.updateMany = ((async () => ({ count: 0 })) as unknown) as typeof rootPrisma.libraryFolder.updateMany
  rootPrisma.libraryFileVersion.updateMany = ((async () => ({ count: 0 })) as unknown) as typeof rootPrisma.libraryFileVersion.updateMany
})

afterEach(() => {
  rootPrisma.bridge.findMany = originalBridgeFindMany
  rootPrisma.printer.findMany = originalPrinterFindMany
  rootPrisma.printer.updateMany = originalPrinterUpdateMany
  rootPrisma.printer.count = originalPrinterCount
  rootPrisma.$transaction = originalTransaction
  rootPrisma.libraryFile.updateMany = originalLibraryFileUpdateMany
  rootPrisma.libraryFolder.updateMany = originalLibraryFolderUpdateMany
  rootPrisma.libraryFileVersion.updateMany = originalLibraryVersionUpdateMany
  bridgeSessionManager.isConnected = originalIsConnected
  printerManager.update = originalPrinterManagerUpdate
  printerDiscovery.reset()
})

test('recovers rediscovered printers from a disconnected stale bridge assignment', async () => {
  rootPrisma.bridge.findMany = ((async () => [
    { id: 'old-bridge' },
    { id: 'new-bridge' }
  ]) as unknown) as typeof rootPrisma.bridge.findMany
  rootPrisma.printer.findMany = ((async () => [
    makePrinter({ id: 'printer-1', serial: 'SERIAL-1', bridgeId: 'old-bridge' }),
    makePrinter({ id: 'printer-2', serial: 'SERIAL-2', bridgeId: 'old-bridge' })
  ]) as unknown) as typeof rootPrisma.printer.findMany
  bridgeSessionManager.isConnected = ((bridgeId: string) => bridgeId === 'new-bridge') as typeof bridgeSessionManager.isConnected
  printerDiscovery.setBridgePrinters('new-bridge', [makeDiscoveredPrinter({ serial: 'SERIAL-1' })])

  let updateManyArgs: unknown = null
  rootPrisma.printer.updateMany = ((async (args: unknown) => {
    updateManyArgs = args
    return { count: 1 }
  }) as unknown) as typeof rootPrisma.printer.updateMany
  const managerUpdates: Array<{ printerId: string; bridgeId: string | null | undefined }> = []
  printerManager.update = ((printer, _tenantId, bridgeId) => {
    managerUpdates.push({ printerId: printer.id, bridgeId })
  }) as typeof printerManager.update

  const recovered = await recoverBridgePrinterAssignments({ tenantId: 'tenant-1', bridgeId: 'new-bridge' })

  assert.deepEqual(recovered.map((printer) => printer.id), ['printer-1'])
  assert.deepEqual(updateManyArgs, {
    where: {
      tenantId: 'tenant-1',
      id: { in: ['printer-1'] }
    },
    data: { bridgeId: 'new-bridge' }
  })
  assert.deepEqual(managerUpdates, [{ printerId: 'printer-1', bridgeId: 'new-bridge' }])
})

test('does not recover printers from another connected bridge', async () => {
  rootPrisma.bridge.findMany = ((async () => [
    { id: 'old-bridge' },
    { id: 'new-bridge' }
  ]) as unknown) as typeof rootPrisma.bridge.findMany
  rootPrisma.printer.findMany = ((async () => [
    makePrinter({ id: 'printer-1', serial: 'SERIAL-1', bridgeId: 'old-bridge' })
  ]) as unknown) as typeof rootPrisma.printer.findMany
  bridgeSessionManager.isConnected = (() => true) as typeof bridgeSessionManager.isConnected
  printerDiscovery.setBridgePrinters('new-bridge', [makeDiscoveredPrinter({ serial: 'SERIAL-1' })])

  let updateCalled = false
  rootPrisma.printer.updateMany = ((async () => {
    updateCalled = true
    return { count: 0 }
  }) as unknown) as typeof rootPrisma.printer.updateMany
  printerManager.update = (() => {
    throw new Error('printer manager should not be updated')
  }) as typeof printerManager.update

  const recovered = await recoverBridgePrinterAssignments({ tenantId: 'tenant-1', bridgeId: 'new-bridge' })

  assert.deepEqual(recovered, [])
  assert.equal(updateCalled, false)
})

test('re-homes the library from a disconnected bridge once its last printer is drained', async () => {
  rootPrisma.bridge.findMany = ((async () => [
    { id: 'old-bridge' },
    { id: 'new-bridge' }
  ]) as unknown) as typeof rootPrisma.bridge.findMany
  rootPrisma.printer.findMany = ((async () => [
    makePrinter({ id: 'printer-1', serial: 'SERIAL-1', bridgeId: 'old-bridge' })
  ]) as unknown) as typeof rootPrisma.printer.findMany
  bridgeSessionManager.isConnected = ((bridgeId: string) => bridgeId === 'new-bridge') as typeof bridgeSessionManager.isConnected
  printerDiscovery.setBridgePrinters('new-bridge', [makeDiscoveredPrinter({ serial: 'SERIAL-1' })])
  rootPrisma.printer.updateMany = ((async () => ({ count: 1 })) as unknown) as typeof rootPrisma.printer.updateMany
  printerManager.update = (() => {}) as typeof printerManager.update

  // The drained old bridge now has zero printers, so the library should follow.
  rootPrisma.printer.count = ((async () => 0) as unknown) as typeof rootPrisma.printer.count
  const libraryUpdates: unknown[] = []
  rootPrisma.libraryFile.updateMany = ((async (args: unknown) => { libraryUpdates.push(args); return { count: 5 } }) as unknown) as typeof rootPrisma.libraryFile.updateMany
  rootPrisma.libraryFolder.updateMany = ((async (args: unknown) => { libraryUpdates.push(args); return { count: 2 } }) as unknown) as typeof rootPrisma.libraryFolder.updateMany
  rootPrisma.libraryFileVersion.updateMany = ((async (args: unknown) => { libraryUpdates.push(args); return { count: 1 } }) as unknown) as typeof rootPrisma.libraryFileVersion.updateMany

  await recoverBridgePrinterAssignments({ tenantId: 'tenant-1', bridgeId: 'new-bridge' })

  const expected = { where: { tenantId: 'tenant-1', ownerBridgeId: 'old-bridge' }, data: { ownerBridgeId: 'new-bridge' } }
  assert.deepEqual(libraryUpdates, [expected, expected, expected])
})

test('does not re-home the library while the drained bridge still owns printers', async () => {
  rootPrisma.bridge.findMany = ((async () => [
    { id: 'old-bridge' },
    { id: 'new-bridge' }
  ]) as unknown) as typeof rootPrisma.bridge.findMany
  rootPrisma.printer.findMany = ((async () => [
    makePrinter({ id: 'printer-1', serial: 'SERIAL-1', bridgeId: 'old-bridge' })
  ]) as unknown) as typeof rootPrisma.printer.findMany
  bridgeSessionManager.isConnected = ((bridgeId: string) => bridgeId === 'new-bridge') as typeof bridgeSessionManager.isConnected
  printerDiscovery.setBridgePrinters('new-bridge', [makeDiscoveredPrinter({ serial: 'SERIAL-1' })])
  rootPrisma.printer.updateMany = ((async () => ({ count: 1 })) as unknown) as typeof rootPrisma.printer.updateMany
  printerManager.update = (() => {}) as typeof printerManager.update

  // A printer still lives on the old bridge (it merely roamed) — leave its library put.
  rootPrisma.printer.count = ((async () => 1) as unknown) as typeof rootPrisma.printer.count
  rootPrisma.libraryFile.updateMany = (() => { throw new Error('library must not be re-homed') }) as typeof rootPrisma.libraryFile.updateMany

  await recoverBridgePrinterAssignments({ tenantId: 'tenant-1', bridgeId: 'new-bridge' })
})

function makePrinter(overrides: Partial<{
  id: string
  tenantId: string
  bridgeId: string | null
  serial: string
}> = {}) {
  return {
    id: overrides.id ?? 'printer-1',
    tenantId: overrides.tenantId ?? 'tenant-1',
    bridgeId: overrides.bridgeId ?? null,
    name: 'Printer One',
    host: 'printer-one.local',
    serial: overrides.serial ?? 'SERIAL-1',
    accessCode: 'secret',
    model: 'P1S',
    currentPlateType: null,
    currentNozzleDiameters: null,
    position: 0,
    createdAt: new Date('2026-05-08T18:00:00.000Z'),
    updatedAt: new Date('2026-05-08T18:40:00.000Z')
  }
}

function makeDiscoveredPrinter(overrides: Partial<{
  serial: string
  host: string
}> = {}) {
  return {
    serial: overrides.serial ?? 'SERIAL-1',
    host: overrides.host ?? 'printer-one.local',
    modelCode: 'BL-P001',
    model: 'P1S' as const,
    name: 'Printer One',
    firmware: null,
    lastSeenAt: new Date('2026-05-08T18:45:00.000Z').toISOString()
  }
}
