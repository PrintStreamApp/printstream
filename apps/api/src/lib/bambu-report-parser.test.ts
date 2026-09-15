import assert from 'node:assert/strict'
import { test } from 'node:test'
import { printerStatusSchema, type Printer, type PrinterStatus } from '@printstream/shared'
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
  // unit id itself, so the type must survive onto the normalized unit.
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

test('parseReport exposes live print-start storage and external-change capabilities', () => {
  const delta = parseReport({
    print: {
      // fun bits 28 and 48: internal timelapse storage and external spool change assist.
      fun: '1000010000000'
    }
  }, printer)

  assert.equal(delta?.printStartOptions?.vibrationCompensation.supported, false)
  assert.equal(delta?.printStartOptions?.internalTimelapseStorage.supported, true)
  assert.equal(delta?.printStartOptions?.externalFilamentChangeAssist.supported, true)
})

test('parseReport decodes capability-gated persistent print settings', () => {
  const delta = parseReport({
    print: {
      fun: '4000000000001000',
      fun2: 'E014',
      cfg: '10A100280018',
      xcam: {
        cfg: (1 << 20) | (1 << 21) | (1 << 22),
        buildplate_marker_detector: true
      },
      ipcam: {
        ipcam_record: 'enable',
        resolution: '1080p',
        resolution_supported: ['720p', '1080p']
      }
    }
  }, { ...printer, model: 'H2D' })

  const options = delta?.printOptions
  assert.equal(options?.foreignObjectDetection.enabled, true)
  assert.equal(options?.printedPartDisplacementDetection.enabled, true)
  assert.equal(options?.buildPlateTypeDetection.enabled, true)
  assert.equal(options?.buildPlateAlignmentDetection.enabled, true)
  assert.equal(options?.idleHeatingProtection.enabled, true)
  assert.equal(options?.purifyAirAtPrintEnd.current, 'exhaust')
  assert.equal(options?.openDoorDetection.current, 'pause')
  assert.equal(options?.smartNozzleBlobDetection.current, 'auto')
  assert.equal(options?.printStatusSnapshot.enabled, true)
  assert.equal(options?.storeSentFilesOnExternalStorage.enabled, true)
  assert.equal(options?.cameraAutoRecord.enabled, true)
  assert.deepEqual(options?.cameraResolution, {
    supported: true,
    current: '1080p',
    available: ['720p', '1080p']
  })
})

test('packed setting values do not advertise unsupported printer controls', () => {
  const delta = parseReport({
    print: {
      // cfg bit 23 is the current filament-tangle value. Studio requires the
      // separate fun bit 9 before it offers the setting to the user.
      cfg: '800000',
      fun: '0',
      xcam: {
        // Detection values likewise do not prove the individual controls exist.
        cfg: (1 << 7) | (1 << 10) | (1 << 13) | (1 << 16)
      }
    }
  }, { ...printer, model: 'H2D' })

  const options = delta?.printOptions
  assert.equal(options?.filamentTangleDetection.enabled, true)
  assert.equal(options?.filamentTangleDetection.supported, false)
  assert.equal(options?.firstLayerInspection.supported, false)
  assert.equal(options?.autoRecovery.supported, true)
  assert.equal(options?.spaghettiDetection.supported, false)
  assert.equal(options?.purgeChutePileupDetection.supported, false)
  assert.equal(options?.nozzleClumpingDetection.supported, false)
  assert.equal(options?.airPrintingDetection.supported, false)
})

test('model resources distinguish first-layer inspection from step-loss recovery', () => {
  const h2d = parseReport({
    print: {
      fun: '20',
      xcam: { first_layer_inspector: true }
    }
  }, { ...printer, model: 'H2D' })
  const x1c = parseReport({ print: {} }, { ...printer, model: 'X1C' })

  // fun bit 5 is not a first-layer capability bit. Studio reads both settings
  // from its model resource, where H2D has recovery but no first-layer check.
  assert.equal(h2d?.printOptions?.firstLayerInspection.supported, false)
  assert.equal(h2d?.printOptions?.autoRecovery.supported, true)
  assert.equal(x1c?.printOptions?.firstLayerInspection.supported, true)
  assert.equal(x1c?.printOptions?.autoRecovery.supported, false)
})

