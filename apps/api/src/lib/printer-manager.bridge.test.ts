import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import type { Printer } from '@printstream/shared'
const mqtt = await import('mqtt')
import { bridgeSessionManager } from './bridge-session-manager.js'
import { printerEvents } from './printer-events.js'
import { printerManager } from './printer-manager.js'

const originalSendCommand = bridgeSessionManager.sendCommand

const printer: Printer = {
  id: 'bridge-printer-1',
  name: 'Bridge Printer',
  host: '192.168.1.50',
  serial: 'BRIDGE-SERIAL-1',
  accessCode: 'secret',
  model: 'P1S',
  currentPlateType: null,
  currentNozzleDiameters: [],
  position: 0,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString()
}

afterEach(() => {
  mock.restoreAll()
  bridgeSessionManager.sendCommand = originalSendCommand

  const manager = printerManager as unknown as {
    managed: Map<string, unknown>
    bridgeIds: Map<string, string | null>
  }
  manager.managed.clear()
  manager.bridgeIds.clear()
})

test('add does not open a local MQTT client for bridged printers', () => {
  const connect = mock.method(mqtt.default, 'connect', () => {
    throw new Error('bridged printers should not connect from the API process')
  })

  printerManager.add(printer, 'tenant-1', 'bridge-1')

  assert.equal(connect.mock.callCount(), 0)
  assert.equal(printerManager.getPrinter(printer.id)?.id, printer.id)
  assert.equal(printerManager.getStatus(printer.id)?.online, false)
})

test('publishCommand routes bridged printers through the bridge session and stamps sequence ids', () => {
  const manager = printerManager as unknown as {
    managed: Map<string, {
      printer: Printer
      client: null
      status: unknown
      lastStage: string
      lastJobName: string | null
      sequenceId: number
      offlineSince: number | null
      recycleTimer: ReturnType<typeof setTimeout> | null
      demoTimers: Set<ReturnType<typeof setTimeout>>
      demoAutoStartTimer: ReturnType<typeof setTimeout> | null
    }>
    bridgeIds: Map<string, string | null>
  }

  manager.managed.set(printer.id, {
    printer,
    client: null,
    status: { online: false },
    lastStage: 'unknown',
    lastJobName: null,
    sequenceId: 0,
    offlineSince: null,
    recycleTimer: null,
    demoTimers: new Set(),
    demoAutoStartTimer: null
  })
  manager.bridgeIds.set(printer.id, 'bridge-1')

  const calls: Array<{ bridgeId: string; printer: Printer; payload: Record<string, unknown> }> = []
  bridgeSessionManager.sendCommand = ((bridgeId, targetPrinter, payload) => {
    calls.push({ bridgeId, printer: targetPrinter, payload })
    return true
  }) as typeof bridgeSessionManager.sendCommand

  assert.equal(printerManager.publishCommand(printer.id, { print: { command: 'pause' } }), true)
  assert.equal(printerManager.publishCommand(printer.id, { info: { command: 'get_version' } }), true)

  assert.deepEqual(calls, [
    {
      bridgeId: 'bridge-1',
      printer,
      payload: { print: { command: 'pause', sequence_id: '1' } }
    },
    {
      bridgeId: 'bridge-1',
      printer,
      payload: { info: { command: 'get_version', sequence_id: '2' } }
    }
  ])
})

