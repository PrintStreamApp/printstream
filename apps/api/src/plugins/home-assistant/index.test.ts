import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { RequestAuthContext } from '../../lib/auth-context.js'
import { PRINTERS_VIEW_PERMISSION, printerStatusSchema, type Printer, type PrinterStatus } from '@printstream/shared'
import { HttpError } from '../../lib/http-error.js'
import { PrinterEventBus } from '../../lib/printer-events.js'
import { buildHomeAssistantBridgeInfo, buildHomeAssistantSnapshot } from './snapshot.js'
import { createHomeAssistantPlugin } from './index.js'

const printer: Printer = {
  id: 'printer-1',
  name: 'Printer 1',
  host: '192.168.1.44',
  serial: 'SERIAL-1',
  accessCode: 'secret',
  model: 'P1S',
  currentPlateType: null,
  currentNozzleDiameters: [],
  position: 0,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString()
}

const printingStatus = makeStatus({
  stage: 'printing',
  subStage: 'outer wall',
  progressPercent: 42,
  currentLayer: 12,
  totalLayers: 128,
  remainingMinutes: 55,
  jobName: 'Widget Plate',
  lastJobName: 'Widget Plate',
  bedTemp: 60,
  bedTarget: 60,
  nozzleTemp: 220,
  nozzleTarget: 220,
  chamberTemp: 34,
  chamberTarget: 45,
  wifiSignalDbm: -47,
  ipAddress: '192.168.1.44',
  doorOpen: false,
  sdCardPresent: true,
  firmwareVersion: '01.10.00.00',
  hmsErrors: [{ code: '0300-0100-0001', message: 'Example warning' }],
  ams: [{
    unitId: 0,
    nozzleId: 0,
    type: 'ams-2-pro' as const,
    supportDrying: true,
    dryTimeRemainingMinutes: 90,
    dryingActive: true,
    dryFilament: 'PLA',
    dryTemperature: 50,
    dryDurationHours: 4,
    humidityPercent: 19,
    humidityLevel: 1,
    temperature: 31,
    slots: [
      {
        slot: 1,
        trayName: 'Support',
        filamentType: 'Support PLA',
        color: '#FFFFFF',
        colors: ['#FFFFFF'],
        remainPercent: 52,
        active: false,
        isReading: false,
        trayInfoIdx: null,
        caliIdx: null,
        k: null,
        trayUuid: null
      },
      {
        slot: 0,
        trayName: 'Black PLA',
        filamentType: 'PLA',
        color: '#111111',
        colors: ['#111111'],
        remainPercent: 81,
        active: true,
        isReading: false,
        trayInfoIdx: null,
        caliIdx: null,
        k: null,
        trayUuid: null
      }
    ]
  }],
  externalSpools: [{
    amsId: 255,
    nozzleId: 0,
    trayName: 'Manual PLA',
    filamentType: 'PLA',
    color: '#555555',
    colors: ['#555555'],
    remainPercent: 25,
    active: false,
    trayInfoIdx: null,
    caliIdx: null,
    k: null,
    trayUuid: null
  }],
  observedAt: '2026-04-30T05:45:00.000Z'
})

const idleStatusWithLastJob = makeStatus({
  ...printingStatus,
  stage: 'idle',
  progressPercent: null,
  currentLayer: null,
  totalLayers: null,
  remainingMinutes: null,
  jobName: null,
  gcodeFile: null,
  observedAt: '2026-04-30T06:10:00.000Z'
})

