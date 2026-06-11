/**
 * Simulator bridge runtime for the public demo tenant.
 *
 * This module behaves like a bridge-connected printer fleet: it receives the
 * API's configured printers, emits normalized printer statuses, answers a small
 * printer-storage/camera RPC surface, and applies basic command effects. It
 * does not import API internals or mutate the API database directly.
 */
import * as childProcess from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import path from 'node:path'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  buildPlateGcodeFileHint,
  findDemoPrintDefinitionByFileName,
  findDemoPrintDefinitionByJobName,
  getPrinterDisplayCapabilities,
  getDemoPrinterActiveJob,
  getDemoPrinterRecentFinishedJob,
  getPrinterPrintOptionCapabilities,
  getPrinterPrintStartOptions,
  isPrinterModelCompatible,
  printerStatusSchema,
  type BridgeRuntimeInboundMessage,
  type BridgeRuntimeOutboundMessage,
  type BridgePrinterStorageEntry,
  type DemoPrintDefinition,
  type Printer,
  type PrinterPrintOptions,
  type PrinterStatus
} from '@printstream/shared'
import { env } from './env.js'
import { readBridgeLibraryThreeMfIndex } from './library-3mf.js'

type BridgeCommandMessage = Extract<BridgeRuntimeOutboundMessage, { type: 'bridge.command' }>
type BridgeRpcRequestMessage = Extract<BridgeRuntimeOutboundMessage, { type: 'bridge.rpc.request' }>

interface DemoSimulatorOptions {
  statusIntervalMs?: number
  cameraFrameIntervalMs?: number
}

interface SimulatedPrinterState {
  printer: Printer
  status: PrinterStatus
}

type DemoPrinterScenario = 'idle' | 'printing' | 'paused' | 'failed' | 'finished'

interface DemoLibraryFile {
  fileName: string
  jobName: string
  sizeBytes: number
  modifiedAt: string
  selectedPlate: number | null
}

type DemoCameraSnapshotRenderer = (filePath: string) => Buffer | null

const FALLBACK_DEMO_CAMERA_JPEG_BASE64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/Aaf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/Aaf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z'
const DEMO_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEMO_LIBRARY_DIR = resolveDemoAssetDir(path.resolve(env.BRIDGE_LIBRARY_DIR), '../../../data/demo-library')
const DEMO_CAMERA_SNAPSHOT_DIR = resolveDemoAssetDir(path.resolve(path.dirname(DEMO_LIBRARY_DIR), 'demo-camera-snapshots'), '../../../data/demo-camera-snapshots')
const DEMO_CAPTURES_DIR = resolveDemoAssetDir(path.resolve(path.dirname(DEMO_LIBRARY_DIR), 'demo-captures'), '../../../data/demo-captures')
const DEMO_CAMERA_WATERMARK_FILTER = [
  'drawbox=x=0:y=ih-80:w=iw:h=80:color=black@0.55:t=fill',
  "drawtext=text='DEMO CAMERA':fontcolor=white:fontsize=24:x=(w-text_w)/2:y=h-44"
].join(',')

const FALLBACK_DEMO_LIBRARY_FILES: DemoLibraryFile[] = [
  { fileName: 'Storage_Box.gcode.3mf', jobName: 'Storage Box', sizeBytes: 4_294_967, modifiedAt: '2026-04-30T18:12:00.000Z', selectedPlate: null },
  { fileName: 'Needle_Lift_Tool.gcode.3mf', jobName: 'Needle Lift Tool', sizeBytes: 1_732_112, modifiedAt: '2026-04-29T09:15:00.000Z', selectedPlate: null }
]

const STATIC_STORAGE_ENTRIES: BridgePrinterStorageEntry[] = [
  { name: 'projects', path: '/projects', type: 'directory', sizeBytes: 0, modifiedAt: '2026-04-30T08:45:00.000Z' }
]

const FALLBACK_TIMELAPSE_STORAGE_ENTRIES: BridgePrinterStorageEntry[] = [
  { name: 'timelapse', path: '/timelapse', type: 'directory', sizeBytes: 0, modifiedAt: '2026-04-26T14:20:00.000Z' },
  { name: 'Prototype_X1C_Benchy_2026-04-26_1420.mp4', path: '/timelapse/Prototype_X1C_Benchy_2026-04-26_1420.mp4', type: 'file', sizeBytes: 9_600_000, modifiedAt: '2026-04-26T14:20:00.000Z' }
]

const SEEDED_DEMO_SCENARIOS = new Map<string, DemoPrinterScenario>([
  ['DEMO-X1C-001', 'idle'],
  ['DEMO-H2D-001', 'printing'],
  ['DEMO-P1S-001', 'paused'],
  ['DEMO-X1C-002', 'printing'],
  ['DEMO-H2D-002', 'printing'],
  ['DEMO-P1S-002', 'printing']
])

const SEEDED_PRINT_PROGRESS = new Map<string, Pick<PrinterStatus, 'subStage' | 'progressPercent' | 'currentLayer' | 'totalLayers' | 'remainingMinutes'>>([
  ['DEMO-H2D-001', { subStage: 'Layer 12 / 164', progressPercent: 7, currentLayer: 12, totalLayers: 164, remainingMinutes: 134 }],
  ['DEMO-P1S-001', { subStage: 'Layer 27 / 150', progressPercent: 18, currentLayer: 27, totalLayers: 150, remainingMinutes: 73 }],
  ['DEMO-X1C-002', { subStage: 'Layer 86 / 205', progressPercent: 42, currentLayer: 86, totalLayers: 205, remainingMinutes: 57 }],
  ['DEMO-H2D-002', { subStage: 'Layer 143 / 210', progressPercent: 68, currentLayer: 143, totalLayers: 210, remainingMinutes: 31 }],
  ['DEMO-P1S-002', { subStage: 'Layer 188 / 206', progressPercent: 91, currentLayer: 188, totalLayers: 206, remainingMinutes: 9 }]
])

const IDLE_DEMO_CAMERA_STAGES = new Set<PrinterStatus['stage']>(['idle', 'finished', 'failed'])
const IDLE_DEMO_CAMERA_SNAPSHOT_NAMES = [
  'chamber-blue-bin.jpg',
  'chamber-green-bin.jpg',
  'chamber-purple-part.jpg'
]

const HEATBED_LIGHT_MODELS = new Set<Printer['model']>(['H2D', 'H2DPRO', 'H2C', 'H2S'])
const DUAL_NOZZLE_MODELS = new Set<Printer['model']>(['X2D', 'H2D', 'H2DPRO', 'H2C'])
const WORK_LIGHT_MODELS = new Set<Printer['model']>(['A1', 'A1mini'])
let cachedDemoCameraSnapshots: string[] | null = null
let cachedDemoCameraSnapshotsAtMs = 0
let demoCameraSnapshotRenderer: DemoCameraSnapshotRenderer = renderDemoCameraSnapshotBufferWithFfmpeg
let demoCameraNow = (): number => Date.now()

const DEMO_CAMERA_REFRESH_MS = 5_000
const DEMO_CAMERA_ROTATION_MS = 5_000
const DEMO_CAMERA_FRAME_INTERVAL_MS = 250

const cachedDemoCameraSnapshotBase64ByPath = new Map<string, string>()
const cachedDemoCaptureFrameBase64ByKey = new Map<string, string>()
const cachedDemoCaptureDurationSecondsByPath = new Map<string, number | null>()

export class DemoBridgeSimulator {
  private readonly printers = new Map<string, SimulatedPrinterState>()
  private readonly watchedCameraPrinterIds = new Set<string>()
  private statusTimer: ReturnType<typeof setInterval> | null = null
  private cameraTimer: ReturnType<typeof setInterval> | null = null
  private sendMessage: ((message: BridgeRuntimeInboundMessage) => void) | null = null

  constructor(private readonly options: DemoSimulatorOptions = {}) {}

  start(sendMessage: (message: BridgeRuntimeInboundMessage) => void): void {
    this.sendMessage = sendMessage
    const statusIntervalMs = this.options.statusIntervalMs ?? 10_000
    if (statusIntervalMs > 0 && !this.statusTimer) {
      this.statusTimer = setInterval(() => this.advanceAllPrinters(), statusIntervalMs)
    }
    const cameraFrameIntervalMs = this.options.cameraFrameIntervalMs ?? DEMO_CAMERA_FRAME_INTERVAL_MS
    if (cameraFrameIntervalMs > 0 && !this.cameraTimer) {
      this.cameraTimer = setInterval(() => this.emitWatchedCameraFrames(), cameraFrameIntervalMs)
    }
  }

  stop(): void {
    if (this.statusTimer) {
      clearInterval(this.statusTimer)
      this.statusTimer = null
    }
    if (this.cameraTimer) {
      clearInterval(this.cameraTimer)
      this.cameraTimer = null
    }
    this.printers.clear()
    this.watchedCameraPrinterIds.clear()
    this.sendMessage = null
  }

