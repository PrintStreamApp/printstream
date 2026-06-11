import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { Printer } from '@printstream/shared'
import { buildDemoStatus, DEMO_PRINTER_SEEDS } from './demo/demo-printers.js'
import { ingestHmsDictionaryForTests, resetHmsCodeServiceForTests } from './hms-codes.js'
import { parseReport } from './printer-manager.js'

afterEach(() => {
  resetHmsCodeServiceForTests()
})

function makePrinter(seed: (typeof DEMO_PRINTER_SEEDS)[number], id = seed.serial): Printer {
  return {
    id,
    name: seed.name,
    host: seed.host,
    serial: seed.serial,
    accessCode: seed.accessCode,
    model: seed.model,
    currentPlateType: seed.currentPlateType,
    currentNozzleDiameters: seed.currentNozzleDiameters,
    position: seed.position,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z'
  }
}

test('parseReport prefers device extruder target_temp over a stale cached nozzle target', () => {
  const printer = makePrinter(DEMO_PRINTER_SEEDS[2]!)
  const currentStatus = buildDemoStatus(printer)
  currentStatus.nozzleTarget = 0
  currentStatus.nozzles = [{
    ...currentStatus.nozzles[0]!,
    currentTemp: 35,
    targetTemp: 0
  }]

  const delta = parseReport({
    print: {
      device: {
        extruder: {
          info: [{
            id: 0,
            temp: 42,
            target_temp: 250
          }]
        }
      }
    }
  }, printer, currentStatus)

  assert.equal(delta?.nozzleTarget, 250)
  assert.equal(delta?.nozzles?.[0]?.currentTemp, 42)
  assert.equal(delta?.nozzles?.[0]?.targetTemp, 250)
})

test('parseReport clears a stale cached nozzle target when device extruder temp is unpacked', () => {
  const printer = makePrinter(DEMO_PRINTER_SEEDS[2]!)
  const currentStatus = buildDemoStatus(printer)
  currentStatus.nozzleTarget = 250
  currentStatus.nozzles = [{
    ...currentStatus.nozzles[0]!,
    currentTemp: 210,
    targetTemp: 250
  }]

  const delta = parseReport({
    print: {
      device: {
        extruder: {
          info: [{
            id: 0,
            temp: 42
          }]
        }
      }
    }
  }, printer, currentStatus)

  assert.equal(delta?.nozzleTarget, 0)
  assert.equal(delta?.nozzles?.[0]?.currentTemp, 42)
  assert.equal(delta?.nozzles?.[0]?.targetTemp, 0)
})

test('parseReport drops a stale deputy external spool on single-nozzle printers', () => {
  const printer = makePrinter(DEMO_PRINTER_SEEDS[2]!)
  const currentStatus = buildDemoStatus(printer)
  currentStatus.externalSpools = [
    {
      amsId: 255,
      nozzleId: 0,
      trayName: 'Manual PLA',
      filamentType: 'PLA',
      color: '#FFFFFF',
      colors: ['#FFFFFF'],
      remainPercent: 50,
      active: false,
      trayInfoIdx: 'GFA00',
      caliIdx: -1,
      k: null,
      trayUuid: null
    },
    {
      amsId: 254,
      nozzleId: 1,
      trayName: 'Stale deputy spool',
      filamentType: 'TPU 95A',
      color: '#2F7ECA',
      colors: ['#2F7ECA'],
      remainPercent: 63,
      active: false,
      trayInfoIdx: 'GFU03',
      caliIdx: -1,
      k: null,
      trayUuid: null
    }
  ]

  const delta = parseReport({
    print: {
      vt_tray: {
        id: 255,
        tray_type: 'PLA',
        tray_info_idx: 'GFA00',
        tray_color: 'FFFFFFFF'
      }
    }
  }, printer, currentStatus)

  assert.equal(delta?.externalSpools?.length, 1)
  assert.equal(delta?.externalSpools?.[0]?.amsId, 255)
})

test('parseReport derives command transport capabilities from print.fun bits', () => {
  const printer = makePrinter(DEMO_PRINTER_SEEDS[0]!)

  const delta = parseReport({
    print: {
      cfg: '1',
      fun: 'c100000000',
      aux: '1',
      stat: '1'
    }
  }, printer)

  assert.deepEqual(delta?.commandTransport, {
    mqttBedTemperature: true,
    mqttAxisControl: true,
    mqttHoming: true,
    newFanControl: true
  })
})

