import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Printer } from '@printstream/shared'
import { makeOfflineStatus, parseReport } from './bambu-report-parser.js'

const printer: Printer = {
  id: 'printer-1',
  name: 'Aviato',
  host: '192.168.1.50',
  serial: 'SERIAL123',
  accessCode: 'secret',
  model: 'P1S',
  currentPlateType: null,
  currentNozzleDiameters: [],
  bridgeId: 'bridge-1',
  position: 0,
  createdAt: '2026-06-20T00:00:00.000Z',
  updatedAt: '2026-06-20T00:00:00.000Z'
}

test('makeOfflineStatus starts with no firmware modules', () => {
  assert.deepEqual(makeOfflineStatus(printer).firmwareModules, [])
})

test('parseReport extracts ota as firmwareVersion and every module as firmwareModules', () => {
  const delta = parseReport(
    {
      info: {
        command: 'get_version',
        module: [
          { name: 'ota', sw_ver: ' 01.09.00.00 ', hw_ver: 'OTA' },
          { name: 'ams/0', sw_ver: '00.00.06.49', hw_ver: 'AMS08' },
          { name: 'ams/1', sw_ver: '00.00.06.32', hw_ver: 'AMS08' },
          { name: 'mc', sw_ver: '00.00.30.04' }, // no hw_ver
          { name: 'rv1126', sw_ver: '' } // empty version: skipped
        ]
      }
    },
    printer
  )

  assert.equal(delta?.firmwareVersion, '01.09.00.00')
  assert.deepEqual(delta?.firmwareModules, [
    { name: 'ota', version: '01.09.00.00', hardwareVersion: 'OTA' },
    { name: 'ams/0', version: '00.00.06.49', hardwareVersion: 'AMS08' },
    { name: 'ams/1', version: '00.00.06.32', hardwareVersion: 'AMS08' },
    { name: 'mc', version: '00.00.30.04', hardwareVersion: null }
  ])
})

test('parseReport reports modules even when no ota entry is present', () => {
  const delta = parseReport(
    {
      info: {
        command: 'get_version',
        module: [{ name: 'ams/0', sw_ver: '00.00.06.49', hw_ver: 'AMS08' }]
      }
    },
    printer
  )

  // No ota module: leave firmwareVersion untouched (merge preserves prior), but
  // still surface the AMS module version.
  assert.equal('firmwareVersion' in (delta ?? {}), false)
  assert.deepEqual(delta?.firmwareModules, [
    { name: 'ams/0', version: '00.00.06.49', hardwareVersion: 'AMS08' }
  ])
})