  updatePrinters(printers: readonly Printer[]): void {
    const nextIds = new Set(printers.map((printer) => printer.id))
    for (const printerId of this.printers.keys()) {
      if (!nextIds.has(printerId)) {
        this.printers.delete(printerId)
        this.send({ type: 'bridge.printer.removed', printerId })
      }
    }

    for (const printer of printers) {
      const existing = this.printers.get(printer.id)
      const status = existing
        ? { ...existing.status, printerId: printer.id, ipAddress: printer.host, observedAt: new Date().toISOString() }
        : buildInitialStatus(printer)
      this.printers.set(printer.id, { printer, status })
      this.emitStatus(printer.id)
      if (!existing) {
        void this.refreshSeededScenarioSelection(printer.id)
      }
    }
  }

  handleCommand(message: BridgeCommandMessage): void {
    const state = this.printers.get(message.printer.id)
    if (!state) return

    const payload = message.payload
    const printCommand = readNestedCommand(payload, 'print')
    const systemCommand = readNestedCommand(payload, 'system')

    if (printCommand === 'pause') {
      state.status = {
        ...state.status,
        stage: 'paused',
        subStage: 'Paused by demo command',
        observedAt: new Date().toISOString()
      }
      this.emitStatus(message.printer.id)
      return
    }

    if (printCommand === 'resume') {
      state.status = {
        ...state.status,
        stage: 'printing',
        subStage: buildLayerSubStage(state.status),
        observedAt: new Date().toISOString()
      }
      this.emitStatus(message.printer.id)
      return
    }

    if (printCommand === 'stop') {
      state.status = cancelStatus(state.status)
      this.emitStatus(message.printer.id)
      return
    }

    if (printCommand === 'project_file' || printCommand === 'gcode_file') {
      state.status = startPrintStatus(state.status, payload)
      this.emitStatus(message.printer.id)
      void this.refreshActivePrintSelection(message.printer.id, state.status.jobId, readPrintFileName(payload))
      return
    }

    if (systemCommand === 'ledctrl' || printCommand === 'ledctrl') {
      state.status = toggleLightStatus(state.status, payload)
      this.emitStatus(message.printer.id)
      return
    }

    this.emitStatus(message.printer.id)
  }

  handleRpcRequest(request: BridgeRpcRequestMessage): boolean {
    try {
      if (request.method === 'camera.snapshot') {
        const params = request.params as { printer?: { id?: unknown } }
        const printerId = typeof params.printer?.id === 'string'
          ? params.printer.id
          : null
        const state = printerId ? this.printers.get(printerId) ?? null : null
        this.send({
          type: 'bridge.rpc.success',
          id: request.id,
          result: { jpegBase64: getDemoCameraSnapshotBase64(state) }
        })
        return true
      }

      if (request.method === 'bridge.ping') {
        this.send({
          type: 'bridge.rpc.success',
          id: request.id,
          result: { respondedAt: new Date().toISOString() }
        })
        return true
      }

      if (request.method === 'bridge.update.check' || request.method === 'bridge.update.install') {
        this.send({
          type: 'bridge.rpc.success',
          id: request.id,
          result: { accepted: false, status: 'current', message: 'Bridge is current.' }
        })
        return true
      }

      if (request.method === 'storage.list') {
        const params = request.params as { path?: unknown; recursive?: unknown }
        this.send({
          type: 'bridge.rpc.success',
          id: request.id,
          result: { entries: listStorageEntries(typeof params.path === 'string' ? params.path : '/', params.recursive === true) }
        })
        return true
      }

      if (request.method === 'storage.download') {
        const params = request.params as { path?: unknown; remotePath?: unknown }
        const filePath = typeof params.path === 'string'
          ? params.path
          : typeof params.remotePath === 'string'
            ? params.remotePath
            : null
        const asset = filePath ? resolveDemoStorageAsset(filePath) : null
        this.send({
          type: 'bridge.rpc.success',
          id: request.id,
          result: {
            bufferBase64: asset
              ? readFileSync(asset.localPath).toString('base64')
              : Buffer.from('Demo bridge placeholder file\n', 'utf8').toString('base64')
          }
        })
        return true
      }

      if (request.method === 'storage.fileSize') {
        const params = request.params as { path?: unknown; remotePath?: unknown }
        const filePath = typeof params.path === 'string'
          ? params.path
          : typeof params.remotePath === 'string'
            ? params.remotePath
            : null
        const asset = filePath ? resolveDemoStorageAsset(filePath) : null
        this.send({
          type: 'bridge.rpc.success',
          id: request.id,
          result: { sizeBytes: asset?.sizeBytes ?? 24 }
        })
        return true
      }

      if (request.method === 'storage.upload' || request.method === 'storage.uploadLibraryFile' || request.method === 'storage.uploadLibraryPlateFile') {
        const params = request.params as { remotePath?: unknown; fileBase64?: unknown }
        const remotePath = typeof params.remotePath === 'string' && params.remotePath.trim() ? params.remotePath : '/demo-upload.gcode.3mf'
        const sizeBytes = typeof params.fileBase64 === 'string'
          ? Buffer.byteLength(params.fileBase64, 'base64')
          : 24
        this.send({ type: 'bridge.rpc.progress', id: request.id, bytesSent: sizeBytes, totalBytes: sizeBytes })
        this.send({
          type: 'bridge.rpc.success',
          id: request.id,
          result: { path: remotePath, sizeBytes }
        })
        return true
      }

      if (request.method === 'storage.rename' || request.method === 'storage.delete') {
        this.send({ type: 'bridge.rpc.success', id: request.id, result: null })
        return true
      }

      if (request.method === 'storage.readZipEntries') {
        this.send({
          type: 'bridge.rpc.success',
          id: request.id,
          result: { entries: {}, remoteSize: 24, bytesRead: 24 }
        })
        return true
      }

      if (request.method === 'printer.validateConnection') {
        this.send({
          type: 'bridge.rpc.success',
          id: request.id,
          result: { ok: true, mqttReachable: true, developerModeEnabled: true, warnings: [] }
        })
        return true
      }

      return false
    } catch (error) {
      this.send({
        type: 'bridge.rpc.error',
        id: request.id,
        error: (error as Error).message || 'Demo bridge RPC failed'
      })
      return true
    }
  }

  watchCamera(printerId: string): void {
    this.watchedCameraPrinterIds.add(printerId)
    this.emitCameraFrame(printerId)
  }

  unwatchCamera(printerId: string): void {
    this.watchedCameraPrinterIds.delete(printerId)
  }

  private advanceAllPrinters(): void {
    for (const state of this.printers.values()) {
      if (state.status.stage !== 'printing') continue
      state.status = advancePrintStatus(state.status)
      this.emitStatus(state.printer.id)
    }

    this.emitWatchedCameraFrames()
  }

  private emitStatus(printerId: string): void {
    const status = this.printers.get(printerId)?.status
    if (!status) return
    this.send({ type: 'bridge.printer.status', printer: printerStatusSchema.parse(status) })
  }

  private emitCameraFrame(printerId: string): void {
    const state = this.printers.get(printerId)
    if (!state || !this.watchedCameraPrinterIds.has(printerId)) return
    this.send({
      type: 'bridge.camera.frame',
      printerId,
      jpegBase64: getDemoCameraFrameBase64(state)
    })
  }

  private emitWatchedCameraFrames(): void {
    for (const printerId of this.watchedCameraPrinterIds) {
      this.emitCameraFrame(printerId)
    }
  }

  private send(message: BridgeRuntimeInboundMessage): void {
    this.sendMessage?.(message)
  }

  private async refreshSeededScenarioSelection(printerId: string): Promise<void> {
    const current = this.printers.get(printerId)
    if (!current) return

    const scenario = SEEDED_DEMO_SCENARIOS.get(current.printer.serial) ?? 'idle'
    if (scenario === 'idle') return

    const compatibleFile = await resolveCompatibleDemoLibraryFileForPrinter(current.printer)
    if (!compatibleFile) return
    const demoFile = await resolveDemoLibraryFileSelection(
      compatibleFile,
      getDemoPrinterActiveJob(current.printer.serial)?.plate ?? null
    )
    const baseStatus = buildIdleStatus(current.printer)
    const nextStatus = buildSeededScenarioStatus(current.printer, baseStatus, demoFile, scenario)

    const latest = this.printers.get(printerId)
    if (!latest || latest.status.jobId !== current.status.jobId) return
    latest.status = nextStatus
    this.emitStatus(printerId)
  }

