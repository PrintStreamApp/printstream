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

test('parseReport resolves AMS unit type from the info DevAmsType code', () => {
  // `info` bits 0-3 carry the DevAmsType code: 1 = classic AMS, 4 = N3S (AMS HT).
  // The H2C/H2D number AMS HT units from 128, and their global tray index is the
  // unit id itself — so the type must survive onto the normalized unit.
  const delta = parseReport(
    {
      print: {
        ams: {
          ams: [
            { id: 0, info: '1', tray: [{ id: 0 }] },
            { id: 128, info: '4', tray: [{ id: 0 }] }
          ]
        }
      }
    },
    printer
  )

  const classic = delta?.ams?.find((unit) => unit.unitId === 0)
  const ht = delta?.ams?.find((unit) => unit.unitId === 128)
  assert.equal(classic?.type, 'ams')
  assert.equal(ht?.type, 'ams-ht')
})

test('parseReport preserves a resolved AMS type when a later delta omits info', () => {
  const first = parseReport(
    { print: { ams: { ams: [{ id: 128, info: '4', tray: [{ id: 0 }] }] } } },
    printer
  )
  const current = { ...makeOfflineStatus(printer), ams: first?.ams ?? [] }
  // A follow-up report without `info` must not downgrade the type to 'unknown'.
  const second = parseReport(
    { print: { ams: { ams: [{ id: 128, tray: [{ id: 0 }] }] } } },
    printer,
    current
  )
  assert.equal(second?.ams?.find((unit) => unit.unitId === 128)?.type, 'ams-ht')
})

test('parseReport parses the H2C nozzle rack (mounted + parked hotends)', () => {
  const delta = parseReport(
    {
      print: {
        device: {
          // id low nibble = nozzle id; next nibble = parked-in-rack flag.
          nozzle: {
            info: [
              { id: 0, diameter: 0.4, type: 'hardened_steel' },
              { id: 0x11, diameter: 0.6, type: 'stainless_steel' }
            ]
          },
          holder: { stat: 0, pos: 3 }
        }
      }
    },
    printer
  )

  const rack = delta?.nozzleRack
  assert.equal(rack?.status, 'idle')
  assert.equal(rack?.position, 'centre')
  assert.equal(rack?.nozzles.length, 2)
  // Mounted nozzle sorts before the parked one.
  assert.deepEqual(
    rack?.nozzles.map((nozzle) => ({ id: nozzle.nozzleId, onRack: nozzle.onRack, diameter: nozzle.diameter, material: nozzle.material })),
    [
      { id: 0, onRack: false, diameter: '0.4', material: 'hardened-steel' },
      { id: 1, onRack: true, diameter: '0.6', material: 'stainless-steel' }
    ]
  )
})

test('parseReport leaves nozzleRack null for a printer with no rack markers', () => {
  const delta = parseReport(
    { print: { device: { nozzle: { info: [{ id: 0, diameter: 0.4, type: 'hardened_steel' }] } } } },
    printer
  )
  // A plain nozzle list with no parked nozzle and no holder is not a rack.
  assert.equal('nozzleRack' in (delta ?? {}), false)
})

test('makeOfflineStatus starts with skippedObjectIds unknown (null)', () => {
  assert.equal(makeOfflineStatus(printer).skippedObjectIds, null)
})

test('parseReport parses s_obj into skippedObjectIds, tolerating string entries', () => {
  const delta = parseReport({ print: { s_obj: [153, '154', 'not-a-number', null] } }, printer)
  assert.deepEqual(delta?.skippedObjectIds, [153, 154])
})

test('parseReport applies an empty s_obj as "nothing skipped" but ignores a malformed one', () => {
  // [] is a real state-bearing report (firmware supports partskip, nothing skipped)...
  const empty = parseReport({ print: { s_obj: [] } }, printer)
  assert.deepEqual(empty?.skippedObjectIds, [])
  // ...whereas a non-array value or an absent field must not touch the merged status,
  // mirroring the sdCardPresent init/merge semantics (null until first reported).
  const malformed = parseReport({ print: { s_obj: 'nope', mc_percent: 10 } }, printer)
  assert.equal('skippedObjectIds' in (malformed ?? {}), false)
  const absent = parseReport({ print: { mc_percent: 10 } }, printer)
  assert.equal('skippedObjectIds' in (absent ?? {}), false)
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