test('get_version reapplies firmware-specific Studio print-option capabilities', () => {
  const x1c = { ...printer, model: 'X1C' as const }
  const current = makeOfflineStatus(x1c)
  current.printOptions.autoRecovery.enabled = true

  const delta = parseReport({
    info: {
      command: 'get_version',
      module: [{ name: 'ota', sw_ver: '01.01.01.00', hw_ver: 'OTA' }]
    }
  }, x1c, current)

  assert.equal(delta?.firmwareVersion, '01.01.01.00')
  assert.equal(delta?.printOptions?.autoRecovery.supported, true)
  assert.equal(delta?.printOptions?.autoRecovery.enabled, true)
  assert.equal(delta?.printOptions?.buildPlateTypeDetection.supported, true)
  assert.equal(delta?.printOptions?.aiMonitoring.supported, true)
})

test('refined AI reports hide Studio legacy aggregate AI monitoring', () => {
  const delta = parseReport({
    print: {
      fun: '40000000000',
      xcam: { cfg: 0 }
    }
  }, { ...printer, model: 'H2D' })

  assert.equal(delta?.printOptions?.spaghettiDetection.supported, true)
  assert.equal(delta?.printOptions?.aiMonitoring.supported, false)
})

test('authoritative capability reports clear stale print-setting support', () => {
  const current = makeOfflineStatus({ ...printer, model: 'H2D' })
  current.printOptions.filamentTangleDetection.supported = true
  current.printOptions.spaghettiDetection.supported = true

  const delta = parseReport(
    { print: { fun: '0' } },
    { ...printer, model: 'H2D' },
    current
  )

  assert.equal(delta?.printOptions?.filamentTangleDetection.supported, false)
  assert.equal(delta?.printOptions?.spaghettiDetection.supported, false)
})

test('explicit print-setting support overrides packed capability bits', () => {
  const delta = parseReport({
    print: {
      fun: '0',
      support_filament_tangle_detect: true
    }
  }, { ...printer, model: 'H2D' })

  assert.equal(delta?.printOptions?.filamentTangleDetection.supported, true)
})

test('remote print storage follows the live capability outside static model fallbacks', () => {
  const unsupported = parseReport({ print: {} }, { ...printer, model: 'P1S' })
  const reported = parseReport({
    print: { support_save_remote_print_file_to_storage: true }
  }, { ...printer, model: 'P1S' })

  assert.equal(unsupported?.printOptions?.storeSentFilesOnExternalStorage.supported, false)
  assert.equal(reported?.printOptions?.storeSentFilesOnExternalStorage.supported, true)
})