  private async refreshActivePrintSelection(printerId: string, jobId: string | null, fileName: string | null): Promise<void> {
    if (!jobId || !fileName) return

    const current = this.printers.get(printerId)
    if (!current) return

    const compatibleFile = await resolveCompatibleDemoLibraryFileForPrinter(current.printer, fileName)
    if (!compatibleFile) return
    const selectedFile = await resolveDemoLibraryFileSelection(compatibleFile)

    const latest = this.printers.get(printerId)
    if (!latest || latest.status.jobId !== jobId || latest.status.stage !== 'printing') return
    latest.status = {
      ...latest.status,
      jobName: selectedFile.jobName,
      lastJobName: selectedFile.jobName,
      taskId: buildSeededTaskId(latest.printer, selectedFile),
      gcodeFile: buildDemoObservedGcodeFile(selectedFile),
      observedAt: new Date().toISOString()
    }
    this.emitStatus(printerId)
  }
}

function buildInitialStatus(printer: Printer): PrinterStatus {
  const status = buildIdleStatus(printer)
  const scenario = SEEDED_DEMO_SCENARIOS.get(printer.serial) ?? 'idle'
  if (scenario === 'printing') {
    return buildSeededPrintingStatus(printer, status, getDemoLibraryFileForPrinter(printer))
  }
  if (scenario === 'paused') {
    return buildSeededScenarioStatus(printer, status, getDemoLibraryFileForPrinter(printer), scenario)
  }
  if (scenario === 'failed') {
    return buildSeededScenarioStatus(printer, status, getDemoLibraryFileForPrinter(printer), scenario)
  }
  if (scenario === 'finished') {
    return buildSeededScenarioStatus(printer, status, getDemoLibraryFileForPrinter(printer), scenario)
  }
  return status
}

function buildSeededScenarioStatus(
  printer: Printer,
  status: PrinterStatus,
  demoFile: DemoLibraryFile,
  scenario: DemoPrinterScenario
): PrinterStatus {
  if (scenario === 'printing') {
    return buildSeededPrintingStatus(printer, status, demoFile)
  }
  if (scenario === 'paused') {
    const seededProgress = getSeededPrintProgress(printer)
    return {
      ...buildSeededPrintingStatus(printer, status, demoFile),
      stage: 'paused',
      subStage: 'Paused for filament change',
      progressPercent: seededProgress.progressPercent,
      currentLayer: seededProgress.currentLayer,
      totalLayers: seededProgress.totalLayers,
      remainingMinutes: seededProgress.remainingMinutes,
      ams: activateAmsSlot(status.ams, 0, 1),
      externalSpools: clearActiveExternalSpools(status.externalSpools),
      observedAt: new Date().toISOString()
    }
  }
  if (scenario === 'failed') {
    return buildSeededFailedStatus(printer, status, demoFile)
  }
  if (scenario === 'finished') {
    return buildSeededFinishedStatus(printer, status, demoFile)
  }
  return status
}

function buildIdleStatus(printer: Printer): PrinterStatus {
  const nozzles = printer.currentNozzleDiameters.length > 0
    ? printer.currentNozzleDiameters.map((selection) => ({
        extruderId: selection.extruderId,
        diameter: selection.diameter ?? '0.4',
        typeCode: 'HS00',
        material: 'stainless-steel',
        flow: 'standard',
        currentTemp: 32,
        targetTemp: null
      }))
    : [{ extruderId: 0, diameter: '0.4', typeCode: 'HS00', material: 'stainless-steel', flow: 'standard', currentTemp: 32, targetTemp: null }]
  const displayCapabilities = getPrinterDisplayCapabilities(printer.model)
  const printOptions = buildPrintOptions(printer.model)

  return printerStatusSchema.parse({
    printerId: printer.id,
    online: true,
    stage: 'idle',
    subStage: 'Ready to print',
    filamentChange: { currentStepIndex: null, currentStepLabel: null, steps: [] },
    progressPercent: null,
    currentLayer: null,
    totalLayers: null,
    remainingMinutes: null,
    jobId: null,
    taskId: null,
    jobName: null,
    lastJobName: null,
    gcodeFile: null,
    bedTemp: 31,
    bedTarget: null,
    nozzleTemp: nozzles[0]?.currentTemp ?? null,
    nozzleTarget: null,
    nozzles,
    chamberTemp: displayCapabilities.chamberTemperature ? (DUAL_NOZZLE_MODELS.has(printer.model) ? 29 : 27) : null,
    chamberTarget: displayCapabilities.chamberTemperature ? 45 : null,
    fanGearSpeed: 2,
    partFanPercent: 0,
    auxFanPercent: 0,
    chamberFanPercent: 0,
    wifiSignalDbm: -45,
    ipAddress: printer.host,
    doorOpen: displayCapabilities.doorState ? false : null,
    ductMode: displayCapabilities.airductMode ? 'cooling' : null,
    ductAvailableModes: displayCapabilities.airductMode ? ['cooling', 'heating'] : [],
    lightModes: {
      chamber: 'on',
      heatbed: HEATBED_LIGHT_MODELS.has(printer.model) ? 'off' : null,
      work: WORK_LIGHT_MODELS.has(printer.model) ? 'on' : null
    },
    lightCapabilities: {
      chamber: true,
      heatbed: HEATBED_LIGHT_MODELS.has(printer.model),
      work: WORK_LIGHT_MODELS.has(printer.model)
    },
    chamberLightOffRequiresConfirm: false,
    lightOn: true,
    speedLevel: null,
    commandTransport: {
      mqttBedTemperature: false,
      mqttAxisControl: false,
      mqttHoming: false,
      newFanControl: false
    },
    printStartOptions: getPrinterPrintStartOptions(printer.model, { printOptions }),
    printOptions,
    deviceError: null,
    hmsErrors: [],
    amsSettings: {
      detectOnInsert: true,
      detectOnPowerup: true,
      remainEnabled: true,
      autoRefill: true,
      supportFilamentBackup: true
    },
    ams: buildAmsUnits(printer),
    externalSpools: buildExternalSpools(printer),
    firmwareVersion: '99.99.99.99-demo',
    sdCardPresent: true,
    observedAt: new Date().toISOString()
  })
}

function buildSeededPrintingStatus(printer: Printer, status: PrinterStatus, demoFile: DemoLibraryFile): PrinterStatus {
  const seededProgress = getSeededPrintProgress(printer)
  return {
    ...status,
    stage: 'printing',
    subStage: seededProgress.subStage,
    progressPercent: seededProgress.progressPercent,
    currentLayer: seededProgress.currentLayer,
    totalLayers: seededProgress.totalLayers,
    remainingMinutes: seededProgress.remainingMinutes,
    jobId: 'demo-seeded-print',
    taskId: buildSeededTaskId(printer, demoFile),
    jobName: demoFile.jobName,
    lastJobName: demoFile.jobName,
    gcodeFile: buildDemoObservedGcodeFile(demoFile),
    bedTemp: 55,
    bedTarget: 55,
    nozzleTemp: 220,
    nozzleTarget: 220,
    nozzles: status.nozzles.map((nozzle, index) => ({ ...nozzle, currentTemp: index === 0 ? 220 : 32, targetTemp: index === 0 ? 220 : null })),
    chamberTemp: status.chamberTemp == null ? null : 34,
    partFanPercent: 70,
    auxFanPercent: 45,
    chamberFanPercent: 30,
    speedLevel: 2,
    ams: activateAmsSlot(status.ams, 0, 0),
    externalSpools: clearActiveExternalSpools(status.externalSpools),
    observedAt: new Date().toISOString()
  }
}

function getSeededPrintProgress(printer: Printer): Pick<PrinterStatus, 'subStage' | 'progressPercent' | 'currentLayer' | 'totalLayers' | 'remainingMinutes'> {
  return SEEDED_PRINT_PROGRESS.get(printer.serial)
    ?? { subStage: 'Layer 86 / 205', progressPercent: 42, currentLayer: 86, totalLayers: 205, remainingMinutes: 57 }
}

function buildSeededFailedStatus(printer: Printer, status: PrinterStatus, demoFile: DemoLibraryFile): PrinterStatus {
  return {
    ...buildSeededPrintingStatus(printer, status, demoFile),
    stage: 'failed',
    subStage: 'Nozzle clumping detected',
    progressPercent: 63,
    currentLayer: 118,
    totalLayers: 186,
    remainingMinutes: null,
    jobName: null,
    gcodeFile: null,
    deviceError: {
      code: 'demo_nozzle_clumping',
      message: 'Nozzle clumping detected. Clear the nozzle before starting the print again.'
    },
    hmsErrors: [{
      code: '0C0003000002001C',
      message: 'Potential hotend clumping detected.'
    }],
    partFanPercent: 0,
    auxFanPercent: 0,
    chamberFanPercent: 15,
    ams: clearActiveAmsSlots(status.ams),
    externalSpools: clearActiveExternalSpools(status.externalSpools),
    observedAt: new Date().toISOString()
  }
}

