process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { WebSocket } from 'ws'
import type { Printer, PrinterStatus } from '@printstream/shared'
import { CameraSnapshotHub, type CameraSnapshotHubOptions } from './camera-snapshot-hub.js'

function makePrinter(id: string, model: Printer['model'] = 'P1S'): Printer {
  return {
    id,
    name: `Printer ${id}`,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    host: 'printer.local',
    serial: `SERIAL-${id}`,
    accessCode: 'CODE',
    model,
    currentPlateType: 'Textured PEI Plate',
    currentNozzleDiameters: [{ extruderId: 0, diameter: '0.4' }],
    position: 0
  }
}

function statusFor(printerId: string, online: boolean): PrinterStatus {
  return { printerId, online } as PrinterStatus
}

interface Harness {
  hub: CameraSnapshotHub
  events: EventEmitter
  refreshCounts: Map<string, number>
  broadcasts: string[]
}

function createHarness(options: {
  printers: Map<string, Printer>
  cameraModels?: Set<string>
  initialStatuses?: PrinterStatus[]
  overrides?: Partial<CameraSnapshotHubOptions>
}): Harness {
  const events = new EventEmitter()
  const refreshCounts = new Map<string, number>()
  const broadcasts: string[] = []

  const hub = new CameraSnapshotHub(
    {
      broadcastSnapshotUpdated: (printerId) => {
        broadcasts.push(printerId)
      }
    },
    {
      snapshotIntervalMs: 15,
      idleSnapshotIntervalMs: 30,
      random: () => 0,
      getPrinter: (printerId) => options.printers.get(printerId),
      supportsCamera: (model) => (options.cameraModels ? options.cameraModels.has(model) : true),
      getPrinterStatuses: () => options.initialStatuses ?? [],
      events: events as unknown as CameraSnapshotHubOptions['events'],
      refreshSnapshot: async (printer) => {
        refreshCounts.set(printer.id, (refreshCounts.get(printer.id) ?? 0) + 1)
      },
      ...options.overrides
    }
  )

  return { hub, events, refreshCounts, broadcasts }
}

function fakeClient(): WebSocket {
  return {} as unknown as WebSocket
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error('Timed out waiting for test condition')
    }
    await delay(5)
  }
}

test('background poll refreshes online camera-capable printers with no viewers', async () => {
  const printers = new Map([['p1', makePrinter('p1')]])
  const { hub, refreshCounts } = createHarness({
    printers,
    initialStatuses: [statusFor('p1', true)]
  })

  hub.start()
  try {
    await waitFor(() => (refreshCounts.get('p1') ?? 0) >= 2)
    assert.ok((refreshCounts.get('p1') ?? 0) >= 2)
  } finally {
    hub.stop()
  }
})

test('background poll ignores offline and non-camera printers', async () => {
  const printers = new Map([
    ['offline', makePrinter('offline')],
    ['no-cam', makePrinter('no-cam', 'A1')]
  ])
  const { hub, refreshCounts } = createHarness({
    printers,
    cameraModels: new Set(['P1S']),
    initialStatuses: [statusFor('offline', false), statusFor('no-cam', true)]
  })

  hub.start()
  try {
    await delay(80)
    assert.equal(refreshCounts.get('offline'), undefined)
    assert.equal(refreshCounts.get('no-cam'), undefined)
  } finally {
    hub.stop()
  }
})

test('a printer coming online later begins background polling', async () => {
  const printers = new Map([['p1', makePrinter('p1')]])
  const { hub, events, refreshCounts } = createHarness({ printers })

  hub.start()
  try {
    await delay(50)
    assert.equal(refreshCounts.get('p1'), undefined)

    events.emit('status', statusFor('p1', true))
    await waitFor(() => (refreshCounts.get('p1') ?? 0) >= 1)
    assert.ok((refreshCounts.get('p1') ?? 0) >= 1)
  } finally {
    hub.stop()
  }
})

test('a printer going offline stops background polling', async () => {
  const printers = new Map([['p1', makePrinter('p1')]])
  const { hub, events, refreshCounts } = createHarness({
    printers,
    initialStatuses: [statusFor('p1', true)]
  })

  hub.start()
  try {
    await waitFor(() => (refreshCounts.get('p1') ?? 0) >= 1)
    events.emit('status', statusFor('p1', false))
    const countAtOffline = refreshCounts.get('p1') ?? 0
    await delay(80)
    assert.equal(refreshCounts.get('p1'), countAtOffline)
  } finally {
    hub.stop()
  }
})

test('printer.removed stops background polling', async () => {
  const printers = new Map([['p1', makePrinter('p1')]])
  const { hub, events, refreshCounts } = createHarness({
    printers,
    initialStatuses: [statusFor('p1', true)]
  })

  hub.start()
  try {
    await waitFor(() => (refreshCounts.get('p1') ?? 0) >= 1)
    events.emit('printer.removed', { printerId: 'p1', tenantId: 't1' })
    const countAtRemoval = refreshCounts.get('p1') ?? 0
    await delay(80)
    assert.equal(refreshCounts.get('p1'), countAtRemoval)
  } finally {
    hub.stop()
  }
})

test('watching refreshes immediately and unwatch falls back to background polling', async () => {
  const printers = new Map([['p1', makePrinter('p1')]])
  const { hub, refreshCounts } = createHarness({
    printers,
    initialStatuses: [statusFor('p1', true)]
  })

  hub.start()
  try {
    const client = fakeClient()
    hub.watch(client, 'p1')
    // Immediate refresh on first viewer.
    await waitFor(() => (refreshCounts.get('p1') ?? 0) >= 1)

    const countBeforeUnwatch = refreshCounts.get('p1') ?? 0
    hub.unwatch(client, 'p1')

    // Background polling continues after the viewer leaves.
    await waitFor(() => (refreshCounts.get('p1') ?? 0) > countBeforeUnwatch)
    assert.ok((refreshCounts.get('p1') ?? 0) > countBeforeUnwatch)
  } finally {
    hub.stop()
  }
})

test('watching a printer that was never online still polls while viewed then stops', async () => {
  const printers = new Map([['p1', makePrinter('p1')]])
  const { hub, refreshCounts } = createHarness({ printers })

  hub.start()
  try {
    const client = fakeClient()
    hub.watch(client, 'p1')
    await waitFor(() => (refreshCounts.get('p1') ?? 0) >= 1)

    hub.unwatch(client, 'p1')
    const countAfterUnwatch = refreshCounts.get('p1') ?? 0
    // No background flag (printer never reported online), so polling stops.
    await delay(80)
    assert.equal(refreshCounts.get('p1'), countAfterUnwatch)
  } finally {
    hub.stop()
  }
})

test('stop() detaches event listeners and clears timers', async () => {
  const printers = new Map([['p1', makePrinter('p1')]])
  const { hub, events, refreshCounts } = createHarness({
    printers,
    initialStatuses: [statusFor('p1', true)]
  })

  hub.start()
  await waitFor(() => (refreshCounts.get('p1') ?? 0) >= 1)
  hub.stop()

  const countAtStop = refreshCounts.get('p1') ?? 0
  events.emit('status', statusFor('p1', true))
  await delay(80)
  assert.equal(refreshCounts.get('p1'), countAtStop)
})
