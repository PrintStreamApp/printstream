/**
 * Pure mappers for the Home Assistant bridge snapshot.
 *
 * The Home Assistant integration polls one endpoint, so this module flattens
 * persisted printer config plus the live `printerManager` cache into a single,
 * stable payload that is easy to consume from outside the monorepo.
 */
import type {
  HomeAssistantAmsUnitSnapshot,
  HomeAssistantBridgeInfo,
  HomeAssistantSnapshot,
  Printer,
  PrinterStatus
} from '@printstream/shared'
import { getPrinterDisplayCapabilities } from '@printstream/shared'

const UNSUPPORTED_PRINT_OPTION = { supported: false, enabled: null }
const UNSUPPORTED_DETECTION_OPTION = { supported: false, enabled: null, sensitivity: null }

export function buildHomeAssistantSnapshot(
  printers: readonly Printer[],
  getStatus: (printerId: string) => PrinterStatus | undefined,
  now = new Date()
): HomeAssistantSnapshot {
  const generatedAt = now.toISOString()

  return {
    version: 1,
    generatedAt,
    printers: printers.map((printer) => buildPrinterSnapshot(printer, getStatus(printer.id), generatedAt))
  }
}

export function buildHomeAssistantBridgeInfo(snapshot: HomeAssistantSnapshot): HomeAssistantBridgeInfo {
  return {
    version: snapshot.version,
    generatedAt: snapshot.generatedAt,
    printerCount: snapshot.printers.length,
    amsUnitCount: snapshot.printers.reduce((count, printer) => count + printer.ams.length, 0),
    snapshotPath: '/api/plugins/home-assistant/snapshot'
  }
}