function buildSeededFinishedStatus(printer: Printer, status: PrinterStatus, demoFile: DemoLibraryFile): PrinterStatus {
  return {
    ...finishStatus(buildSeededPrintingStatus(printer, status, demoFile), 'finished', 'Print completed'),
    lastJobName: demoFile.jobName,
    deviceError: null,
    hmsErrors: [],
    ams: clearActiveAmsSlots(status.ams),
    externalSpools: clearActiveExternalSpools(status.externalSpools),
    observedAt: new Date().toISOString()
  }
}

function buildSeededTaskId(printer: Printer, demoFile: DemoLibraryFile): string {
  return `demo-task-${printer.serial}-${demoFile.fileName}${demoFile.selectedPlate ? `-plate-${demoFile.selectedPlate}` : ''}`
}

function getDemoCameraSnapshotBase64(state: SimulatedPrinterState | null): string {
  const printer = state?.printer ?? null
  const stage = state?.status.stage ?? null
  const definition = state ? resolveDemoPrintDefinitionForState(state) : null
  const captureSnapshots = definition ? loadDemoCaptureSnapshots(definition) : []

  if (captureSnapshots.length > 0) {
    const selectedIndex = IDLE_DEMO_CAMERA_STAGES.has(stage ?? 'idle')
      ? chooseStableDemoCameraSnapshotIndex(printer?.id ?? printer?.serial ?? null, captureSnapshots.length)
      : chooseDemoCameraSnapshotIndex(printer?.id ?? printer?.serial ?? null, captureSnapshots.length, demoCameraNow())
    return captureSnapshots[selectedIndex] ?? captureSnapshots[0] ?? FALLBACK_DEMO_CAMERA_JPEG_BASE64
  }

  const idleSnapshot = printer ? loadIdleDemoCameraSnapshot(printer, stage) : null
  if (idleSnapshot) return idleSnapshot

  const snapshots = loadDemoCameraSnapshots()
  if (snapshots.length === 0) return FALLBACK_DEMO_CAMERA_JPEG_BASE64

  const selectedIndex = chooseDemoCameraSnapshotIndex(printer?.id ?? printer?.serial ?? null, snapshots.length, demoCameraNow())
  return snapshots[selectedIndex] ?? FALLBACK_DEMO_CAMERA_JPEG_BASE64
}

function getDemoCameraFrameBase64(state: SimulatedPrinterState | null): string {
  const definition = state ? resolveDemoPrintDefinitionForState(state) : null
  const stage = state?.status.stage ?? null
  const captureFrame = definition
    ? renderDemoCaptureFrameBase64(definition, IDLE_DEMO_CAMERA_STAGES.has(stage ?? 'idle') ? 0 : demoCameraNow())
    : null
  if (captureFrame) return captureFrame
  return getDemoCameraSnapshotBase64(state)
}

export function chooseDemoCameraSnapshotIndex(printerId: string | null, snapshotCount: number, nowMs: number): number {
  if (snapshotCount <= 1) return 0
  const rotationBucket = Math.floor(nowMs / DEMO_CAMERA_ROTATION_MS)
  return (positiveHash(printerId ?? 'demo-camera') + rotationBucket) % snapshotCount
}

function chooseStableDemoCameraSnapshotIndex(printerId: string | null, snapshotCount: number): number {
  if (snapshotCount <= 1) return 0
  return positiveHash(printerId ?? 'demo-camera') % snapshotCount
}

export function chooseIdleDemoCameraSnapshotName(
  printerId: string | null,
  availableFileNames: readonly string[] = IDLE_DEMO_CAMERA_SNAPSHOT_NAMES
): string | null {
  if (availableFileNames.length === 0) return null
  const selectedIndex = chooseDemoCameraSnapshotIndex(printerId, availableFileNames.length, 0)
  return availableFileNames[selectedIndex] ?? null
}

function loadDemoCameraSnapshots(): string[] {
  if (cachedDemoCameraSnapshots && demoCameraNow() - cachedDemoCameraSnapshotsAtMs < DEMO_CAMERA_REFRESH_MS) {
    return cachedDemoCameraSnapshots
  }

  try {
    cachedDemoCameraSnapshots = readdirSync(DEMO_CAMERA_SNAPSHOT_DIR)
      .filter((fileName) => fileName.toLowerCase().endsWith('.jpg') || fileName.toLowerCase().endsWith('.jpeg'))
      .sort((left, right) => left.localeCompare(right))
      .map((fileName) => renderDemoCameraSnapshotFileBase64(path.join(DEMO_CAMERA_SNAPSHOT_DIR, fileName)))
      .filter((value) => value.length > 0)
  } catch {
    cachedDemoCameraSnapshots = []
  }
  cachedDemoCameraSnapshotsAtMs = demoCameraNow()

  return cachedDemoCameraSnapshots
}

function loadIdleDemoCameraSnapshot(printer: Printer, stage: PrinterStatus['stage'] | null): string | null {
  if (!stage || !IDLE_DEMO_CAMERA_STAGES.has(stage)) return null

  const fileName = chooseIdleDemoCameraSnapshotName(printer.id || printer.serial)
  if (!fileName) return null

  const filePath = path.join(DEMO_CAMERA_SNAPSHOT_DIR, fileName)
  try {
    return renderDemoCameraSnapshotFileBase64(filePath)
  } catch {
    return null
  }
}

function loadDemoCaptureSnapshots(definition: DemoPrintDefinition): string[] {
  const captureMedia = resolveDemoCaptureMedia(definition)
  if (!captureMedia) return []

  const snapshots = captureMedia.snapshotPaths
    .map((filePath) => renderDemoCameraSnapshotFileBase64(filePath))
    .filter((value) => value.length > 0)
  if (snapshots.length > 0) {
    return snapshots
  }

  if (!captureMedia.streamPath) {
    return []
  }

  const streamSnapshot = renderDemoCaptureFrameBase64FromStreamPath(captureMedia.streamPath, 0, 'snapshot')
  return streamSnapshot ? [streamSnapshot] : []
}

export function renderDemoCameraSnapshotBase64(filePath: string): string {
  return renderDemoCameraSnapshotFileBase64(filePath)
}

function renderDemoCameraSnapshotFileBase64(filePath: string): string {
  const cached = cachedDemoCameraSnapshotBase64ByPath.get(filePath)
  if (cached) return cached

  const watermarked = demoCameraSnapshotRenderer(filePath)
  const rendered = watermarked ? watermarked.toString('base64') : readFileSync(filePath).toString('base64')
  cachedDemoCameraSnapshotBase64ByPath.set(filePath, rendered)
  return rendered
}

export function setDemoCameraSnapshotRendererForTests(renderer: DemoCameraSnapshotRenderer | null): void {
  demoCameraSnapshotRenderer = renderer ?? renderDemoCameraSnapshotBufferWithFfmpeg
  cachedDemoCameraSnapshotBase64ByPath.clear()
}

export function setDemoCameraNowForTests(getNow: (() => number) | null): void {
  demoCameraNow = getNow ?? (() => Date.now())
  cachedDemoCameraSnapshots = null
  cachedDemoCameraSnapshotsAtMs = 0
  cachedDemoCameraSnapshotBase64ByPath.clear()
}

function renderDemoCameraSnapshotBufferWithFfmpeg(filePath: string): Buffer | null {
  const result = childProcess.spawnSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    filePath,
    '-vf',
    DEMO_CAMERA_WATERMARK_FILTER,
    '-frames:v',
    '1',
    '-f',
    'image2pipe',
    '-vcodec',
    'mjpeg',
    'pipe:1'
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024
  })

  if (result.error || result.status !== 0 || !result.stdout || result.stdout.length === 0) {
    return null
  }

  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout)
}

function resolveDemoPrintDefinitionForState(state: SimulatedPrinterState): DemoPrintDefinition | null {
  const currentDefinition = findDemoPrintDefinitionByJobName(state.status.jobName)
    ?? findDemoPrintDefinitionByFileName(state.status.gcodeFile)
  if (currentDefinition) {
    return currentDefinition
  }

  if (!IDLE_DEMO_CAMERA_STAGES.has(state.status.stage)) {
    return findDemoPrintDefinitionByFileName(getDemoPrinterActiveJob(state.printer.serial)?.fileName)
  }

  return findDemoPrintDefinitionByJobName(state.status.lastJobName)
    ?? findDemoPrintDefinitionByFileName(getDemoPrinterRecentFinishedJob(state.printer.serial)?.fileName)
}

interface DemoCaptureMedia {
  snapshotPaths: string[]
  streamPath: string | null
}

function resolveDemoCaptureMedia(definition: DemoPrintDefinition): DemoCaptureMedia | null {
  const captureDirectoryName = definition.media?.captureDirectoryName
  if (!captureDirectoryName) return null

  const captureDirectoryPath = path.join(DEMO_CAPTURES_DIR, captureDirectoryName)

  try {
    const fileNames = readdirSync(captureDirectoryPath).sort((left, right) => left.localeCompare(right))
    const snapshotPaths = fileNames
      .filter((fileName) => fileName.toLowerCase().endsWith('.jpg') || fileName.toLowerCase().endsWith('.jpeg'))
      .map((fileName) => path.join(captureDirectoryPath, fileName))
    const streamFileName = chooseDemoCaptureStreamFileName(fileNames, definition.media?.captureStreamFileName)

    return {
      snapshotPaths,
      streamPath: streamFileName ? path.join(captureDirectoryPath, streamFileName) : null
    }
  } catch {
    return null
  }
}