test('parseReport fills persistent settings missing from an older current status', () => {
  const current = makeOfflineStatus(printer)
  const legacyPrintOptions = {
    aiMonitoring: current.printOptions.aiMonitoring,
    spaghettiDetection: current.printOptions.spaghettiDetection,
    purgeChutePileupDetection: current.printOptions.purgeChutePileupDetection,
    nozzleClumpingDetection: current.printOptions.nozzleClumpingDetection,
    airPrintingDetection: current.printOptions.airPrintingDetection,
    firstLayerInspection: current.printOptions.firstLayerInspection,
    autoRecovery: current.printOptions.autoRecovery,
    promptSound: current.printOptions.promptSound,
    filamentTangleDetection: current.printOptions.filamentTangleDetection
  } as PrinterStatus['printOptions']

  const delta = parseReport(
    { print: {} },
    printer,
    { ...current, printOptions: legacyPrintOptions }
  )

  assert.deepEqual(delta?.printOptions?.foreignObjectDetection, {
    supported: false,
    enabled: null
  })
  assert.deepEqual(delta?.printOptions?.cameraResolution, {
    supported: false,
    current: null,
    available: []
  })
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

test('parseReport reports an unmeasurable remain as unknown rather than empty', () => {
  // Firmware sends `remain: -1` for any spool it cannot weigh, every third-party and
  // manually-set one. Clamping that to 0 made the whole AMS read as empty spools, so the
  // print dialogs marked every hand-set slot as too low to finish anything.
  const delta = parseReport(
    {
      print: {
        ams: {
          ams: [{
            id: 0,
            info: '1',
            tray: [
              { id: 0, tray_type: 'PLA', remain: -1 },
              { id: 1, tray_type: 'PLA', remain: 64 },
              { id: 2, tray_type: 'PLA', remain: 140 }
            ]
          }]
        }
      }
    },
    printer
  )

  const slots = delta?.ams?.[0]?.slots
  assert.equal(slots?.[0]?.remainPercent, null)
  assert.equal(slots?.[1]?.remainPercent, 64)
  // An over-100 reading is still clamped: that one is a real measurement, just out of range.
  assert.equal(slots?.[2]?.remainPercent, 100)
})

/**
 * A loaded 4-slot AMS to merge deltas over. `tray_exist_bits: 'f'` = slots 0-3 all occupied.
 */
function loadedAmsStatus() {
  const full = parseReport(
    {
      print: {
        ams: {
          tray_exist_bits: 'f',
          ams: [{
            id: 0,
            info: '1',
            tray: [
              { id: 0, tray_type: 'PLA', tray_info_idx: 'GFA00', tray_uuid: 'AAAA0000000000000000000000000001', tray_color: 'FF0000FF', remain: 80 },
              { id: 1, tray_type: 'PETG', tray_info_idx: 'GFG00', tray_uuid: 'AAAA0000000000000000000000000002', tray_color: '00FF00FF', remain: 70 },
              { id: 2, tray_type: 'PLA', tray_info_idx: 'GFA00', tray_uuid: 'AAAA0000000000000000000000000003', tray_color: '0000FFFF', remain: 60 },
              { id: 3, tray_type: 'ABS', tray_info_idx: 'GFB00', tray_uuid: 'AAAA0000000000000000000000000004', tray_color: 'FFFFFFFF', remain: 50 }
            ]
          }]
        }
      }
    },
    printer
  )
  return { ...makeOfflineStatus(printer), ams: full?.ams ?? [] }
}

const slotOf = (delta: ReturnType<typeof parseReport>, slotId: number) =>
  delta?.ams?.[0]?.slots.find((slot) => slot.slot === slotId)

test('parseReport clears a removed AMS slot whose tray object is absent from the delta', () => {
  // A delta usually carries only the trays it has something to say about. The removal
  // is announced by dropping slot 2's exist bit ('f' -> 'b'), and slot 2's tray object
  // is simply not in the payload, so the bits are the ONLY signal that it is gone.
  const delta = parseReport(
    {
      print: {
        ams: {
          tray_exist_bits: 'b',
          ams: [{ id: 0, tray: [{ id: 0, tray_type: 'PLA', remain: 79 }] }]
        }
      }
    },
    printer,
    loadedAmsStatus()
  )

  const removed = slotOf(delta, 2)
  assert.equal(removed?.occupied, false)
  assert.equal(removed?.trayUuid, null)
  assert.equal(removed?.filamentType, null)
  assert.equal(removed?.trayInfoIdx, null)
  assert.equal(removed?.color, null)
  assert.deepEqual(removed?.colors, [])
  assert.equal(removed?.remainPercent, null)
  // The untouched neighbours keep everything.
  assert.equal(slotOf(delta, 3)?.trayUuid, 'AAAA0000000000000000000000000004')
  assert.equal(slotOf(delta, 3)?.occupied, true)
})

test('parseReport clears a removed AMS slot from a delta carrying only the exist bits', () => {
  const delta = parseReport(
    { print: { ams: { tray_exist_bits: 'b' } } },
    printer,
    loadedAmsStatus()
  )

  assert.equal(slotOf(delta, 2)?.occupied, false)
  assert.equal(slotOf(delta, 2)?.trayUuid, null)
  assert.equal(slotOf(delta, 2)?.filamentType, null)
  assert.equal(slotOf(delta, 1)?.filamentType, 'PETG')
  assert.equal(slotOf(delta, 1)?.occupied, true)
})

test('parseReport leaves every slot alone when a delta carries no exist bits', () => {
  // Absence is not emptiness: a delta that says nothing about occupancy must never
  // clear a slot, or every partial AMS report would wipe the trays it did not mention.
  const delta = parseReport(
    { print: { ams: { ams: [{ id: 0, tray: [{ id: 0, tray_type: 'PLA', remain: 79 }] }] } } },
    printer,
    loadedAmsStatus()
  )

  assert.equal(slotOf(delta, 2)?.trayUuid, 'AAAA0000000000000000000000000003')
  assert.equal(slotOf(delta, 2)?.filamentType, 'PLA')
  assert.equal(slotOf(delta, 2)?.occupied, true)
})

test('parseReport reads a shortened exist bitmap as the higher units being empty', () => {
  // `tray_exist_bits` is one device-wide bitmap on `print.ams`, and Bambu omits its
  // leading zeroes, so '1f' means unit 1 slot 0 is loaded, and a later 'f' means it
  // is not. This is the assumption the sweep rests on; pin it so a firmware that
  // reports per-unit bitmaps instead would fail here rather than silently wiping a unit.
  const both = parseReport(
    {
      print: {
        ams: {
          tray_exist_bits: '1f',
          ams: [
            { id: 0, info: '1', tray: [{ id: 0, tray_type: 'PLA', tray_uuid: 'BBBB0000000000000000000000000001' }] },
            { id: 1, info: '1', tray: [{ id: 0, tray_type: 'ABS', tray_uuid: 'BBBB0000000000000000000000000002' }] }
          ]
        }
      }
    },
    printer
  )
  assert.equal(both?.ams?.find((unit) => unit.unitId === 1)?.slots[0]?.occupied, true)

  const afterRemoval = parseReport(
    { print: { ams: { tray_exist_bits: 'f' } } },
    printer,
    { ...makeOfflineStatus(printer), ams: both?.ams ?? [] }
  )
  const unitOne = afterRemoval?.ams?.find((unit) => unit.unitId === 1)?.slots[0]
  assert.equal(unitOne?.occupied, false)
  assert.equal(unitOne?.trayUuid, null)
  // Unit 0 is untouched by the same bitmap.
  assert.equal(afterRemoval?.ams?.find((unit) => unit.unitId === 0)?.slots[0]?.trayUuid, 'BBBB0000000000000000000000000001')
})

test('an external slot reporting a tray uuid is not treated as empty', () => {
  // Guards a contradiction rather than a live scenario: no populated `tray_uuid` has
  // been observed from an external holder, so this payload is not expected in the field. But `tray_uuid` is
  // in the virtual-tray wire format and BambuStudio parses it, and if one ever did
  // arrive, omitting it from the emptiness test published a slot that reads as empty
  // (colour blanked) while still carrying the uuid that tells `collectPresences` a spool
  // IS loaded there. Cheap to make unreachable; do not read it as evidence of external RFID.
  const delta = parseReport(
    { print: { vt_tray: { id: 255, tray_uuid: 'ABCDEF1234567890ABCDEF1234567890', tray_color: 'FF0000FF' } } },
    printer
  )

  const spool = delta?.externalSpools?.find((entry) => entry.amsId === 255)
  assert.equal(spool?.trayUuid, 'ABCDEF1234567890ABCDEF1234567890')
  assert.equal(spool?.color, '#FF0000')
  assert.deepEqual(spool?.colors, ['#FF0000'])
})

test('dual-nozzle route sentinels do not mark an external spool active', () => {
  const h2d = { ...printer, model: 'H2D' as const }
  const delta = parseReport(
    {
      print: {
        device: {
          extruder: {
            info: [
              { id: 0, snow: 0xffff },
              { id: 1, snow: 0xfeff }
            ]
          }
        }
      }
    },
    h2d,
    makeOfflineStatus(h2d)
  )

  assert.equal(delta?.externalSpools?.find((spool) => spool.amsId === 255)?.active, false)
  assert.equal(delta?.externalSpools?.find((spool) => spool.amsId === 254)?.active, false)
})

test('dual-nozzle route slot zero marks the addressed external spool active', () => {
  const h2d = { ...printer, model: 'H2D' as const }
  const delta = parseReport(
    {
      print: {
        device: {
          extruder: {
            info: [
              { id: 0, snow: 0xff00 },
              { id: 1, snow: 0xffff }
            ]
          }
        }
      }
    },
    h2d,
    makeOfflineStatus(h2d)
  )

  assert.equal(delta?.externalSpools?.find((spool) => spool.amsId === 255)?.active, true)
  assert.equal(delta?.externalSpools?.find((spool) => spool.amsId === 254)?.active, false)
})

test('an emptied external slot drops its calibration alongside its identity', () => {
  // Half-clearing is what leaves a phantom: an empty slot must not keep the removed
  // spool's K profile any more than it keeps its colour.
  const offline = makeOfflineStatus(printer)
  const seeded: typeof offline = {
    ...offline,
    externalSpools: offline.externalSpools.map((spool) => (
      spool.amsId === 255
        ? { ...spool, caliIdx: 3, k: 0.02, trayUuid: 'ABCDEF1234567890ABCDEF1234567890' }
        : spool
    ))
  }

  const delta = parseReport({ print: { vt_tray: { id: 255, tray_uuid: '' } } }, printer, seeded)

  const spool = delta?.externalSpools?.find((entry) => entry.amsId === 255)
  assert.equal(spool?.trayUuid, null)
  assert.equal(spool?.caliIdx, null)
  assert.equal(spool?.k, null)
})

test('the exist-bits sweep uses each AMS family\'s own bit band', () => {
  // Ported from `DevAms::GetTrayId`, which is the same index BambuStudio feeds to
  // `get_flag_bits(tray_exist_bits, ...)`: AMS Lite Mixed (N9, DevAmsType 5) lives at
  // 24 + slotId, NOT unitId * 4 + slotId. Reading the classic band for it lands on
  // another unit's bits -- and since the sweep CLEARS on a false bit, that emptied
  // loaded slots. Bit 24 is the 7th nibble from the right: '1000000'.
  const loaded = parseReport(
    {
      print: {
        ams: {
          tray_exist_bits: '1000000',
          ams: [{ id: 0, info: '5', tray: [{ id: 0, tray_type: 'PLA', tray_uuid: 'CCCC0000000000000000000000000001' }] }]
        }
      }
    },
    printer
  )

  const unit = loaded?.ams?.find((entry) => entry.unitId === 0)
  assert.equal(unit?.type, 'ams-lite-mixed')
  assert.equal(unit?.slots[0]?.occupied, true)
  assert.equal(unit?.slots[0]?.trayUuid, 'CCCC0000000000000000000000000001')
})

test('an unparseable exist bitmap reads as unknown, never as every tray being empty', () => {
  // `isHexBitSet` answers false for both "bit clear" and "cannot read this string",
  // and callers CLEAR a slot's whole spool identity on false. So a bitmap this parser
  // cannot read used to wipe every loaded slot in every unit, and because identity
  // falls back to the previous slot, the wipe then persisted across later deltas
  // until a full pushall re-described each tray.
  const delta = parseReport(
    { print: { ams: { tray_exist_bits: '0x1f' } } },
    printer,
    loadedAmsStatus()
  )

  assert.equal(slotOf(delta, 0)?.trayUuid, 'AAAA0000000000000000000000000001')
  assert.equal(slotOf(delta, 0)?.filamentType, 'PLA')
  assert.equal(slotOf(delta, 0)?.occupied, true)
  assert.equal(slotOf(delta, 3)?.trayUuid, 'AAAA0000000000000000000000000004')
  assert.equal(slotOf(delta, 3)?.occupied, true)
})

test('a well-formed exist bitmap still empties the slot it clears', () => {
  // Pairs with the test above so the unknown-bitmap guard cannot be satisfied by
  // disabling the sweep altogether.
  const delta = parseReport(
    { print: { ams: { tray_exist_bits: 'b' } } },
    printer,
    loadedAmsStatus()
  )

  assert.equal(slotOf(delta, 2)?.occupied, false)
  assert.equal(slotOf(delta, 2)?.trayUuid, null)
})

test('the reading bitmap uses the same bit bands as the exist bitmap', () => {
  // Both fields are indexed by `DevAms::GetTrayId`. A running counter over the slots
  // agrees only for a contiguous set of classic 4-slot units: an AMS HT unit lives at
  // 16 + (unitId - 128) + slotId, so with AMS 0 in front of it the counter read bit 4
  // -- AMS 0's would-be fifth slot -- and the rescanning indicator landed on the wrong
  // tray. Bit 16 is the 5th nibble from the right: '10000'.
  const delta = parseReport(
    {
      print: {
        ams: {
          tray_reading_bits: '10000',
          ams: [
            { id: 0, info: '1', tray: [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }] },
            { id: 128, info: '4', tray: [{ id: 0 }] }
          ]
        }
      }
    },
    printer
  )

  const ht = delta?.ams?.find((entry) => entry.unitId === 128)
  assert.equal(ht?.type, 'ams-ht')
  assert.equal(ht?.slots[0]?.isReading, true)
  const classic = delta?.ams?.find((entry) => entry.unitId === 0)
  assert.deepEqual(classic?.slots.map((slot) => slot.isReading), [false, false, false, false])
})

test('the reading bitmap skips a gap in the unit ids instead of shifting past it', () => {
  // AMS 0 + AMS 2 with unit 1 unplugged: unit 2 slot 0 is bit 2*4+0 = 8 ('100'),
  // not the running counter's 4.
  const delta = parseReport(
    {
      print: {
        ams: {
          tray_reading_bits: '100',
          ams: [
            { id: 0, info: '1', tray: [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }] },
            { id: 2, info: '1', tray: [{ id: 0 }] }
          ]
        }
      }
    },
    printer
  )

  assert.equal(delta?.ams?.find((entry) => entry.unitId === 2)?.slots[0]?.isReading, true)
  assert.equal(delta?.ams?.find((entry) => entry.unitId === 0)?.slots.some((slot) => slot.isReading), false)
})