test('parseReport keeps the printer-provided chamber-light shutoff warning bit', () => {
  const printer = makePrinter(DEMO_PRINTER_SEEDS[0]!)

  const delta = parseReport({
    print: {
      stat: '1000000000'
    }
  }, printer)

  assert.equal(delta?.chamberLightOffRequiresConfirm, true)
})

test('parseReport ignores chamber temperature readings for P1S because BambuStudio disables chamber-temp display there', () => {
  const printer = makePrinter(DEMO_PRINTER_SEEDS[2]!)

  const delta = parseReport({
    print: {
      chamber_temper: 5
    }
  }, printer)

  assert.equal(delta?.chamberTemp, undefined)
})

test('parseReport keeps chamber temperature readings for display-capable chamber models', () => {
  const printer = makePrinter(DEMO_PRINTER_SEEDS[1]!)

  const delta = parseReport({
    print: {
      chamber_temper: 33
    }
  }, printer)

  assert.equal(delta?.chamberTemp, 33)
})

test('parseReport keeps chamber target readings for display-capable chamber models', () => {
  const printer = makePrinter(DEMO_PRINTER_SEEDS[1]!)

  const delta = parseReport({
    print: {
      chamber_temper: 33,
      ctt: 50
    }
  }, printer)

  assert.equal(delta?.chamberTemp, 33)
  assert.equal(delta?.chamberTarget, 50)
})

test('parseReport unpacks chamber current and target temperatures from V2 chamber payloads', () => {
  const printer = makePrinter(DEMO_PRINTER_SEEDS[1]!)

  const delta = parseReport({
    print: {
      device: {
        ctc: {
          info: {
            temp: (48 << 16) | 35
          }
        }
      }
    }
  }, printer)

  assert.equal(delta?.chamberTemp, 35)
  assert.equal(delta?.chamberTarget, 48)
})

test('parseReport falls back to stg_cur when newer firmware omits mc_print_sub_stage', () => {
  const printer = makePrinter(DEMO_PRINTER_SEEDS[1]!)

  const delta = parseReport({
    print: {
      gcode_state: 'RUNNING',
      stg_cur: 47,
      mc_remaining_time: 18
    }
  }, printer)

  assert.equal(delta?.stage, 'printing')
  assert.equal(delta?.subStage, '47')
  assert.equal(delta?.remainingMinutes, 18)
})

test('parseReport prefers stg_cur when mc_print_sub_stage is only a sentinel value', () => {
  const printer = makePrinter(DEMO_PRINTER_SEEDS[1]!)

  const delta = parseReport({
    print: {
      gcode_state: 'RUNNING',
      mc_print_sub_stage: 0,
      stg_cur: 14,
      mc_remaining_time: 18
    }
  }, printer)

  assert.equal(delta?.stage, 'printing')
  assert.equal(delta?.subStage, '14')
  assert.equal(delta?.remainingMinutes, 18)
})

test('parseReport falls back to stage_curr when newer firmware omits mc_print_sub_stage', () => {
  const printer = makePrinter(DEMO_PRINTER_SEEDS[1]!)

  const delta = parseReport({
    print: {
      gcode_state: 'RUNNING',
      stage_curr: 49,
      mc_remaining_time: 18
    }
  }, printer)

  assert.equal(delta?.stage, 'printing')
  assert.equal(delta?.subStage, '49')
  assert.equal(delta?.remainingMinutes, 18)
})

test('parseReport prefers print_status over gcode_state for paused prints', () => {
  const printer = makePrinter(DEMO_PRINTER_SEEDS[1]!)

  const delta = parseReport({
    print: {
      print_status: 'PAUSE',
      gcode_state: 'RUNNING',
      mc_print_sub_stage: 6,
      mc_remaining_time: 18
    }
  }, printer)

  assert.equal(delta?.stage, 'paused')
  assert.equal(delta?.subStage, '6')
  assert.equal(delta?.remainingMinutes, 18)
})

test('parseReport normalizes filament change progress from AMS steps and extruder state', () => {
  const printer = makePrinter(DEMO_PRINTER_SEEDS[0]!)

  const delta = parseReport({
    print: {
      ams: {
        cfs: [2, 5, 7]
      },
      device: {
        extruder: {
          info: [{
            id: 0,
            stat: 5
          }]
        }
      }
    }
  }, printer)

  assert.deepEqual(delta?.filamentChange, {
    currentStepIndex: 1,
    currentStepLabel: 'Push new filament into extruder',
    steps: ['Heat the nozzle', 'Push new filament into extruder', 'Purge old filament']
  })
})