export function chooseDemoCaptureStreamFileName(
  fileNames: readonly string[],
  preferredFileName: string | null | undefined
): string | null {
  if (preferredFileName && fileNames.includes(preferredFileName)) {
    return preferredFileName
  }

  const streamCandidates = fileNames.filter((fileName) => fileName.toLowerCase().endsWith('.mp4'))
  if (streamCandidates.length === 0) {
    return null
  }

  const explicitStream = streamCandidates.find((fileName) => fileName.toLowerCase().includes('stream'))
  if (explicitStream) {
    return explicitStream
  }

  return streamCandidates[0] ?? null
}

function renderDemoCaptureFrameBase64(definition: DemoPrintDefinition, nowMs: number): string | null {
  const streamPath = resolveDemoCaptureMedia(definition)?.streamPath
  if (!streamPath) return null

  return renderDemoCaptureFrameBase64FromStreamPath(streamPath, nowMs)
}

function renderDemoCaptureFrameBase64FromStreamPath(
  streamPath: string,
  nowMs: number,
  cacheSuffix = 'frame'
): string | null {
  const frameBucket = Math.floor(nowMs / DEMO_CAMERA_FRAME_INTERVAL_MS)
  const cacheKey = `${streamPath}\u0000${cacheSuffix}\u0000${frameBucket}`
  const cached = cachedDemoCaptureFrameBase64ByKey.get(cacheKey)
  if (cached) return cached

  const durationSeconds = getDemoCaptureDurationSeconds(streamPath)
  const seekSeconds = durationSeconds && durationSeconds > 0
    ? (frameBucket % Math.max(1, Math.ceil(durationSeconds * 2))) / 2
    : frameBucket % 30
  const result = childProcess.spawnSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    seekSeconds.toFixed(2),
    '-i',
    streamPath,
    '-frames:v',
    '1',
    '-f',
    'image2pipe',
    '-vcodec',
    'mjpeg',
    'pipe:1'
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024
  })

  if (result.error || result.status !== 0 || !result.stdout || result.stdout.length === 0) {
    return null
  }

  const base64 = (Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout)).toString('base64')
  cachedDemoCaptureFrameBase64ByKey.set(cacheKey, base64)
  if (cachedDemoCaptureFrameBase64ByKey.size > 32) {
    const oldestKey = cachedDemoCaptureFrameBase64ByKey.keys().next().value
    if (oldestKey) cachedDemoCaptureFrameBase64ByKey.delete(oldestKey)
  }
  return base64
}

function getDemoCaptureDurationSeconds(filePath: string): number | null {
  if (cachedDemoCaptureDurationSecondsByPath.has(filePath)) {
    return cachedDemoCaptureDurationSecondsByPath.get(filePath) ?? null
  }

  const result = childProcess.spawnSync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    filePath
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024
  })

  const rawDuration = Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8') : String(result.stdout ?? '')
  const parsedDuration = result.error || result.status !== 0 ? Number.NaN : Number.parseFloat(rawDuration.trim())
  const duration = Number.isFinite(parsedDuration) && parsedDuration > 0 ? parsedDuration : null
  cachedDemoCaptureDurationSecondsByPath.set(filePath, duration)
  return duration
}

function positiveHash(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0
  }
  return Math.abs(hash)
}

function buildPrintOptions(model: Printer['model']): PrinterPrintOptions {
  const capabilities = getPrinterPrintOptionCapabilities(model)
  return {
    aiMonitoring: { supported: capabilities.flowCalibration, enabled: capabilities.flowCalibration ? true : null, sensitivity: capabilities.flowCalibration ? 'medium' : null },
    spaghettiDetection: { supported: capabilities.flowCalibration, enabled: capabilities.flowCalibration ? true : null, sensitivity: capabilities.flowCalibration ? 'medium' : null },
    purgeChutePileupDetection: { supported: capabilities.flowCalibration, enabled: capabilities.flowCalibration ? true : null, sensitivity: capabilities.flowCalibration ? 'medium' : null },
    nozzleClumpingDetection: { supported: capabilities.flowCalibration, enabled: capabilities.flowCalibration ? false : null, sensitivity: capabilities.flowCalibration ? 'medium' : null },
    airPrintingDetection: { supported: capabilities.flowCalibration, enabled: capabilities.flowCalibration ? false : null, sensitivity: capabilities.flowCalibration ? 'medium' : null },
    firstLayerInspection: { supported: capabilities.firstLayerInspection, enabled: capabilities.firstLayerInspection ? true : null },
    autoRecovery: { supported: true, enabled: true },
    promptSound: { supported: true, enabled: true },
    filamentTangleDetection: { supported: true, enabled: true }
  }
}

