import assert from 'node:assert/strict'
import test from 'node:test'
import { filamentBlacklistConsentSignature, type FilamentBlacklistEntry } from './filamentBlacklist.js'

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