test('parseReport keeps higher-numbered filament change steps reported by newer Bambu firmware', () => {
  const printer = makePrinter(DEMO_PRINTER_SEEDS[0]!)

  const delta = parseReport({
    print: {
      ams: {
        cfs: [11, 14, 15]
      },
      device: {
        extruder: {
          info: [{
            id: 0,
            stat: 15
          }]
        }
      }
    }
  }, printer)

  assert.deepEqual(delta?.filamentChange, {
    currentStepIndex: 2,
    currentStepLabel: 'Confirm extruded',
    steps: ['Wait for AMS cooling', 'Switch track at Filament Track Switch', 'Confirm extruded']
  })
})

test('parseReport derives AMS drying phase labels from drying status bits', () => {
  const printer = makePrinter(DEMO_PRINTER_SEEDS[0]!)

  const delta = parseReport({
    print: {
      ams: {
        ams: [{
          id: 0,
          info: '53',
          dry_time: 42,
          tray: []
        }]
      }
    }
  }, printer)

  assert.equal(delta?.ams?.[0]?.supportDrying, true)
  assert.equal(delta?.ams?.[0]?.dryingActive, true)
  assert.equal(delta?.ams?.[0]?.dryingPhase, 'cooling')
  assert.equal(delta?.ams?.[0]?.dryTimeRemainingMinutes, 42)
})

test('parseReport ignores bogus AMS temperature and humidity startup readings', () => {
  const printer = makePrinter(DEMO_PRINTER_SEEDS[1]!)
  const currentStatus = buildDemoStatus(printer)

  const initialDelta = parseReport({
    print: {
      ams: {
        ams: [{
          id: 0,
          humidity_raw: '0',
          temp: '6504',
          tray: []
        }]
      }
    }
  }, printer)

  assert.equal(initialDelta?.ams?.[0]?.humidityPercent, null)
  assert.equal(initialDelta?.ams?.[0]?.temperature, null)

  const delta = parseReport({
    print: {
      ams: {
        ams: [{
          id: 0,
          humidity_raw: '0',
          temp: '6504',
          tray: []
        }]
      }
    }
  }, printer, currentStatus)

  assert.equal(delta?.ams?.[0]?.humidityPercent, currentStatus.ams[0]?.humidityPercent)
  assert.equal(delta?.ams?.[0]?.temperature, currentStatus.ams[0]?.temperature)
})

test('parseReport clears stale AMS slot metadata when an empty-slot partial update omits tray identity fields', () => {
  const printer = makePrinter(DEMO_PRINTER_SEEDS[0]!)
  const currentStatus = buildDemoStatus(printer)
  const [firstUnit] = currentStatus.ams
  assert.ok(firstUnit)

  firstUnit.slots[0] = {
    slot: 0,
    trayName: 'Stale PLA',
    filamentType: 'PLA',
    color: '#FFFFFF',
    colors: ['#FFFFFF'],
    remainPercent: 62,
    active: false,
    isReading: false,
    trayInfoIdx: 'GFA00',
    caliIdx: -1,
    k: null,
    trayUuid: 'ABCDEF1234567890ABCDEF1234567890'
  }

  const delta = parseReport({
    print: {
      ams: {
        ams: [{
          id: 0,
          tray: [{
            id: 0,
            tray_type: '',
            tray_color: '000000FF',
            remain: ''
          }]
        }]
      }
    }
  }, printer, currentStatus)

  assert.equal(delta?.ams?.[0]?.slots[0]?.filamentType, null)
  assert.equal(delta?.ams?.[0]?.slots[0]?.trayName, null)
  assert.equal(delta?.ams?.[0]?.slots[0]?.trayInfoIdx, null)
  assert.equal(delta?.ams?.[0]?.slots[0]?.color, null)
  assert.deepEqual(delta?.ams?.[0]?.slots[0]?.colors, [])
  assert.equal(delta?.ams?.[0]?.slots[0]?.trayUuid, null)
  assert.equal(delta?.ams?.[0]?.slots[0]?.remainPercent, null)
})