function buildPrinterSnapshot(
  printer: Printer,
  status: PrinterStatus | undefined,
  generatedAt: string
): HomeAssistantSnapshot['printers'][number] {
  const gcodeFile = status?.gcodeFile ?? null
  const jobName = status?.jobName ?? null
  const coverJobName = jobName ?? status?.lastJobName ?? null
  const displayCapabilities = getPrinterDisplayCapabilities(printer.model)
  const cameraSupported = displayCapabilities.camera

  return {
    id: printer.id,
    serial: printer.serial,
    name: printer.name,
    model: printer.model,
    host: printer.host,
    detailPath: `/printers/${printer.id}`,
    cameraSupported,
    cameraSnapshotPath: cameraSupported ? `/api/camera/${printer.id}/snapshot` : null,
    cameraStreamPath: cameraSupported ? `/api/camera/${printer.id}/stream` : null,
    coverImagePath: coverJobName
      ? `/api/printers/${printer.id}/cover?job=${encodeURIComponent(coverJobName)}&gcode=${encodeURIComponent(gcodeFile ?? '')}`
      : null,
    online: status?.online ?? false,
    stage: status?.stage ?? 'unknown',
    subStage: status?.subStage ?? null,
    progressPercent: status?.progressPercent ?? null,
    currentLayer: status?.currentLayer ?? null,
    totalLayers: status?.totalLayers ?? null,
    remainingMinutes: status?.remainingMinutes ?? null,
    jobName,
    lastJobName: status?.lastJobName ?? null,
    gcodeFile,
    bedTemp: status?.bedTemp ?? null,
    bedTarget: status?.bedTarget ?? null,
    nozzleTemp: status?.nozzleTemp ?? null,
    nozzleTarget: status?.nozzleTarget ?? null,
    nozzles: [...(status?.nozzles ?? [])],
    chamberTemp: status?.chamberTemp ?? null,
    fanGearSpeed: status?.fanGearSpeed ?? null,
    partFanPercent: status?.partFanPercent ?? null,
    auxFanPercent: status?.auxFanPercent ?? null,
    chamberFanPercent: status?.chamberFanPercent ?? null,
    wifiSignalDbm: status?.wifiSignalDbm ?? null,
    ipAddress: status?.ipAddress ?? null,
    doorOpen: status?.doorOpen ?? null,
    ductMode: status?.ductMode ?? null,
    ductAvailableModes: [...(status?.ductAvailableModes ?? [])],
    lightModes: status?.lightModes ?? {
      chamber: null,
      heatbed: null,
      work: null
    },
    lightCapabilities: status?.lightCapabilities ?? {
      chamber: false,
      heatbed: false,
      work: false
    },
    lightOn: status?.lightOn ?? null,
    speedLevel: status?.speedLevel ?? null,
    printOptions: status?.printOptions ?? {
      aiMonitoring: UNSUPPORTED_DETECTION_OPTION,
      spaghettiDetection: UNSUPPORTED_DETECTION_OPTION,
      purgeChutePileupDetection: UNSUPPORTED_DETECTION_OPTION,
      nozzleClumpingDetection: UNSUPPORTED_DETECTION_OPTION,
      airPrintingDetection: UNSUPPORTED_DETECTION_OPTION,
      firstLayerInspection: UNSUPPORTED_PRINT_OPTION,
      autoRecovery: UNSUPPORTED_PRINT_OPTION,
      promptSound: UNSUPPORTED_PRINT_OPTION,
      filamentTangleDetection: UNSUPPORTED_PRINT_OPTION
    },
    amsSettings: status?.amsSettings ?? {
      detectOnInsert: null,
      detectOnPowerup: null,
      remainEnabled: null,
      autoRefill: null,
      supportFilamentBackup: null
    },
    sdCardPresent: status?.sdCardPresent ?? null,
    firmwareVersion: status?.firmwareVersion ?? null,
    deviceError: status?.deviceError ?? null,
    hmsErrors: status?.hmsErrors ?? [],
    ams: [...(status?.ams ?? [])]
      .sort((left, right) => left.unitId - right.unitId)
      .map((unit) => buildAmsSnapshot(printer, unit)),
    externalSpools: [...(status?.externalSpools ?? [])]
      .sort((left, right) => left.amsId - right.amsId)
      .map((spool) => ({
        amsId: spool.amsId,
        nozzleId: spool.nozzleId,
        trayName: spool.trayName,
        filamentType: spool.filamentType,
        color: spool.color,
        colors: spool.colors,
        remainPercent: spool.remainPercent,
        active: spool.active,
        trayInfoIdx: spool.trayInfoIdx,
        k: spool.k,
        trayUuid: spool.trayUuid
      })),
    observedAt: status?.observedAt ?? generatedAt
  }
}

function buildAmsSnapshot(printer: Printer, unit: PrinterStatus['ams'][number]): HomeAssistantAmsUnitSnapshot {
  const activeSlot = unit.slots.find((slot) => slot.active)?.slot ?? null

  return {
    id: `${printer.id}:ams:${unit.unitId}`,
    printerId: printer.id,
    printerName: printer.name,
    printerSerial: printer.serial,
    name: `${printer.name} AMS ${unit.unitId + 1}`,
    unitId: unit.unitId,
    nozzleId: unit.nozzleId,
    supportDrying: unit.supportDrying,
    dryingActive: unit.dryingActive,
    dryTimeRemainingMinutes: unit.dryTimeRemainingMinutes,
    dryFilament: unit.dryFilament,
    dryTemperature: unit.dryTemperature,
    dryDurationHours: unit.dryDurationHours,
    humidityPercent: unit.humidityPercent,
    humidityLevel: unit.humidityLevel,
    temperature: unit.temperature,
    activeSlot,
    slots: [...unit.slots]
      .sort((left, right) => left.slot - right.slot)
      .map((slot) => ({
        slot: slot.slot,
        trayName: slot.trayName,
        filamentType: slot.filamentType,
        color: slot.color,
        colors: slot.colors,
        remainPercent: slot.remainPercent,
        active: slot.active,
        isReading: slot.isReading,
        trayInfoIdx: slot.trayInfoIdx,
        k: slot.k,
        trayUuid: slot.trayUuid
      }))
  }
}
