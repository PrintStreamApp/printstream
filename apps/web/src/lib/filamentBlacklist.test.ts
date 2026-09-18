import assert from 'node:assert/strict'
import test from 'node:test'
import { findPrinterFilamentBlacklist, filamentBlacklistConsentSignature, type FilamentBlacklistEntry } from './filamentBlacklist.js'

function entry(printerId: string, trayIndex: number, message: string): FilamentBlacklistEntry {
  return {
    printerId,
    slots: [{
      trayIndex,
      slotLabel: `Tray ${trayIndex}`,
      prohibitions: [{ action: 'prohibition', message, wikiUrl: null }],
      warnings: []
    }]
  }
}

test('blacklist consent identity changes with printer, tray, or prohibition', () => {
  const baseline = filamentBlacklistConsentSignature([entry('printer-1', 0, 'Do not use TPU')])
  assert.notEqual(filamentBlacklistConsentSignature([entry('printer-2', 0, 'Do not use TPU')]), baseline)
  assert.notEqual(filamentBlacklistConsentSignature([entry('printer-1', 1, 'Do not use TPU')]), baseline)
  assert.notEqual(filamentBlacklistConsentSignature([entry('printer-1', 0, 'Do not use PET-CF')]), baseline)
})

test('print dialog grades the inventory identity behind a generic preset', () => {
  const status = { ams: [{ unitId: 0, type: 'ams', slots: [{ slot: 0, occupied: true, filamentType: 'PET-CF', trayUuid: null, trayInfoIdx: null, trayName: 'Generic PET-CF', color: '#000000', colors: [] }] }], externalSpools: [], nozzles: [], filamentTrackSwitch: null } as unknown as import('@printstream/shared').PrinterStatus
  const entry = findPrinterFilamentBlacklist('printer-1', 'P1S', status, [0], undefined, undefined, undefined,
    () => ({ spoolId: 'spool', brand: 'Bambu', filamentType: 'PET-CF', materialSubtype: 'PET-CF', colorName: 'Black' }))
  assert.ok(entry?.slots.some((slot) => slot.prohibitions.some((finding) => finding.message.includes('PET-CF'))))
})