test('parseReport keeps identity-less AMS slots occupied when third-party filament reports remaining material', () => {
  const printer = makePrinter(DEMO_PRINTER_SEEDS[0]!)
  const currentStatus = buildDemoStatus(printer)

  const delta = parseReport({
    print: {
      ams: {
        ams: [{
          id: 0,
          tray: [{
            id: 1,
            tray_type: '',
            tray_color: 'FF00FFFF',
            remain: '100',
            tray_uuid: '00000000000000000000000000000000'
          }]
        }]
      }
    }
  }, printer, currentStatus)

  const slot = delta?.ams?.[0]?.slots.find((entry) => entry.slot === 1)
  assert.ok(slot)
  assert.equal(slot.filamentType, null)
  assert.equal(slot.trayName, null)
  assert.equal(slot.trayInfoIdx, null)
  assert.equal(slot.color, '#FF00FF')
  assert.deepEqual(slot.colors, ['#FF00FF'])
  assert.equal(slot.remainPercent, 100)
  assert.equal(slot.trayUuid, null)
})

test('parseReport uses AMS tray existence bits to keep identity-less third-party slots occupied', () => {
  const printer = makePrinter(DEMO_PRINTER_SEEDS[0]!)
  const currentStatus = buildDemoStatus(printer)

  const delta = parseReport({
    print: {
      ams: {
        tray_exist_bits: '8',
        ams: [{
          id: 0,
          tray: [{
            id: 3,
            tray_type: '',
            tray_color: '00000000',
            remain: '',
            tray_uuid: '00000000000000000000000000000000'
          }]
        }]
      }
    }
  }, printer, currentStatus)

  const slot = delta?.ams?.[0]?.slots.find((entry) => entry.slot === 3)
  assert.ok(slot)
  assert.equal(slot.occupied, true)
  assert.equal(slot.filamentType, null)
  assert.equal(slot.trayName, null)
  assert.equal(slot.trayInfoIdx, null)
  assert.equal(slot.color, null)
  assert.deepEqual(slot.colors, [])
  assert.equal(slot.remainPercent, null)
  assert.equal(slot.trayUuid, null)
})

test('parseReport uses AMS tray existence bits to clear truly empty slots', () => {
  const printer = makePrinter(DEMO_PRINTER_SEEDS[0]!)
  const currentStatus = buildDemoStatus(printer)
  const [firstUnit] = currentStatus.ams
  assert.ok(firstUnit)

  firstUnit.slots[1] = {
    slot: 1,
    trayName: 'Stale PLA',
    filamentType: 'PLA',
    color: '#FFFFFF',
    colors: ['#FFFFFF'],
    remainPercent: 62,
    active: false,
    isReading: false,
    occupied: true,
    trayInfoIdx: 'GFA00',
    caliIdx: -1,
    k: null,
    trayUuid: 'ABCDEF1234567890ABCDEF1234567890'
  }

  const delta = parseReport({
    print: {
      ams: {
        tray_exist_bits: '0',
        ams: [{
          id: 0,
          tray: [{
            id: 1,
            tray_type: '',
            tray_color: '000000FF',
            remain: ''
          }]
        }]
      }
    }
  }, printer, currentStatus)

  const slot = delta?.ams?.[0]?.slots.find((entry) => entry.slot === 1)
  assert.ok(slot)
  assert.equal(slot.occupied, false)
  assert.equal(slot.filamentType, null)
  assert.equal(slot.trayName, null)
  assert.equal(slot.trayInfoIdx, null)
  assert.equal(slot.color, null)
  assert.deepEqual(slot.colors, [])
  assert.equal(slot.remainPercent, null)
  assert.equal(slot.trayUuid, null)
})

