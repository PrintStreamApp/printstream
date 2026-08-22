/**
 * The AMS spool swap, replayed from real printer traffic.
 *
 * `__fixtures__/ams-spool-swap.capture.json` is three `print.ams` blocks lifted verbatim
 * from a bridge debug capture of an H2D with two AMS units: a tagged Bambu spool loaded
 * in unit 0 slot 3, that spool removed, then an untagged one inserted in its place.
 *
 * Worth having because the synthetic tests next door encode what we BELIEVE a report
 * looks like, and several of those beliefs turned out to be wrong. In particular this
 * firmware always sends the complete four-tray list per unit and strips a removed slot's
 * object to `{id, state}` rather than omitting it or leaving stale RFID data on it — so
 * the shapes the hand-written tests exercise are not the shapes the printer sends.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { Printer, PrinterStatus } from '@printstream/shared'
import { makeOfflineStatus, parseReport } from './bambu-report-parser.js'

interface CaptureFrame {
  at: string
  ams: Record<string, unknown>
}

const frames: CaptureFrame[] = JSON.parse(
  readFileSync(new URL('./__fixtures__/ams-spool-swap.capture.json', import.meta.url), 'utf8')
) as CaptureFrame[]

const printer: Printer = {
  id: 'printer-1',
  name: 'Home',
  host: '192.168.1.50',
  serial: 'SERIAL123',
  accessCode: 'secret',
  model: 'H2D',
  currentPlateType: null,
  currentNozzleDiameters: [],
  bridgeId: 'bridge-1',
  position: 0,
  createdAt: '2026-06-20T00:00:00.000Z',
  updatedAt: '2026-06-20T00:00:00.000Z'
}

/** Feed the captured frames through the parser in order, exactly as the manager does. */
function replay(): PrinterStatus[] {
  let status = makeOfflineStatus(printer)
  return frames.map((frame) => {
    const delta = parseReport({ print: { ams: frame.ams } }, printer, status)
    status = { ...status, ...delta }
    return status
  })
}

const swappedSlot = (status: PrinterStatus) =>
  status.ams.find((unit) => unit.unitId === 0)?.slots.find((slot) => slot.slot === 3)

test('replaying a real spool swap clears the slot and then marks it occupied again', () => {
  const [loaded, removed, reinserted] = replay()

  // Frame 1 — the tagged spool, `tray_exist_bits: "ff"` (both units full).
  assert.equal(swappedSlot(loaded!)?.occupied, true)
  assert.equal(swappedSlot(loaded!)?.filamentType, 'PLA')
  assert.equal(swappedSlot(loaded!)?.trayInfoIdx, 'GFA10')
  assert.equal(swappedSlot(loaded!)?.trayUuid, 'CBB9BB03DF524B5780C5C048F0F6EF67')

  // Frame 2 — removed. The bits drop to "f7" (bit 3 clear) and the tray object is
  // stripped to `{id, state}`, so every identity field has to come from the bit rather
  // than from the payload contradicting itself.
  assert.equal(swappedSlot(removed!)?.occupied, false)
  assert.equal(swappedSlot(removed!)?.filamentType, null)
  assert.equal(swappedSlot(removed!)?.trayInfoIdx, null)
  assert.equal(swappedSlot(removed!)?.trayUuid, null)
  assert.equal(swappedSlot(removed!)?.color, null)
  assert.equal(swappedSlot(removed!)?.remainPercent, null)

  // Frame 3 — an untagged spool in the same slot. The bit comes back but the printer
  // reports no identity for it at all, which is the third-party placeholder state:
  // occupied, nothing known. It must NOT inherit the removed spool's identity.
  assert.equal(swappedSlot(reinserted!)?.occupied, true)
  assert.equal(swappedSlot(reinserted!)?.filamentType, null)
  assert.equal(swappedSlot(reinserted!)?.trayUuid, null)
})

test('the swap never disturbs the printer\'s other AMS unit', () => {
  // The exist bitmap is one device-wide value ("ff" -> "f7" -> "ff"), so a change in
  // unit 0 is read out of the same string as unit 1's slots. Getting the band wrong
  // reads a neighbour's bit, which is how a sweep could empty the wrong unit.
  for (const status of replay()) {
    const unitOne = status.ams.find((unit) => unit.unitId === 1)
    assert.equal(unitOne?.slots.length, 4)
    assert.ok(unitOne?.slots.every((slot) => slot.occupied === true), 'unit 1 stayed fully loaded throughout')
  }
})

test('a tagged tray reports tag_uid and tray_uuid together', () => {
  // Our RFID gate reads `tray_uuid`; BambuStudio's `IsBBL_Filament` reads `tag_uid`.
  // Across the whole capture the two never disagreed about being real-vs-zero, which is
  // why gating on the field we picked has worked. Pinned here so a future capture that
  // DOES disagree shows up as a failure rather than as silently wrong labels.
  const trays = frames.flatMap((frame) => {
    const units = frame.ams.ams as Array<{ tray?: Array<Record<string, unknown>> }>
    return units.flatMap((unit) => unit.tray ?? [])
  })
  const isReal = (value: unknown) => typeof value === 'string' && !/^0*$/.test(value)

  assert.ok(trays.length > 0)
  for (const tray of trays) {
    assert.equal(
      isReal(tray.tag_uid),
      isReal(tray.tray_uuid),
      `tag_uid and tray_uuid disagree for tray ${String(tray.id)}`
    )
  }
})
