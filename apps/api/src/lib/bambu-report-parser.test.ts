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

test('parseReport parses Filament Track Switch state (aux bit 29 + device.fila_switch)', () => {
  const delta = parseReport(
    {
      print: {
        aux: '20000000', // bit 29 set: FTS installed
        device: {
          fila_switch: {
            // Index 0 is the switch's B side, index 1 the A side (BambuStudio
            // DevFilaSwitch::ParseFilaSwitchInfo). Entries pack (ams_id<<8)|slot.
            in: [(2 << 8) | 1, (128 << 8) | 0],
            out: [1, 0],
            stat: 1,
            info: 1
          }
        }
      }
    },
    printer
  )

  assert.deepEqual(delta?.filamentTrackSwitch, {
    installed: true,
    inputA: { amsId: 128, slotId: 0 },
    inputB: { amsId: 2, slotId: 1 },
    outputAExtruderId: 0,
    outputBExtruderId: 1,
    calibrating: true,
    filamentPresent: true
  })
})

test('parseReport treats -1 inputs and 0xE outputs as disconnected FTS ports', () => {
  const delta = parseReport(
    {
      print: {
        aux: '20000000',
        device: { fila_switch: { in: [-1, (0 << 8) | 3], out: [0xe, 1], stat: 0, info: 0 } }
      }
    },
    printer
  )
  assert.deepEqual(delta?.filamentTrackSwitch, {
    installed: true,
    inputA: { amsId: 0, slotId: 3 },
    inputB: null,
    outputAExtruderId: 1,
    outputBExtruderId: null,
    calibrating: false,
    filamentPresent: false
  })
})

test('parseReport leaves filamentTrackSwitch untouched without an FTS signal and clears it on removal', () => {
  // Fleet case: plain aux with bit 29 unset, no fila_switch json -> no delta key.
  const none = parseReport({ print: { aux: '0' } }, printer)
  assert.equal('filamentTrackSwitch' in (none ?? {}), false)

  // A previously tracked switch that disappears is cleared to null.
  const current = {
    ...makeOfflineStatus(printer),
    filamentTrackSwitch: {
      installed: true,
      inputA: null,
      inputB: null,
      outputAExtruderId: null,
      outputBExtruderId: null,
      calibrating: false,
      filamentPresent: null
    }
  }
  const removed = parseReport({ print: { aux: '0' } }, printer, current)
  assert.equal(removed?.filamentTrackSwitch, null)

  // An aux-only delta with the bit still set keeps previous connection state.
  const withConnections = {
    ...current,
    filamentTrackSwitch: { ...current.filamentTrackSwitch, inputA: { amsId: 128, slotId: 0 } }
  }
  const kept = parseReport({ print: { aux: '20000000' } }, printer, withConnections)
  assert.deepEqual(kept?.filamentTrackSwitch?.inputA, { amsId: 128, slotId: 0 })
})

test('parseReport derives AmsUnit.switchInput from info bits 24-27 when routed via the FTS', () => {
  const delta = parseReport(
    {
      print: {
        ams: {
          ams: [
            // Extruder nibble (bits 8-11) = 0xE: bound through the switch;
            // bits 24-27 name the input (0 = B, 1 = A).
            { id: 0, info: '01000e01', tray: [{ id: 0 }] },
            { id: 1, info: '00000e01', tray: [{ id: 0 }] },
            { id: 2, info: '1', tray: [{ id: 0 }] }
          ]
        }
      }
    },
    printer
  )

  const viaA = delta?.ams?.find((unit) => unit.unitId === 0)
  const viaB = delta?.ams?.find((unit) => unit.unitId === 1)
  const direct = delta?.ams?.find((unit) => unit.unitId === 2)
  assert.equal(viaA?.switchInput, 'A')
  assert.equal(viaA?.nozzleId, null)
  assert.equal(viaB?.switchInput, 'B')
  assert.equal(direct?.switchInput, null)
  assert.equal(direct?.nozzleId, 0)
})