function buildAmsUnits(printer: Printer): PrinterStatus['ams'] {
  switch (printer.serial) {
    case 'DEMO-X1C-001':
      return [
        makeAmsUnit(0, 0, false, 2, null, 27, [
          makeSlot(0, { trayName: 'PLA Basic Gray', filamentType: 'PLA Basic', trayInfoIdx: 'GFA00', color: '#A8ADB4', remainPercent: 6, trayUuid: 'DEMO-RFID-X1C1-0', k: 0.018 }),
          makeSlot(1, { trayName: 'PLA Basic Gray', filamentType: 'PLA Basic', trayInfoIdx: 'GFA00', color: '#A8ADB4', remainPercent: 43, trayUuid: 'DEMO-RFID-X1C1-1', k: 0.018 }),
          makeSlot(2, { trayName: 'PETG HF Teal', filamentType: 'PETG HF', color: '#138A8A', remainPercent: 54, trayUuid: 'DEMO-RFID-X1C1-2', k: 0.024 }),
          makeSlot(3, { trayName: 'PLA Silk Copper', filamentType: 'PLA Silk', color: '#A05B32', remainPercent: 63, trayUuid: 'DEMO-RFID-X1C1-3', k: 0.022 })
        ])
      ]
    case 'DEMO-X1C-002':
      return [
        makeAmsUnit(0, 0, false, 2, null, 26, [
          makeSlot(0, { trayName: 'ABS Orange', filamentType: 'ABS', trayInfoIdx: 'GFB99', color: '#E05A2B', remainPercent: 52, trayUuid: 'DEMO-RFID-X1C2-0', k: 0.028 }),
          makeSlot(1, { trayName: 'PLA Matte White', filamentType: 'PLA Matte', trayInfoIdx: 'GFL00', color: '#F5F5F3', remainPercent: 36, trayUuid: 'DEMO-RFID-X1C2-1', k: 0.022 }),
          makeSlot(2, { trayName: 'PETG HF Ocean Blue', filamentType: 'PETG HF', color: '#2B5FDE', remainPercent: 58, trayUuid: 'DEMO-RFID-X1C2-2', k: 0.023 }),
          makeSlot(3, { trayName: 'ASA Charcoal', filamentType: 'ASA', trayInfoIdx: 'GFB02', color: '#4A4F57', remainPercent: 41, trayUuid: 'DEMO-RFID-X1C2-3', k: 0.026 })
        ])
      ]
    case 'DEMO-P1S-001':
      return [
        makeAmsUnit(0, 0, false, 2, null, 27, [
          makeSlot(0, { trayName: 'PLA Basic Scarlet Red', filamentType: 'PLA Basic', trayInfoIdx: 'GFA05', color: '#C73B3B', remainPercent: 33, trayUuid: 'DEMO-RFID-P1S1-0', k: 0.02 }),
          makeSlot(1, { trayName: 'PETG HF Black', filamentType: 'PETG HF', trayInfoIdx: 'GFG01', color: '#1C1C1C', remainPercent: 9, trayUuid: 'DEMO-RFID-P1S1-1', k: 0.023 }),
          makeSlot(2, { trayName: 'PETG HF Black', filamentType: 'PETG HF', trayInfoIdx: 'GFG01', color: '#1C1C1C', remainPercent: 66, trayUuid: 'DEMO-RFID-P1S1-2', k: 0.023 }),
          makeSlot(3, { trayName: 'PLA Matte Sakura Pink', filamentType: 'PLA Matte', color: '#E6A6B3', remainPercent: 47, trayUuid: 'DEMO-RFID-P1S1-3', k: 0.022 })
        ])
      ]
    case 'DEMO-P1S-002':
      return [
        makeAmsUnit(0, 0, false, 3, null, 28, [
          makeSlot(0, { trayName: 'PLA Basic Lime Green', filamentType: 'PLA Basic', color: '#74C365', remainPercent: 8, trayUuid: 'DEMO-RFID-P1S2-0', k: 0.019 }),
          makeSlot(1, { trayName: 'PLA Basic Lime Green', filamentType: 'PLA Basic', color: '#74C365', remainPercent: 48, trayUuid: 'DEMO-RFID-P1S2-1', k: 0.019 }),
          makeSlot(2, { trayName: 'PLA Basic Violet', filamentType: 'PLA Basic', color: '#7A5AF8', remainPercent: 52, trayUuid: 'DEMO-RFID-P1S2-2', k: 0.02 }),
          makeSlot(3, { trayName: 'PETG HF Glacier Blue', filamentType: 'PETG HF', color: '#67B7D1', remainPercent: 44, trayUuid: 'DEMO-RFID-P1S2-3', k: 0.024 })
        ])
      ]
    case 'DEMO-H2D-001':
      return [
        makeAmsUnit(0, 0, true, null, null, 28, [
          makeSlot(0, { trayName: 'PLA Basic Gray', filamentType: 'PLA Basic', trayInfoIdx: 'GFA00', color: '#A8ADB4', remainPercent: 7, trayUuid: 'DEMO-RFID-H2D1-0', k: 0.018 }),
          makeSlot(1, { trayName: 'PLA Basic Gray', filamentType: 'PLA Basic', trayInfoIdx: 'GFA00', color: '#A8ADB4', remainPercent: 37, trayUuid: 'DEMO-RFID-H2D1-1', k: 0.018 }),
          makeSlot(2, { trayName: 'Generic PLA', filamentType: 'PLA', trayInfoIdx: 'GFL99', color: '#286C8E', remainPercent: 49, k: 0.024 }),
          makeSlot(3, { trayName: 'PLA Silk Gold', filamentType: 'PLA Silk', color: '#C89B3C', remainPercent: 59, trayUuid: 'DEMO-RFID-H2D1-3', k: 0.023 })
        ], { humidityPercent: 23 }),
        makeAmsUnit(1, 1, true, null, 19, 33, [
          makeSlot(0, { trayName: 'ABS Orange', filamentType: 'ABS', trayInfoIdx: 'GFB99', color: '#E05A2B', remainPercent: 11, trayUuid: 'DEMO-RFID-H2D1-4', k: 0.028 }),
          makeSlot(1, { trayName: 'ABS Orange', filamentType: 'ABS', trayInfoIdx: 'GFB99', color: '#E05A2B', remainPercent: 46, trayUuid: 'DEMO-RFID-H2D1-5', k: 0.028 }),
          makeSlot(2, { trayName: 'Support PLA', filamentType: 'Support PLA', trayInfoIdx: 'GFS02', color: '#D8E2EC', remainPercent: 33, trayUuid: 'DEMO-RFID-H2D1-6', k: 0.02 }),
          makeSlot(3, { trayName: 'PAHT-CF', filamentType: 'PAHT-CF', trayInfoIdx: 'GFN01', color: '#2B3037', remainPercent: 44, trayUuid: 'DEMO-RFID-H2D1-7', k: 0.031 })
        ], { humidityPercent: 19, dryingActive: true, dryFilament: 'ABS', dryTemperature: 55, dryDurationHours: 6 })
      ]
    case 'DEMO-H2D-002':
      return [
        makeAmsUnit(0, 0, true, null, null, 29, [
          makeSlot(0, { trayName: 'PETG HF Black', filamentType: 'PETG HF', trayInfoIdx: 'GFG01', color: '#1C1C1C', remainPercent: 8, trayUuid: 'DEMO-RFID-H2D2-0', k: 0.024 }),
          makeSlot(1, { trayName: 'PETG HF Black', filamentType: 'PETG HF', trayInfoIdx: 'GFG01', color: '#1C1C1C', remainPercent: 42, trayUuid: 'DEMO-RFID-H2D2-1', k: 0.024 }),
          makeSlot(2, { trayName: 'PLA Basic Jade', filamentType: 'PLA Basic', color: '#2FA86D', remainPercent: 63, trayUuid: 'DEMO-RFID-H2D2-2', k: 0.019 }),
          makeSlot(3, { trayName: 'PLA Matte Lavender', filamentType: 'PLA Matte', color: '#B8A3D7', remainPercent: 39, trayUuid: 'DEMO-RFID-H2D2-3', k: 0.022 })
        ], { humidityPercent: 21 }),
        makeAmsUnit(1, 1, true, null, 18, 32, [
          makeSlot(0, { trayName: 'ABS Orange', filamentType: 'ABS', trayInfoIdx: 'GFB99', color: '#E05A2B', remainPercent: 14, trayUuid: 'DEMO-RFID-H2D2-4', k: 0.028 }),
          makeSlot(1, { trayName: 'ABS Orange', filamentType: 'ABS', trayInfoIdx: 'GFB99', color: '#E05A2B', remainPercent: 51, trayUuid: 'DEMO-RFID-H2D2-5', k: 0.028 }),
          makeSlot(2, { trayName: 'Support PLA', filamentType: 'Support PLA', trayInfoIdx: 'GFS02', color: '#D8E2EC', remainPercent: 28, trayUuid: 'DEMO-RFID-H2D2-6', k: 0.02 }),
          makeSlot(3, { trayName: 'PAHT-CF', filamentType: 'PAHT-CF', trayInfoIdx: 'GFN01', color: '#2B3037', remainPercent: 53, trayUuid: 'DEMO-RFID-H2D2-7', k: 0.031 })
        ], { humidityPercent: 18, dryingActive: true, dryFilament: 'ABS', dryTemperature: 55, dryDurationHours: 4 })
      ]
    default:
      if (DUAL_NOZZLE_MODELS.has(printer.model)) {
        return [
          makeAmsUnit(0, 0, true, null, null, 28, [
            makeSlot(0, { trayName: 'PLA Basic Gray', filamentType: 'PLA Basic', trayInfoIdx: 'GFA00', color: '#A8ADB4', remainPercent: 74, trayUuid: 'DEMO-RFID-0-0', k: 0.018 }),
            makeSlot(1, { trayName: 'PLA Matte White', filamentType: 'PLA Matte', trayInfoIdx: 'GFL00', color: '#F5F5F3', remainPercent: 61, trayUuid: 'DEMO-RFID-0-1', k: 0.022 }),
            makeSlot(2, { trayName: 'PETG HF Black', filamentType: 'PETG HF', trayInfoIdx: 'GFG01', color: '#1C1C1C', remainPercent: 49, trayUuid: 'DEMO-RFID-0-2', k: 0.024 }),
            makeSlot(3)
          ], { humidityPercent: 23 }),
          makeAmsUnit(1, 1, true, null, 19, 33, [
            makeSlot(0, { trayName: 'ABS Orange', filamentType: 'ABS', trayInfoIdx: 'GFB99', color: '#E05A2B', remainPercent: 52, trayUuid: 'DEMO-RFID-1-0', k: 0.028 }),
            makeSlot(1, { trayName: 'Support PLA', filamentType: 'Support PLA', trayInfoIdx: 'GFS02', color: '#D8E2EC', remainPercent: 33, trayUuid: 'DEMO-RFID-1-1', k: 0.02 }),
            makeSlot(2, { trayName: 'PAHT-CF', filamentType: 'PAHT-CF', trayInfoIdx: 'GFN01', color: '#2B3037', remainPercent: 44, trayUuid: 'DEMO-RFID-1-2', k: 0.031 }),
            makeSlot(3)
          ], { humidityPercent: 19, dryingActive: true, dryFilament: 'PETG', dryTemperature: 55, dryDurationHours: 6 })
        ]
      }

      return [
        makeAmsUnit(0, 0, false, 2, null, 27, [
          makeSlot(0, { trayName: 'PLA Basic Gray', filamentType: 'PLA Basic', trayInfoIdx: 'GFA00', color: '#A8ADB4', remainPercent: 72, trayUuid: 'DEMO-RFID-AMS-0', k: 0.018 }),
          makeSlot(1, { trayName: 'PETG HF Black', filamentType: 'PETG HF', trayInfoIdx: 'GFG01', color: '#1C1C1C', remainPercent: 58, trayUuid: 'DEMO-RFID-AMS-1', k: 0.023 }),
          makeSlot(2, { trayName: 'PLA Matte White', filamentType: 'PLA Matte', trayInfoIdx: 'GFL00', color: '#F5F5F3', remainPercent: 37, trayUuid: 'DEMO-RFID-AMS-2', k: 0.022 }),
          makeSlot(3)
        ])
      ]
  }
}

