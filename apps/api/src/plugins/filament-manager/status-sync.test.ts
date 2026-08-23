/**
 * Behavioural cover for the status observer: the half of spool tracking that reacts to
 * what the AMS reports. `collectPresences`/`signature` were the only tested parts, so
 * "the printer reports a removal" was covered while "the library reacts to it" was not.
 */
process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { PrinterStatus } from '@printstream/shared'
import type { ApiPluginContext } from '../../plugin/types.js'
import { rootPrisma } from '../../lib/prisma.js'
import { printerManager } from '../../lib/printer-manager.js'
import { usePrismaStubs } from '../../test-utils/prisma-stubs.js'
import { createStatusObserver } from './status-sync.js'

const stub = usePrismaStubs()

const PRINTER_ID = 'printer-1'
const WORKSPACE_ID = 'workspace-1'

const originalGetWorkspaceId = printerManager.getWorkspaceId.bind(printerManager)
afterEach(() => {
  printerManager.getWorkspaceId = originalGetWorkspaceId
})

/** A spool row as the unassign loop reads it: RFID-tagged and bound to a slot. */
function loadedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'spool-1',
    workspaceId: WORKSPACE_ID,
    bambuUuid: 'UUID-A',
    brand: 'Bambu',
    filamentType: 'PLA',
    materialSubtype: 'PLA Basic',
    colorName: 'Turquoise',
    colorHex: '#00CFCF',
    trayInfoIdx: 'GFA00',
    archivedAt: null,
    netWeightGrams: 1000,
    remainingGrams: 0,
    remainSource: 'printer',
    loadedPrinterId: PRINTER_ID,
    loadedAmsId: 0,
    loadedSlotId: 3,
    ...overrides
  }
}

function amsStatus(slots: Array<Record<string, unknown>>, overrides: Partial<PrinterStatus> = {}): PrinterStatus {
  return {
    printerId: PRINTER_ID,
    online: true,
    ams: [{ unitId: 0, type: 'ams', slots }],
    externalSpools: [],
    ...overrides
  } as unknown as PrinterStatus
}

interface Harness {
  observe: (status: PrinterStatus) => void
  /** Every `updateMany` the pass issued, so a test can assert what it cleared. */
  updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>
  settle: () => Promise<void>
}

function harness(options: { findFirst?: () => unknown; loadedHere?: () => unknown[]; onUpdate?: () => void } = {}): Harness {
  const updates: Harness['updates'] = []
  printerManager.getWorkspaceId = (() => WORKSPACE_ID) as typeof printerManager.getWorkspaceId

  stub(rootPrisma.filamentSpool, 'findFirst', async () => options.findFirst?.() ?? null)
  stub(rootPrisma.filamentSpool, 'findMany', async () => options.loadedHere?.() ?? [])
  stub(rootPrisma.filamentSpool, 'create', async () => ({ id: 'created' }))
  stub(rootPrisma.filamentSpool, 'updateMany', async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    options.onUpdate?.()
    updates.push(args)
    return { count: 1 }
  })

  const context = {
    logger: { error() {}, warn() {}, info() {}, debug() {} },
    settings: { forWorkspace: () => ({ get: async () => null, set: async () => {}, delete: async () => {} }) },
    ws: { broadcast() {} },
    printerEvents: { emit() {} },
    isEnabledForWorkspace: () => true
  } as unknown as ApiPluginContext

  return {
    observe: createStatusObserver(context),
    updates,
    // The observer is fire-and-forget; let its promise chain drain.
    settle: async () => { await new Promise((resolve) => setImmediate(resolve)) }
  }
}

/** The AMS-less placeholder a fresh `ManagedPrinter` starts from (`makeOfflineStatus`). */
const noAmsStatus = (overrides: Partial<PrinterStatus> = {}): PrinterStatus =>
  ({ ...amsStatus([]), ams: [], ...overrides }) as PrinterStatus

const LOADED_SLOT = { slot: 3, trayUuid: 'UUID-A', remainPercent: 0, filamentType: 'PLA', color: '#00CFCF', colors: ['#00CFCF'], trayInfoIdx: 'GFA00' }
const EMPTY_SLOT = { slot: 3, trayUuid: null, remainPercent: null, filamentType: null, color: null, colors: [], trayInfoIdx: null }