test('an unparseable reading bitmap leaves the previous reading state alone', () => {
  // `isReading` carries forward from the previous slot, so the failure to pin is a
  // junk bitmap silently reporting "nothing is reading" over a tray that is.
  const reading = parseReport(
    { print: { ams: { tray_reading_bits: '1', ams: [{ id: 0, info: '1', tray: [{ id: 0 }] }] } } },
    printer
  )
  assert.equal(reading?.ams?.[0]?.slots[0]?.isReading, true)

  const delta = parseReport(
    { print: { ams: { tray_reading_bits: 'not-hex' } } },
    printer,
    { ...makeOfflineStatus(printer), ams: reading?.ams ?? [] }
  )

  assert.equal(delta?.ams?.[0]?.slots[0]?.isReading, true)
})

test('a unit whose bit band is unknown is never emptied by the sweep', () => {
  // `GetTrayId` asserts and returns -1 for a DevAmsType it does not know; we return
  // null so the slot reads as "not stated" instead of "empty". Guessing a band for a
  // future unit family would wipe its loaded slots on the first report.
  const seeded = parseReport(
    { print: { ams: { ams: [{ id: 0, info: 'd', tray: [{ id: 0, tray_type: 'PLA', tray_uuid: 'DDDD0000000000000000000000000001' }] }] } } },
    printer
  )
  assert.equal(seeded?.ams?.[0]?.type, 'unknown')

  const swept = parseReport(
    { print: { ams: { tray_exist_bits: '0' } } },
    printer,
    { ...makeOfflineStatus(printer), ams: seeded?.ams ?? [] }
  )

  assert.equal(swept?.ams?.[0]?.slots[0]?.trayUuid, 'DDDD0000000000000000000000000001')
  assert.equal(swept?.ams?.[0]?.slots[0]?.filamentType, 'PLA')
})