test('requestPressureAdvanceProfiles sends the existing query command and resolves from a bridged report', async () => {
  const manager = printerManager as unknown as {
    managed: Map<string, {
      printer: Printer
      client: null
      status: unknown
      lastStage: string
      lastJobName: string | null
      sequenceId: number
      offlineSince: number | null
      recycleTimer: ReturnType<typeof setTimeout> | null
      demoTimers: Set<ReturnType<typeof setTimeout>>
      demoAutoStartTimer: ReturnType<typeof setTimeout> | null
    }>
    bridgeIds: Map<string, string | null>
  }
  manager.managed.set(printer.id, {
    printer,
    client: null,
    status: { online: true },
    lastStage: 'idle',
    lastJobName: null,
    sequenceId: 0,
    offlineSince: null,
    recycleTimer: null,
    demoTimers: new Set(),
    demoAutoStartTimer: null
  })
  manager.bridgeIds.set(printer.id, 'bridge-1')

  const sentPayloads: Array<Record<string, unknown>> = []
  bridgeSessionManager.sendCommand = ((_bridgeId, _printer, payload) => {
    sentPayloads.push(payload)
    return true
  }) as typeof bridgeSessionManager.sendCommand

  const pending = printerManager.requestPressureAdvanceProfiles(printer.id, {
    filamentId: 'GFA00',
    extruderId: 0,
    nozzleDiameter: '0.4'
  })

  assert.deepEqual(sentPayloads, [
    {
      print: {
        command: 'extrusion_cali_get',
        filament_id: 'GFA00',
        extruder_id: 0,
        nozzle_id: 'HS00-0.4',
        nozzle_diameter: '0.4',
        sequence_id: '1'
      }
    }
  ])

  printerManager.ingestBridgeReport(printer.id, {
    print: {
      command: 'extrusion_cali_get',
      sequence_id: '1',
      filaments: [
        {
          cali_idx: 3,
          filament_id: 'GFA00',
          setting_id: 'setting-1',
          name: 'Primary PLA',
          k_value: 0.021,
          nozzle_diameter: '0.4',
          confidence: 92
        }
      ]
    }
  }, 'bridge-1')

  await assert.doesNotReject(async () => {
    assert.deepEqual(await pending, [
      {
        caliIdx: 3,
        filamentId: 'GFA00',
        settingId: 'setting-1',
        name: 'Primary PLA',
        kValue: 0.021,
        nCoef: null,
        nozzleDiameter: '0.4',
        confidence: 92
      }
    ])
  })
})

test('ingestBridgeReport reuses the API parser pipeline for bridged status', () => {
  const manager = printerManager as unknown as {
    managed: Map<string, {
      printer: Printer
      client: null
      status: { online: boolean; progressPercent: number | null }
      lastStage: string
      lastJobName: string | null
      sequenceId: number
      offlineSince: number | null
      recycleTimer: ReturnType<typeof setTimeout> | null
      demoTimers: Set<ReturnType<typeof setTimeout>>
      demoAutoStartTimer: ReturnType<typeof setTimeout> | null
    }>
    bridgeIds: Map<string, string | null>
  }

  manager.managed.set(printer.id, {
    printer,
    client: null,
    status: { online: false, progressPercent: null },
    lastStage: 'unknown',
    lastJobName: null,
    sequenceId: 0,
    offlineSince: Date.now(),
    recycleTimer: null,
    demoTimers: new Set(),
    demoAutoStartTimer: null
  })
  manager.bridgeIds.set(printer.id, 'bridge-1')

  printerManager.ingestBridgeReport(printer.id, {
    print: {
      mc_percent: 42
    }
  }, 'bridge-1')

  assert.equal(printerManager.getStatus(printer.id)?.online, true)
  assert.equal(printerManager.getStatus(printer.id)?.progressPercent, 42)
  // markBridgeDisconnected's offline behavior (now grace-debounced) is covered in
  // printer-manager.offline-grace.test.ts.
})

test('ingestBridgeReport ignores a report from a bridge that does not own the printer', () => {
  printerManager.add(printer, 'tenant-1', 'bridge-1')

  const statusEvents: string[] = []
  const onStatus = (status: { printerId: string }) => {
    statusEvents.push(status.printerId)
  }
  printerEvents.on('status', onStatus)

  try {
    // A different bridge (e.g. another tenant's) reports for this printer id.
    printerManager.ingestBridgeReport(
      printer.id,
      { print: { gcode_state: 'RUNNING', subtask_name: 'Spoofed', mc_percent: 73 } },
      'bridge-attacker'
    )

    assert.equal(statusEvents.length, 0)
    assert.notEqual(printerManager.getStatus(printer.id)?.progressPercent, 73)
  } finally {
    printerEvents.off('status', onStatus)
  }
})