function makeStatus(overrides: Partial<PrinterStatus>): PrinterStatus {
  return printerStatusSchema.parse({
    printerId: printer.id,
    online: true,
    stage: 'idle',
    subStage: null,
    jobId: null,
    filamentChange: {
      currentStepIndex: null,
      currentStepLabel: null,
      steps: []
    },
    progressPercent: null,
    currentLayer: null,
    totalLayers: null,
    remainingMinutes: null,
    jobName: null,
    lastJobName: null,
    gcodeFile: null,
    bedTemp: null,
    bedTarget: null,
    nozzleTemp: null,
    nozzleTarget: null,
    nozzles: [],
    nozzleRack: null,
    chamberTemp: null,
    chamberTarget: null,
    fanGearSpeed: null,
    partFanPercent: null,
    auxFanPercent: null,
    chamberFanPercent: null,
    wifiSignalDbm: null,
    ipAddress: null,
    doorOpen: null,
    ductMode: null,
    ductAvailableModes: [],
    lightModes: {
      chamber: null,
      heatbed: null,
      work: null
    },
    lightCapabilities: {
      chamber: false,
      heatbed: false,
      work: false
    },
    chamberLightOffRequiresConfirm: false,
    lightOn: null,
    speedLevel: null,
    commandTransport: {
      mqttBedTemperature: false,
      mqttAxisControl: false,
      mqttHoming: false,
      newFanControl: false
    },
    printOptions: {
      aiMonitoring: { supported: false, enabled: null, sensitivity: null },
      spaghettiDetection: { supported: false, enabled: null, sensitivity: null },
      purgeChutePileupDetection: { supported: false, enabled: null, sensitivity: null },
      nozzleClumpingDetection: { supported: false, enabled: null, sensitivity: null },
      airPrintingDetection: { supported: false, enabled: null, sensitivity: null },
      firstLayerInspection: { supported: false, enabled: null },
      autoRecovery: { supported: false, enabled: null },
      promptSound: { supported: false, enabled: null },
      filamentTangleDetection: { supported: false, enabled: null }
    },
    deviceError: null,
    hmsErrors: [],
    amsSettings: {
      detectOnInsert: null,
      detectOnPowerup: null,
      remainEnabled: null,
      autoRefill: null,
      supportFilamentBackup: null
    },
    ams: [],
    externalSpools: [],
    firmwareVersion: null,
    sdCardPresent: null,
    observedAt: new Date(0).toISOString(),
    ...overrides
  })
}

test('buildHomeAssistantSnapshot maps printer and AMS state into a stable bridge payload', () => {
  const snapshot = buildHomeAssistantSnapshot([printer], (printerId) => (
    printerId === printer.id ? printingStatus : undefined
  ), new Date('2026-04-30T05:46:00.000Z'))

  assert.equal(snapshot.version, 1)
  assert.equal(snapshot.printers.length, 1)
  assert.equal(snapshot.printers[0]?.detailPath, `/printers/${printer.id}`)
  assert.equal(snapshot.printers[0]?.cameraSupported, true)
  assert.equal(snapshot.printers[0]?.cameraSnapshotPath, `/api/camera/${printer.id}/snapshot`)
  assert.equal(snapshot.printers[0]?.cameraStreamPath, `/api/camera/${printer.id}/stream`)
  assert.match(snapshot.printers[0]?.coverImagePath ?? '', new RegExp(`^/api/printers/${printer.id}/cover\\?job=`))
  assert.equal(snapshot.printers[0]?.speedLevel, printingStatus.speedLevel ?? null)
  assert.deepEqual(snapshot.printers[0]?.nozzles ?? [], printingStatus.nozzles ?? [])
  assert.equal(snapshot.printers[0]?.ams[0]?.id, `${printer.id}:ams:0`)
  assert.equal(snapshot.printers[0]?.ams[0]?.name, `${printer.name} AMS 1`)
  assert.equal(snapshot.printers[0]?.ams[0]?.activeSlot, 0)
  assert.equal(snapshot.printers[0]?.ams[0]?.slots[0]?.trayInfoIdx ?? null, null)
  assert.deepEqual(snapshot.printers[0]?.ams[0]?.slots.map((slot) => slot.slot), [0, 1])
  assert.equal(snapshot.printers[0]?.externalSpools[0]?.trayName, 'Manual PLA')

  const info = buildHomeAssistantBridgeInfo(snapshot)
  assert.equal(info.printerCount, 1)
  assert.equal(info.amsUnitCount, 1)
  assert.equal(info.snapshotPath, '/api/plugins/home-assistant/snapshot')
})

test('buildHomeAssistantSnapshot keeps a cover path for the last job when the printer is idle', () => {
  const snapshot = buildHomeAssistantSnapshot([printer], (printerId) => (
    printerId === printer.id ? idleStatusWithLastJob : undefined
  ), new Date('2026-04-30T06:11:00.000Z'))

  assert.equal(snapshot.printers[0]?.jobName, null)
  assert.equal(snapshot.printers[0]?.lastJobName, idleStatusWithLastJob.lastJobName)
  assert.equal(
    snapshot.printers[0]?.coverImagePath,
    `/api/printers/${printer.id}/cover?job=${encodeURIComponent(idleStatusWithLastJob.lastJobName ?? '')}&gcode=`
  )
})