test('parseReport reads the AMS chain firmware options and which one is running', () => {
  const delta = parseReport(
    {
      print: {
        upgrade_state: {
          mc_for_ams_firmware: {
            firmware: [
              { id: 0, name: 'AMS Lite', version: '00.00.06.15' },
              { id: 1, name: 'AMS', version: '00.00.07.02' }
            ],
            current_firmware_id: 1,
            current_run_firmware_id: 1,
            status: 'IDLE'
          }
        }
      }
    },
    printer
  )

  assert.deepEqual(delta?.amsFirmwareSwitch, {
    options: [
      { id: 0, name: 'AMS Lite', version: '00.00.06.15' },
      { id: 1, name: 'AMS', version: '00.00.07.02' }
    ],
    currentId: 1,
    runningId: 1,
    switching: false
  })
})

test('parseReport reports a mid-switch AMS chain, where selected and running differ', () => {
  const delta = parseReport(
    {
      print: {
        upgrade_state: {
          mc_for_ams_firmware: {
            firmware: [{ id: 0, name: 'AMS Lite', version: '1' }, { id: 1, name: 'AMS', version: '2' }],
            current_firmware_id: 0,
            current_run_firmware_id: 1,
            status: 'SWITCHING'
          }
        }
      }
    },
    printer
  )

  assert.equal(delta?.amsFirmwareSwitch?.switching, true)
  assert.equal(delta?.amsFirmwareSwitch?.currentId, 0)
  assert.equal(delta?.amsFirmwareSwitch?.runningId, 1)
})