function buildExternalSpools(printer: Printer): PrinterStatus['externalSpools'] {
  const spools: PrinterStatus['externalSpools'] = [
    {
      amsId: 255,
      nozzleId: 0,
      trayName: 'Manual PLA-CF',
      filamentType: 'PLA-CF',
      color: '#4C4F54',
      colors: ['#4C4F54'],
      remainPercent: 41,
      active: false,
      trayInfoIdx: 'GFA00',
      caliIdx: -1,
      k: 0.025,
      trayUuid: null
    }
  ]

  if (DUAL_NOZZLE_MODELS.has(printer.model)) {
    spools.push({
      amsId: 254,
      nozzleId: 1,
      trayName: 'Manual TPU 95A',
      filamentType: 'TPU 95A',
      color: '#2F7ECA',
      colors: ['#2F7ECA'],
      remainPercent: 63,
      active: false,
      trayInfoIdx: 'GFU03',
      caliIdx: -1,
      k: 0.03,
      trayUuid: null
    })
  }

  return spools
}

function makeAmsUnit(
  unitId: number,
  nozzleId: number,
  supportDrying: boolean,
  humidityLevel: number | null,
  humidityPercent: number | null,
  temperature: number,
  slots: PrinterStatus['ams'][number]['slots'],
  overrides: Partial<PrinterStatus['ams'][number]> = {}
): PrinterStatus['ams'][number] {
  return {
    unitId,
    nozzleId,
    supportDrying,
    dryTimeRemainingMinutes: overrides.dryTimeRemainingMinutes ?? null,
    dryingActive: overrides.dryingActive ?? false,
    dryFilament: overrides.dryFilament ?? null,
    dryTemperature: overrides.dryTemperature ?? null,
    dryDurationHours: overrides.dryDurationHours ?? null,
    humidityPercent: overrides.humidityPercent ?? humidityPercent,
    humidityLevel: overrides.humidityLevel ?? humidityLevel,
    temperature,
    slots
  }
}

function makeSlot(
  slot: number,
  overrides: Partial<PrinterStatus['ams'][number]['slots'][number]> = {}
): PrinterStatus['ams'][number]['slots'][number] {
  const color = overrides.color ?? null
  return {
    slot,
    trayName: overrides.trayName ?? null,
    filamentType: overrides.filamentType ?? null,
    color,
    colors: overrides.colors ?? (color ? [color] : []),
    remainPercent: overrides.remainPercent ?? null,
    active: overrides.active ?? false,
    isReading: overrides.isReading ?? false,
    trayInfoIdx: overrides.trayInfoIdx ?? null,
    caliIdx: overrides.caliIdx ?? -1,
    k: overrides.k ?? null,
    trayUuid: overrides.trayUuid ?? null
  }
}

function activateAmsSlot(
  units: PrinterStatus['ams'],
  activeUnitId: number,
  activeSlot: number
): PrinterStatus['ams'] {
  return units.map((unit) => ({
    ...unit,
    slots: unit.slots.map((slot) => ({
      ...slot,
      active: unit.unitId === activeUnitId && slot.slot === activeSlot
    }))
  }))
}

function clearActiveAmsSlots(units: PrinterStatus['ams']): PrinterStatus['ams'] {
  return units.map((unit) => ({
    ...unit,
    slots: unit.slots.map((slot) => ({ ...slot, active: false }))
  }))
}

function clearActiveExternalSpools(spools: PrinterStatus['externalSpools']): PrinterStatus['externalSpools'] {
  return spools.map((spool) => ({ ...spool, active: false }))
}

function startPrintStatus(status: PrinterStatus, payload: Record<string, unknown>): PrinterStatus {
  const fileName = readPrintFileName(payload) ?? getDefaultDemoLibraryFile().fileName
  const taskId = `demo-${Date.now().toString(36)}-${fileName}`
  const jobName = formatDemoJobName(fileName)
  return {
    ...status,
    stage: 'printing',
    subStage: 'Layer 1 / 120',
    progressPercent: 1,
    currentLayer: 1,
    totalLayers: 120,
    remainingMinutes: 54,
    jobId: `demo-${Date.now().toString(36)}`,
    taskId,
    jobName,
    lastJobName: jobName,
    gcodeFile: fileName,
    bedTemp: 55,
    bedTarget: 55,
    nozzleTemp: 220,
    nozzleTarget: 220,
    nozzles: status.nozzles.map((nozzle, index) => ({ ...nozzle, currentTemp: index === 0 ? 220 : nozzle.currentTemp, targetTemp: index === 0 ? 220 : null })),
    partFanPercent: 60,
    auxFanPercent: 30,
    chamberFanPercent: 20,
    deviceError: null,
    hmsErrors: [],
    observedAt: new Date().toISOString()
  }
}

function advancePrintStatus(status: PrinterStatus): PrinterStatus {
  const currentProgress = status.progressPercent ?? 0
  const progressPercent = currentProgress >= 94 ? 18 : Math.min(94, currentProgress + 5)
  const totalLayers = status.totalLayers ?? 120
  const currentLayer = Math.min(totalLayers, Math.max(status.currentLayer ?? 0, Math.round(totalLayers * progressPercent / 100)))

  return {
    ...status,
    progressPercent,
    currentLayer,
    totalLayers,
    remainingMinutes: status.remainingMinutes == null ? null : (currentProgress >= 94 ? 57 : Math.max(12, status.remainingMinutes - 3)),
    subStage: `Layer ${currentLayer} / ${totalLayers}`,
    observedAt: new Date().toISOString()
  }
}

function finishStatus(status: PrinterStatus, stage: 'idle' | 'finished', subStage: string): PrinterStatus {
  return {
    ...status,
    stage,
    subStage,
    progressPercent: stage === 'finished' ? 100 : null,
    currentLayer: stage === 'finished' ? status.totalLayers : null,
    remainingMinutes: stage === 'finished' ? 0 : null,
    jobName: null,
    gcodeFile: null,
    bedTarget: null,
    nozzleTarget: null,
    nozzles: status.nozzles.map((nozzle) => ({ ...nozzle, targetTemp: null })),
    partFanPercent: 0,
    auxFanPercent: 0,
    chamberFanPercent: 0,
    observedAt: new Date().toISOString()
  }
}

function cancelStatus(status: PrinterStatus): PrinterStatus {
  return {
    ...status,
    stage: 'failed',
    subStage: 'Cancelled by demo command',
    progressPercent: null,
    currentLayer: null,
    remainingMinutes: null,
    jobName: null,
    gcodeFile: null,
    bedTarget: null,
    nozzleTarget: null,
    nozzles: status.nozzles.map((nozzle) => ({ ...nozzle, targetTemp: null })),
    partFanPercent: 0,
    auxFanPercent: 0,
    chamberFanPercent: 0,
    deviceError: {
      code: 'demo_cancelled',
      message: 'Cancelled by the printer'
    },
    hmsErrors: [],
    observedAt: new Date().toISOString()
  }
}

function toggleLightStatus(status: PrinterStatus, payload: Record<string, unknown>): PrinterStatus {
  const mode = readLightMode(payload) ?? (status.lightOn ? 'off' : 'on')
  return {
    ...status,
    lightOn: mode === 'on',
    lightModes: { ...status.lightModes, chamber: mode },
    observedAt: new Date().toISOString()
  }
}

function readNestedCommand(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const command = (value as Record<string, unknown>).command
  return typeof command === 'string' ? command : null
}

function readPrintFileName(payload: Record<string, unknown>): string | null {
  const print = payload.print
  if (!print || typeof print !== 'object' || Array.isArray(print)) return null
  const record = print as Record<string, unknown>
  for (const key of ['subtask_name', 'param', 'url', 'file', 'gcode_file']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.split('/').pop() ?? value
  }
  return null
}

function readLightMode(payload: Record<string, unknown>): 'on' | 'off' | null {
  for (const key of ['system', 'print']) {
    const value = payload[key]
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const mode = (value as Record<string, unknown>).led_mode
    if (mode === 'on' || mode === 'off') return mode
  }
  return null
}

function buildLayerSubStage(status: PrinterStatus): string {
  return `Layer ${status.currentLayer ?? 1} / ${status.totalLayers ?? 120}`
}

function listStorageEntries(dirPath: string, recursive: boolean): BridgePrinterStorageEntry[] {
  const timelapseEntries = buildDemoTimelapseEntries()
  const entries: BridgePrinterStorageEntry[] = [
    ...buildDemoStorageEntries(),
    ...STATIC_STORAGE_ENTRIES,
    ...(timelapseEntries.length > 0 ? timelapseEntries : FALLBACK_TIMELAPSE_STORAGE_ENTRIES)
  ]
  if (recursive) return entries
  const normalized = dirPath.endsWith('/') && dirPath !== '/' ? dirPath.slice(0, -1) : dirPath
  return entries.filter((entry) => {
    const entryPath = entry.path ?? `/${entry.name}`
    if (normalized === '/') return entryPath.split('/').filter(Boolean).length === 1
    return entryPath.startsWith(`${normalized}/`) && entryPath.slice(normalized.length + 1).split('/').length === 1
  })
}

