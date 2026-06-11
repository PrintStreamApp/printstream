import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderNotificationTemplate } from './notification-templates.js'
import type { NotificationMessage, Printer, PrinterStatus } from '@printstream/shared'
import { subscribePrinterNotifications } from './notification-format.js'
import {
  resetNotificationTemplateCacheForTests,
  setNotificationTemplateOverrideForTests
} from './notification-templates.js'
import { PrinterEventBus } from './printer-events.js'
import { printerManager } from './printer-manager.js'
import { rootPrisma } from './prisma.js'

const printer: Printer = {
  id: 'printer-1',
  name: 'Printer 1',
  host: '127.0.0.1',
  serial: 'SERIAL-1',
  accessCode: 'secret',
  model: 'unknown',
  currentPlateType: null,
  currentNozzleDiameters: [],
  position: 0,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString()
}

const originalTenantFindUnique = rootPrisma.tenant.findUnique
const originalGetTenantId = printerManager.getTenantId
const originalGetPrinter = printerManager.getPrinter
const originalGetLastJobName = printerManager.getLastJobName

test.after(() => {
  rootPrisma.tenant.findUnique = originalTenantFindUnique
  printerManager.getTenantId = originalGetTenantId
  printerManager.getPrinter = originalGetPrinter
  printerManager.getLastJobName = originalGetLastJobName
  resetNotificationTemplateCacheForTests()
})

test.beforeEach(() => {
  rootPrisma.tenant.findUnique = originalTenantFindUnique
  printerManager.getTenantId = originalGetTenantId
  printerManager.getPrinter = originalGetPrinter
  printerManager.getLastJobName = originalGetLastJobName
  resetNotificationTemplateCacheForTests()
})

function makeStatus(overrides: Partial<PrinterStatus> = {}): PrinterStatus {
  return {
    printerId: printer.id,
    online: true,
    stage: 'printing',
    subStage: null,
    filamentChange: { currentStepIndex: null, currentStepLabel: null, steps: [] },
    jobId: 'job-1',
    jobName: 'Calibration cube',
    lastJobName: 'Calibration cube',
    deviceError: null,
    hmsErrors: [],
    observedAt: new Date(0).toISOString(),
    ...overrides
  } as unknown as PrinterStatus
}

test('subscribePrinterNotifications skips started messages by default', async () => {
  const bus = new PrinterEventBus()
  const received: NotificationMessage[] = []
  const dispose = subscribePrinterNotifications(bus, (message) => {
    received.push(message)
  })

  bus.emit('print-job.started', { jobId: 'job-1', printer, jobName: 'Calibration cube' })
  await new Promise((resolve) => setImmediate(resolve))
  dispose()

  assert.equal(received.length, 0)
})

test('subscribePrinterNotifications formats enabled started messages from bus events', async () => {
  setNotificationTemplateOverrideForTests('job.started', { enabled: true })
  printerManager.getTenantId = (() => 'tenant-1') as typeof printerManager.getTenantId
  rootPrisma.tenant.findUnique = ((async () => ({ slug: 'default' })) as unknown) as typeof rootPrisma.tenant.findUnique
  const bus = new PrinterEventBus()
  const message = await new Promise<NotificationMessage>((resolve) => {
    const dispose = subscribePrinterNotifications(bus, (next) => {
      dispose()
      resolve(next)
    })
    bus.emit('print-job.started', { jobId: 'job-1', printer, jobName: 'Calibration cube' })
  })

  assert.equal(message.category, 'job.started')
  assert.equal(message.level, 'info')
  assert.equal(message.title, 'Printer 1: Print started')
  assert.equal(message.body, 'Job: Calibration cube')
  assert.equal(message.tag, 'printer:printer-1:job')
  assert.equal(message.url, '/workspaces/default/printers/printer-1')
})