test('parseReport drops a firmware entry with no id, because the id IS the command payload', () => {
  const delta = parseReport(
    {
      print: {
        upgrade_state: {
          mc_for_ams_firmware: {
            firmware: [{ name: 'Nameless' }, { id: 1, name: 'AMS', version: null }],
            current_firmware_id: 1,
            current_run_firmware_id: 1,
            status: 'IDLE'
          }
        }
      }
    },
    printer
  )

  assert.deepEqual(delta?.amsFirmwareSwitch?.options, [{ id: 1, name: 'AMS', version: null }])
})

test('an incremental frame leaves a known AMS firmware switch alone', () => {
  // The fleet case: no machine reports `mc_for_ams_firmware` today, so no delta key at all.
  const none = parseReport({ print: { aux: '0' } }, printer)
  assert.equal('amsFirmwareSwitch' in (none ?? {}), false)

  // And once one HAS been seen, a later delta that does not mention it must not wipe it. Most
  // frames are `push_status` deltas mentioning neither, and nothing in the report can positively
  // say the capability went away, so clearing here made the AMS Type row vanish on the next tick.
  const current = {
    ...makeOfflineStatus(printer),
    amsFirmwareSwitch: { options: [{ id: 1, name: 'AMS', version: null }], currentId: 1, runningId: 1, switching: false }
  }
  const delta = parseReport({ print: { aux: '0' } }, printer, current)
  assert.equal('amsFirmwareSwitch' in (delta ?? {}), false)
})