test('home-assistant routes expose summary counts and the bridge snapshot', async () => {
  const plugin = createHomeAssistantPlugin({
    async listPrinters() {
      return [printer]
    },
    getStatus(printerId) {
      return printerId === printer.id ? printingStatus : undefined
    }
  })

  await withRegisteredPluginApp(plugin, async ({ baseUrl }) => {
    const infoResponse = await fetch(`${baseUrl}/api/plugins/home-assistant`)
    assert.equal(infoResponse.status, 200)
    const infoBody = await infoResponse.json() as {
      version: number
      generatedAt: string
      printerCount: number
      amsUnitCount: number
      snapshotPath: string
    }
    assert.deepEqual(infoBody, {
      printerCount: 1,
      amsUnitCount: 1,
      snapshotPath: '/api/plugins/home-assistant/snapshot',
      generatedAt: infoBody.generatedAt,
      version: 1
    })

    const snapshotResponse = await fetch(`${baseUrl}/api/plugins/home-assistant/snapshot`)
    assert.equal(snapshotResponse.status, 200)
    const snapshotBody = await snapshotResponse.json() as {
      printers: Array<{ id: string; cameraSnapshotPath: string | null; cameraStreamPath: string | null; coverImagePath: string | null; ams: Array<{ id: string; name: string }> }>
    }
    assert.equal(snapshotBody.printers[0]?.id, printer.id)
    assert.equal(snapshotBody.printers[0]?.cameraSnapshotPath, `/api/camera/${printer.id}/snapshot`)
    assert.equal(snapshotBody.printers[0]?.cameraStreamPath, `/api/camera/${printer.id}/stream`)
    assert.match(snapshotBody.printers[0]?.coverImagePath ?? '', new RegExp(`^/api/printers/${printer.id}/cover\\?job=`))
    assert.equal(snapshotBody.printers[0]?.ams[0]?.id, `${printer.id}:ams:0`)
    assert.equal(snapshotBody.printers[0]?.ams[0]?.name, `${printer.name} AMS 1`)
  })
})

test('home-assistant skips tenant-scoped websocket events when the plugin is disabled for that tenant', async () => {
  const bus = new PrinterEventBus()
  const broadcasts: Array<{ tenantId: string | null; event: unknown }> = []
  const plugin = createHomeAssistantPlugin({
    async listPrinters() {
      return [printer]
    },
    getStatus(printerId) {
      return printerId === printer.id ? printingStatus : undefined
    }
  })

  await plugin.register({
    pluginName: 'home-assistant',
    logger: { info() {}, warn() {}, error() {} },
    prisma: {
      printer: {
        async findMany() {
          return []
        }
      }
    } as never,
    printerEvents: bus,
    ws: {
      broadcast(event: unknown, tenantId: string | null) {
        broadcasts.push({ event, tenantId })
      }
    } as never,
    isEnabledForTenant() {
      return false
    },
    router: express.Router(),
    settings: {
      async get() { return null },
      async set() {},
      async delete() {},
      forTenant() { throw new Error('not used') }
    },
    onShutdown() {},
    registerPrintGuard() {
      return () => {}
    },
    registerSlotFilamentResolver() {
      return () => {}
    },
    registerAuthProvider() {
      return () => {}
    }
  })

  bus.emit('status', printingStatus)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(broadcasts.length, 0)
})

async function withRegisteredPluginApp<T>(
  plugin: ReturnType<typeof createHomeAssistantPlugin>,
  run: (context: { baseUrl: string }) => Promise<T>
): Promise<T> {
  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.auth = {
      authEnabled: true,
      actor: { type: 'user', userId: 'user-1' },
      permissions: [PRINTERS_VIEW_PERMISSION],
      runtimePolicy: { demoMode: false }
    } satisfies RequestAuthContext
    next()
  })

  const router = express.Router()
  app.use('/api/plugins/home-assistant', router)
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) {
      response.status(error.statusCode).json({ error: error.message })
      return
    }
    response.status(500).json({ error: 'Internal server error' })
  })

  await plugin.register({
    pluginName: 'home-assistant',
    logger: { info() {}, warn() {}, error() {} },
    prisma: {
      printer: {
        async findMany() {
          return []
        }
      }
    },
    printerEvents: new PrinterEventBus(),
    ws: {
      broadcast() {}
    },
    router,
    settings: {
      async get() { return null },
      async set() {},
      async delete() {}
    },
    onShutdown() {},
    registerPrintGuard() {
      return () => {}
    }
  } as never)

  const server = await new Promise<import('node:http').Server>((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })

  try {
    const address = server.address() as AddressInfo
    return await run({ baseUrl: `http://127.0.0.1:${address.port}` })
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
}