test('ingestBridgeReport emits job.started when a printer first reports pre-print activity', () => {
  printerManager.add(printer, 'tenant-1', 'bridge-1')

  const startedEvents: Array<{ printer: { id: string }; jobName: string }> = []
  const onStarted = (event: { printer: { id: string }; jobName: string }) => {
    startedEvents.push(event)
  }
  printerEvents.on('job.started', onStarted)

  try {
    printerManager.ingestBridgeReport(printer.id, {
      print: {
        gcode_state: 'PREPARE',
        subtask_name: 'Early start plate',
        mc_print_sub_stage: 14
      }
    }, 'bridge-1')

    assert.equal(printerManager.getStatus(printer.id)?.stage, 'preparing')
    assert.deepEqual(startedEvents.map((event) => ({ printerId: event.printer.id, jobName: event.jobName })), [
      { printerId: printer.id, jobName: 'Early start plate' }
    ])

    printerManager.ingestBridgeReport(printer.id, {
      print: {
        gcode_state: 'RUNNING',
        subtask_name: 'Early start plate',
        mc_percent: 1
      }
    }, 'bridge-1')

    assert.equal(startedEvents.length, 1)
  } finally {
    printerEvents.off('job.started', onStarted)
  }
})

test('update resets bridge command sequencing when a printer moves to a different bridge', () => {
  const sent: Array<{ bridgeId: string; payload: Record<string, unknown> }> = []
  bridgeSessionManager.sendCommand = ((bridgeId, _printer, payload) => {
    sent.push({ bridgeId, payload })
    return true
  }) as typeof bridgeSessionManager.sendCommand

  printerManager.add(printer, 'tenant-1', 'bridge-1')
  assert.equal(printerManager.publishCommand(printer.id, { print: { command: 'pause' } }), true)

  printerManager.update({ ...printer, bridgeId: 'bridge-2' }, 'tenant-1', 'bridge-2')
  assert.equal(printerManager.publishCommand(printer.id, { print: { command: 'resume' } }), true)

  assert.deepEqual(sent, [
    {
      bridgeId: 'bridge-1',
      payload: { print: { command: 'pause', sequence_id: '1' } }
    },
    {
      bridgeId: 'bridge-2',
      payload: { print: { command: 'resume', sequence_id: '1' } }
    }
  ])
})

test('ingestBridgeReport suppresses status emits when the report carries no new information', () => {
  printerManager.add(printer, 'tenant-1', 'bridge-1')

  const statusEvents: Array<{ id: string }> = []
  const onStatus = (status: { printerId: string }) => {
    statusEvents.push({ id: status.printerId })
  }
  printerEvents.on('status', onStatus)

  try {
    printerManager.ingestBridgeReport(printer.id, {
      print: {
        gcode_state: 'RUNNING',
        subtask_name: 'Stable plate',
        mc_percent: 25
      }
    }, 'bridge-1')
    assert.equal(statusEvents.length, 1)

    // Identical report: only observedAt would change, so no new emit should fire.
    printerManager.ingestBridgeReport(printer.id, {
      print: {
        gcode_state: 'RUNNING',
        subtask_name: 'Stable plate',
        mc_percent: 25
      }
    }, 'bridge-1')
    assert.equal(statusEvents.length, 1)

    // A real change re-emits.
    printerManager.ingestBridgeReport(printer.id, {
      print: {
        gcode_state: 'RUNNING',
        subtask_name: 'Stable plate',
        mc_percent: 26
      }
    }, 'bridge-1')
    assert.equal(statusEvents.length, 2)
  } finally {
    printerEvents.off('status', onStatus)
  }
})