test('an empty firmware list parses as "cannot switch", not as absent', () => {
  // BambuStudio's capability test IS the list being empty, so this must survive as an empty array
  // rather than collapse to null: null means "no report", which is a different thing.
  const delta = parseReport(
    { print: { upgrade_state: { mc_for_ams_firmware: { firmware: [], status: 'IDLE' } } } },
    printer
  )
  assert.deepEqual(delta?.amsFirmwareSwitch?.options, [])
  assert.equal(delta?.amsFirmwareSwitch?.currentId, null)
})

test('parseReport reads the printer-reported pause schedule from print.p_list', () => {
  const delta = parseReport(
    {
      print: {
        p_list: {
          total: 2,
          list: [
            { p: 18, t: 240, i: 1, l: 20 },
            { p: 55, t: 120, i: 2, l: 60 }
          ]
        }
      }
    },
    printer
  )

  assert.deepEqual(delta?.pauseSchedule, {
    total: 2,
    points: [
      { index: 1, layer: 20, progressPercent: 18, remainingMinutes: 240 },
      { index: 2, layer: 60, progressPercent: 55, remainingMinutes: 120 }
    ],
    totalLayers: null,
    source: 'printer'
  })
})

test('parseReport leaves the pause schedule alone when the report omits p_list', () => {
  const delta = parseReport({ print: { mc_percent: 42 } }, printer)

  assert.equal('pauseSchedule' in (delta ?? {}), false)
})

test('parseReport ignores a p_list with no usable shape rather than half-applying it', () => {
  const malformed: unknown[] = [
    { total: 2, list: 'nope' },
    { list: [{ p: 18, t: 240, i: 1, l: 20 }] } // no total
  ]
  for (const p_list of malformed) {
    const delta = parseReport({ print: { p_list } }, printer)
    assert.equal('pauseSchedule' in (delta ?? {}), false)
  }
})

test('parseReport numbers pauses itself, so a 0-based p_list index still works', () => {
  // Whether the printer's `i` is 0- or 1-based cannot be established from BambuStudio's source.
  // Requiring 1-based would discard every frame on firmware that counts from zero, silently
  // disabling the preferred producer for the whole print.
  const delta = parseReport(
    {
      print: {
        p_list: {
          total: 2,
          list: [
            { p: 18, t: 240, i: 0, l: 20 },
            { p: 55, t: 120, i: 1, l: 60 }
          ]
        }
      }
    },
    printer
  )

  assert.deepEqual(delta?.pauseSchedule?.points.map((point) => point.index), [1, 2])
  assert.deepEqual(delta?.pauseSchedule?.points.map((point) => point.layer), [20, 60])
})

test('parseReport treats a negative pause time as unknown, not as due now', () => {
  // Studio filters these out before drawing (`StatusPanel.cpp:1809` requires `>= 0`), so firmware
  // does emit them. Clamping to 0 would make the UI quote a duration nobody computed.
  const delta = parseReport(
    { print: { p_list: { total: 1, list: [{ p: 40, t: -1, i: 1, l: 60 }] } } },
    printer
  )

  assert.equal(delta?.pauseSchedule?.points[0]?.remainingMinutes, null)
  assert.equal(delta?.pauseSchedule?.points[0]?.progressPercent, 40)
})