test('a spool removed from its slot loses its association', async () => {
  const test = harness({ loadedHere: () => [loadedRow()] })

  test.observe(amsStatus([EMPTY_SLOT]))
  await test.settle()

  const cleared = test.updates.find((update) => update.data.loadedPrinterId === null)
  assert.ok(cleared, 'expected the removed spool to be unassigned')
  assert.equal(cleared?.where.id, 'spool-1')
  assert.deepEqual(cleared?.data, { loadedPrinterId: null, loadedAmsId: null, loadedSlotId: null, loadedAt: null })
})

test('a status carrying no AMS units never unassigns anything', async () => {
  // A fresh ManagedPrinter starts from `makeOfflineStatus`, which has no AMS at all.
  // Read as presences that would be "every slot is empty", and it used to be.
  const test = harness({ loadedHere: () => [loadedRow()] })

  // Both shapes of "told us nothing": no units at all, and a unit with no slots parsed.
  test.observe(noAmsStatus({ online: false }))
  await test.settle()
  test.observe(amsStatus([]))
  await test.settle()

  assert.deepEqual(test.updates, [], 'a status with no observed slots is not evidence that a slot is empty')
})

test('an ONLINE placeholder with no AMS units still never unassigns anything', async () => {
  // The trap an earlier `!status.online` guard missed entirely: `hintOnline` merges
  // `{ online: true }` onto the untouched AMS-less placeholder when a bridge's SSDP
  // sweep spots the printer, so the wipe was reachable with `online: true`, in exactly
  // the post-restart window the guard was written for.
  const test = harness({ loadedHere: () => [loadedRow()] })

  test.observe(noAmsStatus({ online: true }))
  await test.settle()

  assert.deepEqual(test.updates, [], 'an online status with no AMS units is still not evidence')
})

test('a unit reporting empty slots DOES unassign', async () => {
  // The other side of the guard: a real removal arrives as a unit WITH empty slots,
  // which must still get through. Guarding on "no AMS units" rather than "offline" is
  // what keeps these two apart.
  const test = harness({ loadedHere: () => [loadedRow()] })

  test.observe(amsStatus([EMPTY_SLOT], { online: true }))
  await test.settle()

  assert.ok(test.updates.some((update) => update.data.loadedPrinterId === null))
})

test('a placeholder frame does not suppress the real frame behind it', async () => {
  // Both frames carry the same (empty) signature. If the offline one recorded it, the
  // online one would short-circuit and the removal would never be applied.
  const test = harness({ loadedHere: () => [loadedRow()] })

  test.observe(noAmsStatus({ online: false }))
  await test.settle()
  test.observe(amsStatus([EMPTY_SLOT]))
  await test.settle()

  assert.ok(test.updates.some((update) => update.data.loadedPrinterId === null))
})

test('a pass that throws is retried by the next frame instead of being remembered', async () => {
  let attempts = 0
  const test = harness({
    loadedHere: () => [loadedRow()],
    onUpdate: () => {
      attempts += 1
      if (attempts === 1) throw new Error('database is busy')
    }
  })

  test.observe(amsStatus([EMPTY_SLOT]))
  await test.settle()
  // Identical frame: it must NOT short-circuit, because the first pass never finished.
  test.observe(amsStatus([EMPTY_SLOT]))
  await test.settle()

  assert.equal(attempts, 2, 'the failed pass should be retried, not recorded as handled')
})

test('a completed pass short-circuits an identical frame', async () => {
  let queries = 0
  const test = harness({ loadedHere: () => { queries += 1; return [] } })

  test.observe(amsStatus([LOADED_SLOT]))
  await test.settle()
  test.observe(amsStatus([LOADED_SLOT]))
  await test.settle()

  assert.equal(queries, 1, 'an unchanged signature should skip the DB work')
})

test('frames for one printer are processed one at a time', async () => {
  // Two passes interleaving is what re-assigns a removed spool and unassigns the
  // present one, so overlap must be impossible rather than merely unlikely.
  let active = 0
  let maxActive = 0
  const test = harness({
    loadedHere: () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      return []
    },
    onUpdate: () => {}
  })
  stub(rootPrisma.filamentSpool, 'findMany', async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active -= 1
    return []
  })

  test.observe(amsStatus([LOADED_SLOT]))
  test.observe(amsStatus([EMPTY_SLOT]))
  await new Promise((resolve) => setTimeout(resolve, 40))

  assert.equal(maxActive, 1, 'two passes for one printer overlapped')
})
