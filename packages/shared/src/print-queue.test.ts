import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  describeMissingFilaments,
  evaluateQueueItemForPrinter,
  evaluateQueueMatch,
  evaluateQueuePlacementConstraints,
  loadedSlotsFromStatus,
  normalizeHexColor,
  queueDispatchSchema,
  queueItemCreateSchema,
  summarizeQueueItemEligibility,
  type QueueItemPlacement,
  type QueueLoadedSlot,
  type QueuePrinterContext,
  type QueueRequiredFilament
} from './print-queue.js'
import type { PrinterStage, PrinterStatus } from './printer.js'

const EXACT = { allowTypeOnlyMatch: false }
const TYPE_ONLY = { allowTypeOnlyMatch: true }

function slot(trayIndex: number, filamentType: string | null, color: string | null, remainPercent: number | null = 100): QueueLoadedSlot {
  return { trayIndex, filamentType, color, remainPercent, occupied: true }
}

function status(options: {
  online?: boolean
  stage?: PrinterStage
  ams?: Array<{ unitId: number; slots: Array<Record<string, unknown>> }>
  externalSpools?: Array<Record<string, unknown>>
}): PrinterStatus {
  return {
    online: options.online ?? true,
    stage: options.stage ?? 'idle',
    ams: options.ams ?? [],
    externalSpools: options.externalSpools ?? []
  } as unknown as PrinterStatus
}

function placement(overrides: Partial<QueueItemPlacement> = {}): QueueItemPlacement {
  return {
    targetKind: 'any',
    targetPrinterId: null,
    targetModel: null,
    requiredFilaments: [],
    compatibleModels: [],
    ...overrides
  }
}

function required(id: number, filamentType: string | null, color: string | null): QueueRequiredFilament {
  return { id, filamentType, color }
}

test('normalizeHexColor normalizes case, hash, and trailing alpha', () => {
  assert.equal(normalizeHexColor('1a1a1a'), '#1A1A1A')
  assert.equal(normalizeHexColor('#abcdefff'), '#ABCDEF')
  assert.equal(normalizeHexColor(' #fff000 '), '#FFF000')
  assert.equal(normalizeHexColor('not-a-color'), null)
  assert.equal(normalizeHexColor(null), null)
})

test('evaluateQueueMatch is unconstrained when nothing is required', () => {
  const result = evaluateQueueMatch([], [slot(0, 'PLA', '#000000')], EXACT)
  assert.equal(result.matched, true)
  assert.deepEqual(result.amsMapping, [])
  assert.deepEqual(result.missing, [])
})

test('evaluateQueueMatch maps each filament id to a matching tray index', () => {
  const result = evaluateQueueMatch(
    [required(1, 'PLA', '#FF0000'), required(2, 'PETG', '#00FF00')],
    [slot(2, 'PETG', '#00FF00'), slot(0, 'PLA', '#FF0000')],
    EXACT
  )
  assert.equal(result.matched, true)
  // amsMapping is indexed by (filament.id - 1).
  assert.deepEqual(result.amsMapping, [0, 2])
})

test('evaluateQueueMatch blocks on color mismatch unless type-only is allowed', () => {
  const required1 = [required(1, 'PLA', '#FF0000')]
  const slots = [slot(0, 'PLA', '#0000FF')]

  const strict = evaluateQueueMatch(required1, slots, EXACT)
  assert.equal(strict.matched, false)
  assert.deepEqual(strict.amsMapping, [-1])
  assert.equal(strict.missing.length, 1)

  const typeOnly = evaluateQueueMatch(required1, slots, TYPE_ONLY)
  assert.equal(typeOnly.matched, true)
  assert.deepEqual(typeOnly.amsMapping, [0])
})

test('evaluateQueueMatch treats a null required color as no color constraint', () => {
  const result = evaluateQueueMatch([required(1, 'PLA', null)], [slot(3, 'PLA', '#123456')], EXACT)
  assert.equal(result.matched, true)
  assert.deepEqual(result.amsMapping, [3])
})

test('evaluateQueueMatch reports a missing filament when no type matches', () => {
  const result = evaluateQueueMatch([required(1, 'ABS', '#FFFFFF')], [slot(0, 'PLA', '#FFFFFF')], TYPE_ONLY)
  assert.equal(result.matched, false)
  assert.deepEqual(result.missing, [required(1, 'ABS', '#FFFFFF')])
})

test('loadedSlotsFromStatus flattens AMS units and external spools to tray indices', () => {
  const slots = loadedSlotsFromStatus(status({
    ams: [{ unitId: 1, slots: [{ slot: 2, filamentType: 'PLA', color: '#111111', remainPercent: 40, occupied: true }] }],
    externalSpools: [{ amsId: 255, filamentType: 'PETG', color: '#222222', remainPercent: null }]
  }))
  // AMS tray index = unitId * 4 + slot.
  assert.equal(slots[0]?.trayIndex, 6)
  assert.equal(slots[0]?.filamentType, 'PLA')
  // External spool keeps its virtual tray id and is occupied when it has a type.
  assert.equal(slots[1]?.trayIndex, 255)
  assert.equal(slots[1]?.occupied, true)
})