test('parseReport drops only the entries it cannot place, keeping the rest of the list', () => {
  const delta = parseReport(
    {
      print: {
        p_list: {
          total: 3,
          list: [
            { p: 18, t: 240, i: 1, l: 20 },
            { p: 55, t: 120, i: 2 }, // no layer: cannot be placed
            { p: 88, t: 30, i: 3, l: 140 }
          ]
        }
      }
    },
    printer
  )

  assert.deepEqual(delta?.pauseSchedule?.points.map((point) => point.layer), [20, 140])
  assert.deepEqual(delta?.pauseSchedule?.points.map((point) => point.index), [1, 3])
  // The printer's own count of the whole plate is preserved, so "of 3" stays honest.
  assert.equal(delta?.pauseSchedule?.total, 3)
})

test('parseReport caps p_list at the wire limit so a status frame stays parseable', () => {
  // An over-long schedule fails `wsEventSchema` in the browser and the WHOLE status frame is
  // dropped, freezing temps, progress and AMS for as long as that print runs.
  const list = Array.from({ length: 80 }, (_, index) => ({
    p: Math.min(100, index),
    t: 300 - index,
    i: index + 1,
    l: index + 1
  }))
  const delta = parseReport({ print: { p_list: { total: 80, list } } }, printer)

  assert.equal(delta?.pauseSchedule?.points.length, 64)
  assert.equal(printerStatusSchema.shape.pauseSchedule.safeParse(delta?.pauseSchedule).success, true)
})

test('parseReport drops a stale pause schedule when the printer moves to another task', () => {
  const current = {
    ...makeOfflineStatus(printer),
    taskId: 'task-1',
    pauseSchedule: {
      total: 1,
      points: [{ index: 1, layer: 20, progressPercent: 18, remainingMinutes: 240 }],
      totalLayers: null,
      source: 'printer' as const
    }
  }

  // A new task with no p_list of its own: keeping the old one would promise a pause the new print
  // does not have.
  const changed = parseReport({ print: { task_id: 'task-2' } }, printer, current)
  assert.equal(changed?.pauseSchedule, null)

  // The same task reporting nothing new must not clear it.
  const unchanged = parseReport({ print: { task_id: 'task-1', mc_percent: 30 } }, printer, current)
  assert.equal('pauseSchedule' in (unchanged ?? {}), false)
})

test('parseReport numbers a trimmed p_list against the printer total, not its position', () => {
  // BambuStudio's `getPassedCount` (minimum `i`, documented as "how many pause points precede the
  // next pending pause") only means anything if consumed pauses drop out of the list. Numbering by
  // position would then call the LAST pause of three "pause 1 of 3".
  const delta = parseReport(
    { print: { p_list: { total: 3, list: [{ p: 88, t: 30, i: 2, l: 140 }] } } },
    printer
  )

  assert.equal(delta?.pauseSchedule?.points[0]?.index, 3)
  assert.equal(delta?.pauseSchedule?.total, 3)
})

test('parseReport numbers a complete p_list from one', () => {
  const delta = parseReport(
    {
      print: {
        p_list: {
          total: 2,
          list: [{ p: 18, t: 240, i: 0, l: 20 }, { p: 55, t: 120, i: 1, l: 60 }]
        }
      }
    },
    printer
  )

  assert.deepEqual(delta?.pauseSchedule?.points.map((point) => point.index), [1, 2])
})

test('parseReport drops a stale pause schedule when any print identity changes', () => {
  const base = {
    ...makeOfflineStatus(printer),
    taskId: 'task-1',
    jobId: 'job-1',
    gcodeFile: 'Metadata/plate_1.gcode',
    jobName: 'Widget',
    pauseSchedule: {
      total: 1,
      points: [{ index: 1, layer: 20, progressPercent: 18, remainingMinutes: 240 }],
      totalLayers: null,
      source: 'printer' as const
    }
  }

  // An SD-card or LAN start can report a constant or empty task id, so the task alone is not
  // enough to notice that a different file is running.
  for (const print of [
    { task_id: 'task-2' },
    { job_id: 'job-2' },
    { gcode_file: 'Metadata/plate_4.gcode' },
    { subtask_name: 'Other thing' }
  ]) {
    assert.equal(parseReport({ print }, printer, base)?.pauseSchedule, null, JSON.stringify(print))
  }

  // Re-reporting the SAME identity must not clear it.
  const unchanged = parseReport(
    { print: { task_id: 'task-1', gcode_file: 'Metadata/plate_1.gcode', mc_percent: 30 } },
    printer,
    base
  )
  assert.equal('pauseSchedule' in (unchanged ?? {}), false)
})
