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

function slot(
  trayIndex: number,
  filamentType: string | null,
  color: string | null,
  remainPercent: number | null = 100,
  extras: Partial<QueueLoadedSlot> = {}
): QueueLoadedSlot {
  return { trayIndex, filamentType, color, remainPercent, occupied: true, nozzleId: null, ...extras }
}

function status(options: {
  online?: boolean
  stage?: PrinterStage
  ams?: Array<Record<string, unknown>>
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

test('display-type drift: a genuine tray naming the required preset matches despite differing type text', () => {
  // The SAME spool's declared type differs across Studio releases (2.7.1.57 writes Bambu PETG HF
  // as "PETG", 2.7.1.62 as "PETG-HF"), so the sliced plate and the AMS wire can legitimately
  // disagree. Identity (trayInfoIdx -> preset family vs the required preset name) must bridge it,
  // mirroring BambuStudio's mapping order (filament_id equality beats type text).
  const drifted = { ...required(1, 'PETG-HF', '#515151'), filamentName: 'Bambu PETG HF', nozzleId: 1 }
  const slots = [
    slot(1, 'PETG', '#515151', 100, { nozzleId: 1, trayInfoIdx: 'GFG02', trayUuid: 'B714F39048F54B0FB36D648919F732B4' })
  ]
  const match = evaluateQueueMatch([drifted], slots, EXACT)
  assert.equal(match.matched, true)
  assert.deepEqual(match.amsMapping, [1])
})

test('the -BASIC grade equals its base type; other granular grades stay distinct', () => {
  // Studio 2.7.1.62 writes granular types into sliced files ("PLA-BASIC" for Generic PLA) while
  // the AMS wire stays coarse ("PLA"). BASIC is the plain grade, so it must bridge without any
  // Bambu identity, but flow/fill-distinct grades (HF, CF) must NOT match a plain tray.
  const basic = { ...required(1, 'PLA-BASIC', '#000000'), filamentName: 'Generic PLA' }
  const plainTray = evaluateQueueMatch([basic], [slot(0, 'PLA', '#000000')], EXACT)
  assert.equal(plainTray.matched, true)
  assert.deepEqual(plainTray.amsMapping, [0])
  const hfOnPlain = evaluateQueueMatch(
    [{ ...required(1, 'PETG-HF', '#000000'), filamentName: 'Generic PETG HF' }],
    [slot(0, 'PETG', '#000000')],
    EXACT
  )
  assert.equal(hfOnPlain.matched, false)
})

test('display-type drift does NOT bridge to a non-genuine tray or a different material', () => {
  const drifted = { ...required(1, 'PETG-HF', '#515151'), filamentName: 'Bambu PETG HF' }
  // Same raw type text but no RFID identity: the type gate stays hard.
  const anonymous = evaluateQueueMatch([drifted], [slot(1, 'PETG', '#515151')], EXACT)
  assert.equal(anonymous.matched, false)
  // Genuine identity for a DIFFERENT preset family never bridges either.
  const otherPreset = evaluateQueueMatch(
    [drifted],
    [slot(1, 'PLA', '#515151', 100, { trayInfoIdx: 'GFA00', trayUuid: '61ADD0E49F1046B7BBFCBD5CAC034C9A' })],
    EXACT
  )
  assert.equal(otherPreset.matched, false)
})

test('a nozzle binding is hard: never auto-select across it, even for the only colour match', () => {
  // The only black PLA feeds the right extruder; the filament is bound to the left.
  const slots = [slot(0, 'PLA', '#000000', 100, { nozzleId: 0 })]
  const leftBound = { ...required(1, 'PLA', '#000000'), nozzleId: 1 }

  const strict = evaluateQueueMatch([leftBound], slots, EXACT)
  assert.equal(strict.matched, false)
  assert.deepEqual(strict.amsMapping, [-1])

  // The type-only fallback must not cross the binding either.
  assert.deepEqual(evaluateQueueMatch([leftBound], slots, TYPE_ONLY).amsMapping, [-1])

  // The same slot satisfies a right-bound (or unbound) filament.
  assert.deepEqual(evaluateQueueMatch([{ ...leftBound, nozzleId: 0 }], slots, EXACT).amsMapping, [0])
  assert.deepEqual(evaluateQueueMatch([{ ...leftBound, nozzleId: null }], slots, EXACT).amsMapping, [0])
})

test('a slot with no nozzle binding (Track Switch unit, single nozzle) is eligible for both extruders', () => {
  const slots = [slot(4, 'PLA', '#000000', 100, { nozzleId: null })]
  assert.deepEqual(evaluateQueueMatch([{ ...required(1, 'PLA', '#000000'), nozzleId: 0 }], slots, EXACT).amsMapping, [4])
  assert.deepEqual(evaluateQueueMatch([{ ...required(1, 'PLA', '#000000'), nozzleId: 1 }], slots, EXACT).amsMapping, [4])
})

test('an external spool keeps its extruder binding', () => {
  // 254 is the deputy/left extruder's spool on dual-nozzle machines.
  const slots = [slot(254, 'PETG', '#FFFFFF', null, { nozzleId: 1 })]
  assert.deepEqual(evaluateQueueMatch([{ ...required(1, 'PETG', '#FFFFFF'), nozzleId: 0 }], slots, EXACT).amsMapping, [-1])
  assert.deepEqual(evaluateQueueMatch([{ ...required(1, 'PETG', '#FFFFFF'), nozzleId: 1 }], slots, EXACT).amsMapping, [254])
})

test('AMS HT (N3S) slots match at their 128+ band tray index', () => {
  const slots = loadedSlotsFromStatus(status({
    ams: [{ unitId: 130, type: 'ams-ht', nozzleId: null, slots: [{ slot: 0, filamentType: 'PETG', color: '#00FF00', occupied: true }] }]
  }))
  assert.equal(slots[0]?.trayIndex, 130)
  assert.deepEqual(evaluateQueueMatch([required(1, 'PETG', '#00FF00')], slots, EXACT).amsMapping, [130])
})

test('exact ties prefer the emptiest slot that still holds enough, else the fullest', () => {
  // Two identical RFID spools: 800g and 100g remaining (percent * 10 convention).
  const slots = [
    slot(0, 'PLA', '#000000', 80, { trayUuid: 'A1B2C3' }),
    slot(1, 'PLA', '#000000', 10, { trayUuid: 'D4E5F6' })
  ]
  // Needs less than either holds → the emptier one, so partials get consumed first.
  assert.deepEqual(evaluateQueueMatch([{ ...required(1, 'PLA', '#000000'), usedGrams: 50 }], slots, EXACT).amsMapping, [1])
  // Needs more than the emptier one holds → the fuller one.
  assert.deepEqual(evaluateQueueMatch([{ ...required(1, 'PLA', '#000000'), usedGrams: 200 }], slots, EXACT).amsMapping, [0])
  // Needs more than both hold → the fullest, letting the insufficiency warning surface.
  assert.deepEqual(evaluateQueueMatch([{ ...required(1, 'PLA', '#000000'), usedGrams: 900 }], slots, EXACT).amsMapping, [0])
  // Headroom counts: 100g remaining is NOT enough for an 80g job (80 + 25 > 100).
  assert.deepEqual(evaluateQueueMatch([{ ...required(1, 'PLA', '#000000'), usedGrams: 80 }], slots, EXACT).amsMapping, [0])
  // No usage data → no sufficiency guard, deterministic tray order.
  assert.deepEqual(evaluateQueueMatch([required(1, 'PLA', '#000000')], slots, EXACT).amsMapping, [0])
})

test('remaining precedence: tracked-spool grams first; percent only for RFID trays; unknown beats known-insufficient', () => {
  // Tracked grams (60g) grade as sufficient and emptier than the RFID estimate (900g).
  const tracked = [
    slot(0, 'PLA', '#000000', 90, { trayUuid: 'A1B2C3' }),
    slot(1, 'PLA', '#000000', null, { remainingGrams: 60 })
  ]
  assert.deepEqual(evaluateQueueMatch([{ ...required(1, 'PLA', '#000000'), usedGrams: 30 }], tracked, EXACT).amsMapping, [1])

  // A third-party tray's percent is not trusted: it grades unknown, which outranks a
  // slot KNOWN to be too empty.
  const unknownVsInsufficient = [
    slot(0, 'PLA', '#000000', 5, { trayUuid: 'A1B2C3' }),
    slot(1, 'PLA', '#000000', 90)
  ]
  assert.deepEqual(evaluateQueueMatch([{ ...required(1, 'PLA', '#000000'), usedGrams: 100 }], unknownVsInsufficient, EXACT).amsMapping, [1])
})

test('AMS auto-refill pooling suppresses drain-the-smallest and grades combined remaining', () => {
  const pooledSlots = [
    slot(0, 'PLA', '#000000', 80, { trayUuid: 'A1B2C3', trayInfoIdx: 'GFA00' }),
    slot(1, 'PLA', '#000000', 10, { trayUuid: 'D4E5F6', trayInfoIdx: 'GFA00' })
  ]
  const needs50 = [{ ...required(1, 'PLA', '#000000'), usedGrams: 50 }]
  // Refill off → the emptier sufficient spool (drain partials first).
  assert.deepEqual(evaluateQueueMatch(needs50, pooledSlots, EXACT).amsMapping, [1])
  // Refill on → the printer chains the pool itself; no deliberate draining, tray order.
  assert.deepEqual(evaluateQueueMatch(needs50, pooledSlots, { ...EXACT, autoRefillEnabled: true }).amsMapping, [0])
  // The pool's combined remaining (900g) covers a job neither tray covers alone.
  assert.deepEqual(evaluateQueueMatch([{ ...required(1, 'PLA', '#000000'), usedGrams: 850 }], pooledSlots, { ...EXACT, autoRefillEnabled: true }).amsMapping, [0])
  // A partial spool OUTSIDE the pool still gets drained first when it suffices.
  const withSolo = [...pooledSlots, slot(2, 'PLA', '#000000', 12, { trayUuid: '0F0F0F', trayInfoIdx: 'GFA01' })]
  assert.deepEqual(evaluateQueueMatch(needs50, withSolo, { ...EXACT, autoRefillEnabled: true }).amsMapping, [2])
})

test('a genuine Bambu tray naming the required preset wins the tie; the genuine gate is not bypassed', () => {
  const bambuMatte = { ...required(1, 'PLA', '#000000'), filamentName: 'Bambu PLA Matte @BBL X1C' }
  // GFA01 = "Bambu PLA Matte". With an RFID tag the identity is genuine → preferred despite tray order.
  const genuine = [
    slot(0, 'PLA', '#000000'),
    slot(1, 'PLA', '#000000', 100, { trayUuid: 'A1B2C3', trayInfoIdx: 'GFA01' })
  ]
  assert.deepEqual(evaluateQueueMatch([bambuMatte], genuine, EXACT).amsMapping, [1])
  // A user-assigned Bambu preset id on an untagged spool claims nothing → plain tray order.
  const untagged = [
    slot(0, 'PLA', '#000000'),
    slot(1, 'PLA', '#000000', 100, { trayInfoIdx: 'GFA01' })
  ]
  assert.deepEqual(evaluateQueueMatch([bambuMatte], untagged, EXACT).amsMapping, [0])
})

test('loadedSlotsFromStatus flattens AMS units and external spools to tray indices', () => {
  const slots = loadedSlotsFromStatus(status({
    ams: [{ unitId: 1, nozzleId: 0, slots: [{ slot: 2, filamentType: 'PLA', color: '#111111', remainPercent: 40, occupied: true, trayUuid: 'A1B2', trayInfoIdx: 'GFA00' }] }],
    externalSpools: [{ amsId: 255, nozzleId: 0, filamentType: 'PETG', color: '#222222', remainPercent: null }]
  }))
  // AMS tray index = unitId * 4 + slot; the unit's nozzle binding and tray identity ride along.
  assert.equal(slots[0]?.trayIndex, 6)
  assert.equal(slots[0]?.filamentType, 'PLA')
  assert.equal(slots[0]?.nozzleId, 0)
  assert.equal(slots[0]?.trayUuid, 'A1B2')
  assert.equal(slots[0]?.trayInfoIdx, 'GFA00')
  // External spool keeps its virtual tray id, nozzle, and is occupied when it has a type.
  assert.equal(slots[1]?.trayIndex, 255)
  assert.equal(slots[1]?.occupied, true)
  assert.equal(slots[1]?.nozzleId, 0)
})

test('loadedSlotsFromStatus clears the nozzle binding of a unit behind a Filament Track Switch', () => {
  const slots = loadedSlotsFromStatus(status({
    ams: [{ unitId: 0, nozzleId: 0, switchInput: 'A', slots: [{ slot: 0, filamentType: 'PLA', color: '#111111', occupied: true }] }]
  }))
  // The unit is reachable by BOTH extruders, so it must not be filtered out for either side.
  assert.equal(slots[0]?.nozzleId, null)
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

  // A partial link is rejected, both ids are required to link an order print.
  assert.equal(queueItemCreateSchema.safeParse({ libraryFileId: 'f', orderLink: { orderId: 'o' } }).success, false)
})

// A queued mapping is dispatched through the same command builder as a print-dialog one, so
// the two boundaries validated different things: this one accepted any integer and forwarded
// out-of-band tray indices to a printer unchecked, while the dispatch one rejected the `-1`
// the queue's own matcher emits for a slot it could not fill.
test('queueAmsMappingSchema accepts the unmapped sentinel and rejects a bogus tray index', () => {
  const parse = (amsMapping: number[]) =>
    queueItemCreateSchema.safeParse({ libraryFileId: 'file-1', amsMapping }).success

  // What `evaluateQueueMatch` produces for a partly-matched plate.
  assert.equal(parse([0, -1, 255]), true)
  assert.equal(parse([128, 152]), true)
  // Previously forwarded to the printer as-is.
  assert.equal(parse([160]), false)
  assert.equal(parse([-2]), false)
  assert.equal(parse([1.5]), false)
})