test('evaluateQueueItemForPrinter respects a printer pin', () => {
  const printer: QueuePrinterContext = { printerId: 'p1', model: 'X1C', status: status({}) }
  const result = evaluateQueueItemForPrinter(placement({ targetKind: 'printer', targetPrinterId: 'p2' }), printer, EXACT)
  assert.equal(result.eligible, false)
  assert.match(result.reason ?? '', /different printer/i)
})

test('evaluateQueueItemForPrinter respects a model pin', () => {
  const printer: QueuePrinterContext = { printerId: 'p1', model: 'A1', status: status({}) }
  const result = evaluateQueueItemForPrinter(placement({ targetKind: 'model', targetModel: 'X1C' }), printer, EXACT)
  assert.equal(result.eligible, false)
  assert.match(result.reason ?? '', /X1C/)
})

test('evaluateQueueItemForPrinter rejects a printer whose model the sliced file is not compatible with', () => {
  const printer: QueuePrinterContext = { printerId: 'p1', model: 'P1S', status: status({}) }
  const result = evaluateQueueItemForPrinter(placement({ compatibleModels: ['H2D'] }), printer, EXACT)
  assert.equal(result.eligible, false)
  assert.match(result.reason ?? '', /Sliced for H2D/)
})

test('evaluateQueueItemForPrinter allows a model the file is compatible with', () => {
  const printer: QueuePrinterContext = { printerId: 'p1', model: 'H2D', status: status({}) }
  const result = evaluateQueueItemForPrinter(placement({ compatibleModels: ['H2D'] }), printer, EXACT)
  assert.equal(result.eligible, true)
})

test('evaluateQueueItemForPrinter marks an offline printer ineligible', () => {
  const printer: QueuePrinterContext = { printerId: 'p1', model: 'X1C', status: status({ online: false }) }
  const result = evaluateQueueItemForPrinter(placement(), printer, EXACT)
  assert.equal(result.eligible, false)
  assert.match(result.reason ?? '', /offline/i)
})

test('evaluateQueueItemForPrinter computes idle from the active-job stage', () => {
  const item = placement({ requiredFilaments: [required(1, 'PLA', '#FF0000')] })
  const ams = [{ unitId: 0, slots: [{ slot: 0, filamentType: 'PLA', color: '#FF0000', occupied: true }] }]

  const idle = evaluateQueueItemForPrinter(item, { printerId: 'p1', model: 'X1C', status: status({ stage: 'idle', ams }) }, EXACT)
  assert.equal(idle.eligible, true)
  assert.equal(idle.idle, true)
  assert.deepEqual(idle.amsMapping, [0])

  const busy = evaluateQueueItemForPrinter(item, { printerId: 'p1', model: 'X1C', status: status({ stage: 'printing', ams }) }, EXACT)
  assert.equal(busy.eligible, true)
  assert.equal(busy.idle, false)
})

test('summarizeQueueItemEligibility recommends the first idle eligible printer', () => {
  const item = placement({ requiredFilaments: [required(1, 'PLA', '#FF0000')] })
  const ams = [{ unitId: 0, slots: [{ slot: 0, filamentType: 'PLA', color: '#FF0000', occupied: true }] }]
  const busy: QueuePrinterContext = { printerId: 'busy', model: 'X1C', status: status({ stage: 'printing', ams }) }
  const idle: QueuePrinterContext = { printerId: 'idle', model: 'X1C', status: status({ stage: 'idle', ams }) }

  const summary = summarizeQueueItemEligibility(item, [busy, idle], EXACT)
  assert.deepEqual(summary.eligiblePrinterIds.sort(), ['busy', 'idle'])
  assert.deepEqual(summary.idlePrinterIds, ['idle'])
  assert.equal(summary.recommendedPrinterId, 'idle')
  assert.deepEqual(summary.recommendedAmsMapping, [0])
  assert.equal(summary.blocked, false)
})

test('summarizeQueueItemEligibility flags waiting-for-free-printer when all eligible printers are busy', () => {
  const item = placement({ requiredFilaments: [required(1, 'PLA', '#FF0000')] })
  const ams = [{ unitId: 0, slots: [{ slot: 0, filamentType: 'PLA', color: '#FF0000', occupied: true }] }]
  const busy: QueuePrinterContext = { printerId: 'busy', model: 'X1C', status: status({ stage: 'printing', ams }) }

  const summary = summarizeQueueItemEligibility(item, [busy], EXACT)
  assert.equal(summary.blocked, false)
  assert.equal(summary.waitingForFreePrinter, true)
  assert.equal(summary.recommendedPrinterId, 'busy')
})