function buildDemoTimelapseEntries(): BridgePrinterStorageEntry[] {
  try {
    const captureDirectories = readdirSync(DEMO_CAPTURES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))

    return captureDirectories.flatMap((directory) => {
      const directoryPath = path.join(DEMO_CAPTURES_DIR, directory.name)
      return readdirSync(directoryPath, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .filter((entry) => /\.(mp4|mov|mkv|webm)$/i.test(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
        .map((entry) => {
          const localPath = path.join(directoryPath, entry.name)
          const stats = statSync(localPath)
          return {
            name: entry.name,
            path: `/timelapse/${directory.name}/${entry.name}`,
            type: 'file' as const,
            sizeBytes: stats.size,
            modifiedAt: stats.mtime.toISOString()
          }
        })
    })
  } catch {
    return []
  }
}

function buildDemoStorageEntries(): BridgePrinterStorageEntry[] {
  return listDemoLibraryFiles().map((file) => ({
    name: file.fileName,
    path: `/${file.fileName}`,
    type: 'file' as const,
    sizeBytes: file.sizeBytes,
    modifiedAt: file.modifiedAt
  }))
}

function listDemoLibraryFiles(): DemoLibraryFile[] {
  try {
    const libraryDir = DEMO_LIBRARY_DIR
    const files = readdirSync(libraryDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.gcode.3mf'))
      .map((entry) => {
        const stats = statSync(path.join(libraryDir, entry.name))
        return {
          fileName: entry.name,
          jobName: formatDemoJobName(entry.name),
          sizeBytes: stats.size,
          modifiedAt: stats.mtime.toISOString(),
          selectedPlate: null
        }
      })
      .sort((left, right) => left.fileName.localeCompare(right.fileName, undefined, { sensitivity: 'base' }))

    return files.length > 0 ? files : FALLBACK_DEMO_LIBRARY_FILES
  } catch {
    return FALLBACK_DEMO_LIBRARY_FILES
  }
}

function getDemoLibraryFileForPrinter(printer: Printer): DemoLibraryFile {
  const files = listDemoLibraryFiles()
  const activeJob = getDemoPrinterActiveJob(printer.serial)
  if (activeJob) {
    const preferredFile = files.find((file) => file.fileName === activeJob.fileName)
    if (preferredFile) {
      return {
        ...preferredFile,
        selectedPlate: activeJob.plate
      }
    }
    return {
      fileName: activeJob.fileName,
      jobName: activeJob.jobName,
      sizeBytes: 0,
      modifiedAt: new Date(0).toISOString(),
      selectedPlate: activeJob.plate
    }
  }

  const index = Math.abs(hashDemoSeed(printer.serial)) % files.length
  return files[index] ?? FALLBACK_DEMO_LIBRARY_FILES[0] ?? {
    fileName: 'Demo_Print.gcode.3mf',
    jobName: 'Demo Print',
    sizeBytes: 0,
    modifiedAt: new Date(0).toISOString(),
    selectedPlate: null
  }
}

function getDefaultDemoLibraryFile(): DemoLibraryFile {
  return listDemoLibraryFiles()[0] ?? FALLBACK_DEMO_LIBRARY_FILES[0] ?? {
    fileName: 'Demo_Print.gcode.3mf',
    jobName: 'Demo Print',
    sizeBytes: 0,
    modifiedAt: new Date(0).toISOString(),
    selectedPlate: null
  }
}

async function resolveCompatibleDemoLibraryFileForPrinter(
  printer: Printer,
  preferredFileName?: string | null
): Promise<DemoLibraryFile | null> {
  const files = listDemoLibraryFiles()
  if (files.length === 0) return null

  const compatibilityByFile = new Map(
    await Promise.all(files.map(async (file) => {
      const filePath = path.join(DEMO_LIBRARY_DIR, file.fileName)
      const index = await readBridgeLibraryThreeMfIndex(filePath).catch(() => null)
      return [file.fileName, index?.compatiblePrinterModels] as const
    }))
  )

  const activeJob = preferredFileName ? null : getDemoPrinterActiveJob(printer.serial)
  const preferredResolvedFileName = preferredFileName ?? activeJob?.fileName ?? null
  const preferredFile = preferredResolvedFileName
    ? files.find((file) => file.fileName === preferredResolvedFileName) ?? null
    : null
  if (preferredFile && activeJob?.fileName === preferredFile.fileName) {
    return {
      ...preferredFile,
      selectedPlate: activeJob.plate
    }
  }
  if (preferredFile && isPrinterModelCompatible(compatibilityByFile.get(preferredFile.fileName), printer.model)) {
    return preferredFile
  }

  return chooseCompatibleDemoLibraryFile(files, printer.model, compatibilityByFile, hashDemoSeed(preferredFileName ?? printer.serial))
}

export function chooseCompatibleDemoLibraryFile(
  files: readonly DemoLibraryFile[],
  printerModel: Printer['model'],
  compatiblePrinterModelsByFile: ReadonlyMap<string, readonly Printer['model'][] | null | undefined>,
  seedValue: number
): DemoLibraryFile | null {
  const compatibleFiles = files.filter((file) => isPrinterModelCompatible(compatiblePrinterModelsByFile.get(file.fileName), printerModel))
  const candidates = compatibleFiles.length > 0 ? compatibleFiles : files
  if (candidates.length === 0) return null

  const index = Math.abs(seedValue) % candidates.length
  return candidates[index] ?? candidates[0] ?? null
}

async function resolveDemoLibraryFileSelection(file: DemoLibraryFile, preferredPlate: number | null = null): Promise<DemoLibraryFile> {
  const filePath = path.join(DEMO_LIBRARY_DIR, file.fileName)
  const index = await readBridgeLibraryThreeMfIndex(filePath).catch(() => null)
  const availablePlates = Array.from(new Set(index?.plates.map((plate) => plate.index).filter((plate) => plate > 0) ?? []))
  return {
    ...file,
    selectedPlate: preferredPlate != null && availablePlates.includes(preferredPlate)
      ? preferredPlate
      : chooseDemoPrintPlate(file.fileName, availablePlates, buildDeterministicDemoRandom(file.fileName))
  }
}

function buildDemoObservedGcodeFile(file: DemoLibraryFile): string {
  return buildPlateGcodeFileHint(file.selectedPlate) ?? file.fileName
}

export function chooseDemoPrintPlate(fileName: string, availablePlates: readonly number[], randomValue = Math.random()): number | null {
  if (availablePlates.length <= 1) return availablePlates[0] ?? null

  if (shouldPreferSecondPlate(fileName) && availablePlates.includes(2)) {
    return 2
  }

  const normalizedRandom = Number.isFinite(randomValue)
    ? Math.min(0.999999999, Math.max(0, randomValue))
    : Math.random()
  return availablePlates[Math.floor(normalizedRandom * availablePlates.length)] ?? availablePlates[0] ?? null
}

function shouldPreferSecondPlate(fileName: string): boolean {
  const normalizedName = stripDemoStoredFilePrefix(path.basename(fileName)).toLowerCase()
  return normalizedName.includes('card_holder') || normalizedName.includes('card holder')
}

function formatDemoJobName(fileName: string): string {
  return stripDemoStoredFilePrefix(path.basename(fileName))
    .replace(/\.gcode\.3mf$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripDemoStoredFilePrefix(fileName: string): string {
  return fileName.replace(/^(?:[0-9]{10,}|[a-f0-9]{12,})-/, '')
}

function hashDemoSeed(value: string): number {
  let hash = 0
  for (const char of value) {
    hash = ((hash << 5) - hash) + char.charCodeAt(0)
    hash |= 0
  }
  return hash
}

function buildDeterministicDemoRandom(value: string): number {
  const normalized = Math.abs(hashDemoSeed(value)) % 1_000_000
  return normalized / 1_000_000
}

function resolveDemoAssetDir(preferredPath: string, fallbackRelativePath: string): string {
  if (existsSync(preferredPath)) {
    return preferredPath
  }

  return path.resolve(DEMO_MODULE_DIR, fallbackRelativePath)
}

function resolveDemoStorageAsset(filePath: string): { localPath: string; sizeBytes: number } | null {
  const normalizedPath = filePath.startsWith('/') ? filePath : `/${filePath}`

  const libraryFile = listDemoLibraryFiles().find((entry) => `/${entry.fileName}` === normalizedPath)
  if (libraryFile) {
    const localPath = path.join(DEMO_LIBRARY_DIR, libraryFile.fileName)
    return {
      localPath,
      sizeBytes: libraryFile.sizeBytes
    }
  }

  const timelapseAsset = buildDemoTimelapseEntries().find((entry) => entry.path === normalizedPath)
  if (!timelapseAsset?.path) return null

  const relativePath = timelapseAsset.path.replace(/^\/timelapse\//, '')
  const localPath = path.join(DEMO_CAPTURES_DIR, relativePath)
  return {
    localPath,
    sizeBytes: timelapseAsset.sizeBytes
  }
}

export async function waitForDemoSimulatorTick(ms: number): Promise<void> {
  await delay(ms)
}