test('parseReport clears a removed AMS slot when the exist bit drops but the tray object still reports stale RFID identity', () => {
  // Regression: a spool pulled from a slot is frequently reported by flipping
  // the slot's `tray_exist_bits` bit to 0 while the tray object still carries
  // the removed spool's RFID identity (tray_type/tray_info_idx/remain/...).
  // Those fields previously fell back to the cached slot and the slot kept
  // showing a phantom spool until the process restarted.
  const printer = makePrinter(DEMO_PRINTER_SEEDS[0]!)
  const currentStatus = buildDemoStatus(printer)
  const [firstUnit] = currentStatus.ams
  assert.ok(firstUnit)

  firstUnit.slots[2] = {
    slot: 2,
    trayName: 'PETG HF Teal',
    filamentType: 'PETG HF',
    color: '#138A8A',
    colors: ['#138A8A'],
    remainPercent: 54,
    active: false,
    isReading: false,
    occupied: true,
    trayInfoIdx: 'GFG99',
    caliIdx: 3,
    k: 0.024,
    trayUuid: 'DEADBEEFDEADBEEFDEADBEEFDEADBEEF'
  }

  // tray_exist_bits '3' = binary 0011 -> slots 0 and 1 present, slot 2 absent.
  // The tray object for slot 2 still echoes the old RFID identity.
  const delta = parseReport({
    print: {
      ams: {
        tray_exist_bits: '3',
        ams: [{
          id: 0,
          tray: [{
            id: 2,
            tray_type: 'PETG HF',
            tray_info_idx: 'GFG99',
            tray_color: '138A8AFF',
            remain: 54,
            tray_uuid: 'DEADBEEFDEADBEEFDEADBEEFDEADBEEF'
          }]
        }]
      }
    }
  }, printer, currentStatus)

  const slot = delta?.ams?.[0]?.slots.find((entry) => entry.slot === 2)
  assert.ok(slot)
  assert.equal(slot.occupied, false)
  assert.equal(slot.filamentType, null)
  assert.equal(slot.trayName, null)
  assert.equal(slot.trayInfoIdx, null)
  assert.equal(slot.color, null)
  assert.deepEqual(slot.colors, [])
  assert.equal(slot.remainPercent, null)
  assert.equal(slot.caliIdx, null)
  assert.equal(slot.k, null)
  assert.equal(slot.trayUuid, null)
})

test('parseReport clears stale external spool metadata when an empty virtual-tray update omits tray identity fields', () => {
  const printer = makePrinter(DEMO_PRINTER_SEEDS[2]!)
  const currentStatus = buildDemoStatus(printer)
  currentStatus.externalSpools = [{
    amsId: 255,
    nozzleId: 0,
    trayName: 'Manual PLA',
    filamentType: 'PLA',
    color: '#FFFFFF',
    colors: ['#FFFFFF'],
    remainPercent: 41,
    active: false,
    trayInfoIdx: 'GFA00',
    caliIdx: -1,
    k: null,
    trayUuid: 'ABCDEF1234567890ABCDEF1234567890'
  }]

  const delta = parseReport({
    print: {
      vt_tray: {
        id: 255,
        tray_type: '',
        tray_color: '000000FF',
        remain: ''
      }
    }
  }, printer, currentStatus)

  assert.equal(delta?.externalSpools?.[0]?.filamentType, null)
  assert.equal(delta?.externalSpools?.[0]?.trayName, null)
  assert.equal(delta?.externalSpools?.[0]?.trayInfoIdx, null)
  assert.equal(delta?.externalSpools?.[0]?.color, null)
  assert.deepEqual(delta?.externalSpools?.[0]?.colors, [])
  assert.equal(delta?.externalSpools?.[0]?.trayUuid, null)
  assert.equal(delta?.externalSpools?.[0]?.remainPercent, null)
})

test('parseReport resolves device-specific HMS and device_error messages from the printer serial prefix', () => {
  ingestHmsDictionaryForTests({
    data: {
      device_hms: { en: [] },
      device_error: { en: [] }
    }
  })
  ingestHmsDictionaryForTests({
    data: {
      device_hms: {
        en: [{
          ecode: '0C0003000002001C',
          intro: 'Your nozzle seems to be covered with jammed or clogged material.'
        }]
      },
      device_error: {
        en: [{
          ecode: '0C008043',
          intro: 'AI detected nozzle clumping. Please check the nozzle condition. Refer to assistant for solutions.'
        }]
      }
    }
  }, '094')

  const printer = {
    ...makePrinter(DEMO_PRINTER_SEEDS[1]!, 'home-h2d'),
    serial: '0948AD590900302'
  }

  const delta = parseReport({
    print: {
      hms: [{
        attr: 0x0C000300,
        code: 0x0002001C
      }],
      print_error: 0x0C008043
    }
  }, printer)

  assert.deepEqual(delta?.hmsErrors, [
    {
      code: '0C0003000002001C',
      message: 'Your nozzle seems to be covered with jammed or clogged material.'
    }
  ])
  assert.deepEqual(delta?.deviceError, {
    code: '0C008043',
    message: 'AI detected nozzle clumping. Please check the nozzle condition. Refer to assistant for solutions.'
  })
})