test('summarizeQueueItemEligibility blocks with a material reason when nothing matches', () => {
  const item = placement({ requiredFilaments: [required(1, 'PLA', '#1A1A1A')] })
  const wrongColor: QueuePrinterContext = {
    printerId: 'p1',
    model: 'X1C',
    status: status({ ams: [{ unitId: 0, slots: [{ slot: 0, filamentType: 'PLA', color: '#FFFFFF', occupied: true }] }] })
  }

  const summary = summarizeQueueItemEligibility(item, [wrongColor], EXACT)
  assert.equal(summary.blocked, true)
  assert.equal(summary.recommendedPrinterId, null)
  assert.match(summary.blockedReason ?? '', /Needs PLA #1A1A1A/)
})

test('evaluateQueuePlacementConstraints passes despite a material mismatch (the manual-override path)', () => {
  const item = placement({ requiredFilaments: [required(1, 'PLA', '#FF0000')] })
  const printer: QueuePrinterContext = {
    printerId: 'p1',
    model: 'X1C',
    status: status({ ams: [{ unitId: 0, slots: [{ slot: 0, filamentType: 'PETG', color: '#00FF00', occupied: true }] }] })
  }
  // The full matcher blocks on the wrong material...
  assert.equal(evaluateQueueItemForPrinter(item, printer, EXACT).eligible, false)
  // ...but placement alone is fine, since the user picks the slot in the start dialog.
  const constraints = evaluateQueuePlacementConstraints(item, printer)
  assert.equal(constraints.eligible, true)
  assert.equal(constraints.idle, true)
  assert.equal(constraints.reason, null)
})

test('evaluateQueuePlacementConstraints still enforces pins, sliced-model, and online/idle', () => {
  assert.equal(
    evaluateQueuePlacementConstraints(placement({ targetKind: 'printer', targetPrinterId: 'p2' }), { printerId: 'p1', model: 'X1C', status: status({}) }).eligible,
    false
  )
  assert.equal(
    evaluateQueuePlacementConstraints(placement({ compatibleModels: ['H2D'] }), { printerId: 'p1', model: 'X1C', status: status({}) }).eligible,
    false
  )
  const offline = evaluateQueuePlacementConstraints(placement(), { printerId: 'p1', model: 'X1C', status: status({ online: false }) })
  assert.equal(offline.eligible, false)
  assert.equal(offline.idle, false)
  assert.equal(evaluateQueuePlacementConstraints(placement(), { printerId: 'p1', model: 'X1C', status: status({ stage: 'printing' }) }).idle, false)
})

test('queueDispatchSchema requires a printer when an AMS override is supplied', () => {
  assert.equal(queueDispatchSchema.safeParse({}).success, true)
  assert.equal(queueDispatchSchema.safeParse({ printerId: 'p1' }).success, true)
  assert.equal(queueDispatchSchema.safeParse({ printerId: 'p1', amsMapping: [0, 4] }).success, true)
  assert.equal(queueDispatchSchema.safeParse({ amsMapping: [0, 4] }).success, false)
})

test('describeMissingFilaments lists type and color', () => {
  assert.equal(describeMissingFilaments([required(1, 'PLA', '#1A1A1A'), required(2, 'PETG', null)]), 'PLA #1A1A1A, PETG')
})

test('summarizeQueueItemEligibility exposes structured missing filaments for a material block only', () => {
  const printer: QueuePrinterContext = {
    printerId: 'p1',
    model: 'X1C',
    status: status({ ams: [{ unitId: 0, slots: [{ slot: 0, filamentType: 'PLA', color: '#FFFFFF', occupied: true }] }] })
  }
  // Material block → the missing required filament is exposed structurally (for the rich "Needs ..." chip).
  const material = summarizeQueueItemEligibility(placement({ requiredFilaments: [required(1, 'PLA', '#1A1A1A')] }), [printer], EXACT)
  assert.equal(material.blocked, true)
  assert.deepEqual(material.missingFilaments.map((filament) => filament.color), ['#1A1A1A'])
  // A non-material block (sliced for a different model) leaves it empty.
  const model = summarizeQueueItemEligibility(placement({ compatibleModels: ['H2D'] }), [printer], EXACT)
  assert.equal(model.blocked, true)
  assert.deepEqual(model.missingFilaments, [])
})

test('queueItemCreateSchema accepts an optional order link', () => {
  const withoutLink = queueItemCreateSchema.parse({ libraryFileId: 'file-1', plate: 1 })
  assert.equal(withoutLink.orderLink, undefined)

  const linked = queueItemCreateSchema.parse({
    libraryFileId: 'file-1',
    plate: 2,
    orderLink: { orderId: 'order-1', orderPrintId: 'print-1' }
  })
  assert.deepEqual(linked.orderLink, { orderId: 'order-1', orderPrintId: 'print-1' })

  // A partial link is rejected — both ids are required to link an order print.
  assert.equal(queueItemCreateSchema.safeParse({ libraryFileId: 'f', orderLink: { orderId: 'o' } }).success, false)
})