test('subscribePrinterNotifications formats finished messages and cleanup unsubscribes listeners', async () => {
  printerManager.getTenantId = (() => 'tenant-1') as typeof printerManager.getTenantId
  rootPrisma.tenant.findUnique = ((async () => ({ slug: 'default' })) as unknown) as typeof rootPrisma.tenant.findUnique
  const bus = new PrinterEventBus()
  const received: NotificationMessage[] = []
  const dispose = subscribePrinterNotifications(bus, (message) => {
    received.push(message)
  })

  bus.emit('print-job.finished', {
    jobId: 'job-1',
    printer,
    jobName: 'Calibration cube',
    result: 'failed',
    snapshotPath: null
  })
  await new Promise((resolve) => setImmediate(resolve))
  dispose()
  bus.emit('print-job.finished', {
    jobId: 'job-2',
    printer,
    jobName: 'Ignored job',
    result: 'success',
    snapshotPath: null
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(received.length, 1)
  assert.equal(received[0]?.category, 'job.finished')
  assert.equal(received[0]?.level, 'error')
  assert.equal(received[0]?.title, 'Printer 1: Print failed')
  assert.equal(received[0]?.body, 'Job: Calibration cube')
  assert.equal(received[0]?.url, '/workspaces/default/printers/printer-1')
})

test('subscribePrinterNotifications falls back to workspace selection when the tenant slug is unavailable', async () => {
  setNotificationTemplateOverrideForTests('job.started', { enabled: true })
  printerManager.getTenantId = (() => 'tenant-1') as typeof printerManager.getTenantId
  rootPrisma.tenant.findUnique = ((async () => null) as unknown) as typeof rootPrisma.tenant.findUnique
  const bus = new PrinterEventBus()
  const message = await new Promise<NotificationMessage>((resolve) => {
    const dispose = subscribePrinterNotifications(bus, (next) => {
      dispose()
      resolve(next)
    })
    bus.emit('print-job.started', { jobId: 'job-1', printer, jobName: 'Calibration cube' })
  })

  assert.equal(message.url, '/workspaces')
})

test('subscribePrinterNotifications skips tenants rejected by the runtime enablement filter', async () => {
  setNotificationTemplateOverrideForTests('job.started', { enabled: true })
  const bus = new PrinterEventBus()
  const received: NotificationMessage[] = []
  const dispose = subscribePrinterNotifications(bus, (message) => {
    received.push(message)
  }, {
    shouldHandleTenantId: () => false
  })

  bus.emit('print-job.started', { jobId: 'job-1', printer, jobName: 'Ignored job' })
  await new Promise((resolve) => setImmediate(resolve))
  dispose()

  assert.equal(received.length, 0)
})

test('pause and error templates are enabled with snapshots by default', () => {
  const paused = renderNotificationTemplate('job.paused', {
    printerName: 'Printer 1',
    jobName: 'Calibration cube',
    reason: 'Awaiting user action'
  })
  const errored = renderNotificationTemplate('job.error', {
    printerName: 'Printer 1',
    jobName: 'Calibration cube',
    errorMessage: 'Build plate mismatch',
    errorCode: '07008011'
  })

  assert.equal(paused.enabled, true)
  assert.equal(paused.includeSnapshot, true)
  assert.equal(errored.enabled, true)
  assert.equal(errored.includeSnapshot, true)
})

test('subscribePrinterNotifications formats pause and error messages from status transitions without repeating the same error', async () => {
  printerManager.getTenantId = (() => 'tenant-1') as typeof printerManager.getTenantId
  printerManager.getPrinter = ((printerId: string) => (printerId === printer.id ? printer : undefined)) as typeof printerManager.getPrinter
  printerManager.getLastJobName = (() => 'Calibration cube') as typeof printerManager.getLastJobName
  rootPrisma.tenant.findUnique = ((async () => ({ slug: 'default' })) as unknown) as typeof rootPrisma.tenant.findUnique
  const bus = new PrinterEventBus()
  const received: NotificationMessage[] = []
  const dispose = subscribePrinterNotifications(bus, (message) => {
    received.push(message)
  })

  bus.emit('status', makeStatus())
  bus.emit('status', makeStatus({
    stage: 'paused',
    subStage: 'Awaiting user action'
  }))
  bus.emit('status', makeStatus({
    stage: 'paused',
    deviceError: { code: '07008011', message: 'Build plate mismatch' }
  }))
  bus.emit('status', makeStatus({
    stage: 'paused',
    deviceError: { code: '07008011', message: 'Build plate mismatch' }
  }))
  bus.emit('status', makeStatus({
    stage: 'printing',
    hmsErrors: [{ code: '0300-0100-0001', message: 'Nozzle issue' }]
  }))
  await new Promise((resolve) => setImmediate(resolve))
  dispose()

  assert.equal(received.length, 3)
  assert.equal(received[0]?.category, 'job.paused')
  assert.equal(received[0]?.level, 'warning')
  assert.equal(received[0]?.title, 'Printer 1: Print paused')
  assert.equal(received[0]?.body, 'Job: Calibration cube')
  assert.equal(received[1]?.category, 'job.error')
  assert.equal(received[1]?.level, 'error')
  assert.equal(received[1]?.title, 'Printer 1: Print error')
  assert.equal(received[1]?.body, 'Job: Calibration cube\nBuild plate mismatch')
  assert.equal(received[1]?.url, '/workspaces/default/printers/printer-1')
  assert.equal(received[2]?.category, 'job.error')
  assert.equal(received[2]?.body, 'Job: Calibration cube\nNozzle issue')
})

function stubNotificationLookups() {
  printerManager.getTenantId = (() => 'tenant-1') as typeof printerManager.getTenantId
  printerManager.getPrinter = ((printerId: string) => (printerId === printer.id ? printer : undefined)) as typeof printerManager.getPrinter
  printerManager.getLastJobName = (() => 'Calibration cube') as typeof printerManager.getLastJobName
  rootPrisma.tenant.findUnique = ((async () => ({ slug: 'default' })) as unknown) as typeof rootPrisma.tenant.findUnique
}

const HMS_A = { code: '0300-0100-0001', message: 'Nozzle issue' }
const HMS_B = { code: '0500-0200-0002', message: 'AMS filament jam' }
const HMS_C = { code: '0700-0300-0003', message: 'Chamber overheating' }

test('multiple HMS errors notify once, listing every error', async () => {
  stubNotificationLookups()
  const bus = new PrinterEventBus()
  const received: NotificationMessage[] = []
  const dispose = subscribePrinterNotifications(bus, (message) => {
    received.push(message)
  })

  bus.emit('status', makeStatus())
  bus.emit('status', makeStatus({ hmsErrors: [HMS_A, HMS_B, HMS_C] }))
  // Re-reports of the same list (any order) must stay silent.
  bus.emit('status', makeStatus({ hmsErrors: [HMS_B, HMS_C, HMS_A] }))
  await new Promise((resolve) => setImmediate(resolve))
  dispose()

  assert.equal(received.length, 1)
  assert.equal(received[0]?.category, 'job.error')
  assert.equal(received[0]?.body, 'Job: Calibration cube\nNozzle issue\nAMS filament jam\nChamber overheating')
})

test('incremental HMS errors notify only the newly added error', async () => {
  stubNotificationLookups()
  const bus = new PrinterEventBus()
  const received: NotificationMessage[] = []
  const dispose = subscribePrinterNotifications(bus, (message) => {
    received.push(message)
  })

  bus.emit('status', makeStatus())
  bus.emit('status', makeStatus({ hmsErrors: [HMS_A] }))
  bus.emit('status', makeStatus({ hmsErrors: [HMS_A, HMS_B] }))
  await new Promise((resolve) => setImmediate(resolve))
  dispose()

  assert.equal(received.length, 2)
  assert.equal(received[0]?.body, 'Job: Calibration cube\nNozzle issue')
  assert.equal(received[1]?.body, 'Job: Calibration cube\nAMS filament jam')
})

test('a transient empty HMS list (reconnect flap) does not re-notify the same errors', async () => {
  stubNotificationLookups()
  const bus = new PrinterEventBus()
  const received: NotificationMessage[] = []
  const dispose = subscribePrinterNotifications(bus, (message) => {
    received.push(message)
  })

  bus.emit('status', makeStatus())
  bus.emit('status', makeStatus({ hmsErrors: [HMS_A, HMS_B] }))
  bus.emit('status', makeStatus({ online: false, hmsErrors: [] }))
  bus.emit('status', makeStatus({ hmsErrors: [] }))
  bus.emit('status', makeStatus({ hmsErrors: [HMS_A, HMS_B] }))
  await new Promise((resolve) => setImmediate(resolve))
  dispose()

  assert.equal(received.length, 1)
  assert.equal(received[0]?.body, 'Job: Calibration cube\nNozzle issue\nAMS filament jam')
})

test('a new job baselines standing errors silently but notifies fresh ones', async () => {
  stubNotificationLookups()
  const bus = new PrinterEventBus()
  const received: NotificationMessage[] = []
  const dispose = subscribePrinterNotifications(bus, (message) => {
    received.push(message)
  })

  bus.emit('status', makeStatus())
  bus.emit('status', makeStatus({ hmsErrors: [HMS_A] }))
  // Job ends with the error still standing; the next job must not re-announce it.
  bus.emit('status', makeStatus({ stage: 'finished', hmsErrors: [HMS_A] }))
  bus.emit('status', makeStatus({ stage: 'printing', jobId: 'job-2', hmsErrors: [HMS_A] }))
  // A genuinely new error during the new job still notifies.
  bus.emit('status', makeStatus({ stage: 'printing', jobId: 'job-2', hmsErrors: [HMS_A, HMS_B] }))
  await new Promise((resolve) => setImmediate(resolve))
  dispose()

  assert.equal(received.length, 2)
  assert.equal(received[0]?.body, 'Job: Calibration cube\nNozzle issue')
  assert.equal(received[1]?.body, 'Job: Calibration cube\nAMS filament jam')
})