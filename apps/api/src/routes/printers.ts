/**
 * Printer CRUD + live commands.
 *
 * Persistent state lives in Prisma; the in-memory MQTT manager is kept
 * in lock-step through the printer event bus. Validation and DTO shaping
 * goes through `@printstream/shared` so the web client and the API agree
 * on the wire format.
 */
import { Router } from 'express'
import { stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import multer from 'multer'
import { z } from 'zod'
import {
  PRINTERS_CONTROL_CALIBRATE_SCOPE,
  PRINTERS_CONTROL_HMS_CLEAR_SCOPE,
  PRINTERS_CONTROL_MANUAL_CONTROLS_SCOPE,
  PRINTERS_CONTROL_REFRESH_SCOPE,
  PRINTERS_MANAGE_AMS_SCOPE,
  PRINTERS_MANAGE_PERMISSION,
  PRINTERS_MANAGE_SETTINGS_SCOPE,
  PRINTERS_MANAGE_STORAGE_EDIT_SCOPE,
  PRINTERS_MANAGE_STORAGE_UPLOAD_SCOPE,
  PRINTERS_VIEW_PERMISSION,
  PRINTER_STORAGE_DOWNLOAD_PERMISSION,
  PRINTER_STORAGE_VIEW_MODELS_SCOPE,
  PRINTER_STORAGE_VIEW_PERMISSION,
  PRINTER_STORAGE_VIEW_TIMELAPSES_SCOPE,
  PRINTS_DISPATCH_PRINTER_STORAGE_SCOPE,
  type PermissionScope,
  PRINTER_EXTRUDER_CONTROL_MIN_TEMP_C,
  getAmsLoadFilamentAvailability,
  getAmsUnloadFilamentAvailability,
  getConfirmAmsFilamentExtrudedAvailability,
  getExternalSpoolLoadAvailability,
  getExternalSpoolUnloadAvailability,
  getIgnoreHmsErrorAvailability,
  canUseExtruderControl,
  canUseMotionControl,
  canUsePrintSpeedControl,
  extractErrorMessage,
  getPrinterPrintStartOptions,
  getPrinterCalibrationCapabilities,
  getPrinterChamberTemperatureMax,
  getPauseAvailability,
  getPrinterControlCapabilities,
  getRetryAmsFilamentChangeAvailability,
  isDirectPrintableFileName,
  getResumeAvailability,
  getStopAvailability,
  printerActivePrintObjectsSchema,
  printerCommandSchema,
  printerConnectionValidationInputSchema,
  printerMutationInputSchema,
  printerModelSchema,
  printerPressureAdvanceProfilesResponseSchema,
  printerReorderSchema,
  printerStatsResponseSchema,
  startPrinterStorageDeleteJobSchema,
  printerStoragePrintSchema,
  supportsPrinterAirductMode,
  type ThreeMfIndex,
  type Printer,
  type PrinterStatus
} from '@printstream/shared'
import { annotateRequestAuditLog } from '../lib/audit-logs.js'
import { prisma, rootPrisma } from '../lib/prisma.js'
import { serializePrinterNozzleDiameters, toPrinterDto, toPublicPrinterDto } from '../lib/printer-record.js'
import { printerManager } from '../lib/printer-manager.js'
import { assertTenantOwnsPrinter, requireTenantOwnedConnectedPrinter } from '../lib/printer-access.js'
import { buildPlateGcodeFileHint, extractObservedPrintPlateIndex } from '@printstream/shared'
import { syncBridgePrinterConfig } from '../lib/bridge-printer-config.js'
import { printerDiscovery } from '../lib/printer-discovery.js'
import { reconnectPrinter } from '../lib/printer-reconnect.js'
import { validatePrinterLanConnection } from '../lib/printer-connection-validation.js'
import {
  deletePrinterDirectory,
  deletePrinterFile,
  downloadFileFromPrinter,
  listPrinterDirectory,
  listPrinterDirectoryRecursive,
  renamePrinterPath,
  streamFileFromPrinter
} from '../lib/printer-ftp.js'
import { uploadFileToPrinterPath } from '../lib/printer-ftp.js'
import { buildTimelapseThumbnailCandidates } from '../lib/timelapse-thumbnails.js'
import {
  getActivePrintJobAssets,
} from '../lib/active-print-job-assets.js'
import { choosePreferredExactPrinterFilePath } from '../lib/printer-file-path.js'
import { readPrinterStats } from '../lib/printer-stats.js'
import {
  resolveRelevantPrintJobId,
  startTrackedPrintJob
} from '../lib/print-job-recorder.js'
import {
  chooseCoverThumbnailFileHint,
  choosePreferredCoverFileHint,
  readCoverFromArchive
} from '../lib/cover-thumbnail.js'
import { resolvePrinterCoverPath } from '../lib/printer-cover-source.js'
import { assertAutomaticPrintCompatibility } from '../lib/print-filament-compatibility.js'
import {
  clearPrinterStorageThreeMfInspectionCache,
  readPrinterStorageThreeMfIndex,
  readPrinterStorageThumbnail
} from '../lib/printer-storage-3mf.js'
import {
  getCachedActivePrintObjects,
  inferActivePrintObjectsUnavailableState,
  preloadActivePrintObjects
} from '../lib/active-print-objects.js'
import {
  getCachedCover,
  isNegativeCached,
  markCoverMiss,
  setCachedCover
} from '../lib/cover-cache.js'
import { badRequest, conflict, notFound } from '../lib/http-error.js'
import { assertPrinterMutationsAllowed } from '../lib/demo-mode.js'
import { env } from '../lib/env.js'
import { assertRequestPermission, requireRequestPermission } from '../lib/authorization.js'
import { broadcastPrinterStorageChanged } from '../lib/ws-resource-events.js'
import { deleteOperationDispatcher } from '../lib/delete-operation-dispatcher.js'
import { printGuards } from '../lib/print-guards.js'
import {
  buildProjectFilePrintCommand,
  getRemotePrintTarget,
  getPrintSourceKind,
  normalizePrintStartOptionsForPrinter,
  printDispatcher
} from '../lib/print-dispatcher.js'
import { calibrationOption } from '../lib/printer-calibration.js'
import { commandToMqttPayloads, resolvePressureAdvanceCommandContext } from '../lib/printer-command-payloads.js'
import { startCalibrationJob } from '../lib/calibration-jobs.js'
import { getDispatchedPrintSource } from '../lib/dispatched-print-source-cache.js'
import { listPrinters } from '../lib/printer-list.js'
import { readPrintJobThumbnail } from '../lib/print-job-thumbnails.js'
import {
  parsePositiveIntQuery,
  requestAbortSignal,
  requireRequestTenantId,
  requireRouteParam,
  singleUploadWithLimit
} from '../lib/request-helpers.js'

export const printersRouter = Router()

function resolvePrinterFirstLayerInspectionDefault(
  model: Printer['model'],
  printerStatus: PrinterStatus | undefined
): boolean {
  const options = getPrinterPrintStartOptions(
    model,
    printerStatus
      ? {
          printOptions: printerStatus.printOptions,
          printStartOptions: printerStatus.printStartOptions
        }
      : null
  )
  if (!options.firstLayerInspection.supported) return false
  return options.firstLayerInspection.current ?? true
}

const MAX_PRINTER_STORAGE_UPLOAD_BYTES = env.LIBRARY_MAX_UPLOAD_BYTES
const printerStorageUpload = multer({
  storage: multer.diskStorage({
    destination: (_request, _file, callback) => callback(null, tmpdir()),
    filename: (_request, file, callback) => {
      const safe = file.originalname.replace(/[^\w.-]+/g, '_') || 'upload.bin'
      callback(null, `${Date.now()}-${safe}`)
    }
  }),
  limits: { fileSize: MAX_PRINTER_STORAGE_UPLOAD_BYTES }
})
const pressureAdvanceProfilesQuerySchema = z.object({
  amsId: z.coerce.number().int().min(0),
  slotId: z.coerce.number().int().min(0).max(15),
  filamentId: z.string().max(32).default('')
})
const printerConnectionValidationRequestSchema = printerConnectionValidationInputSchema.extend({
  bridgeId: z.string({ required_error: 'Bridge assignment is required' }).trim().min(1, 'Bridge assignment is required')
})

type CoverLoadStatus = 'idle' | 'resolving' | 'downloading' | 'extracting'

interface CoverLoadState {
  status: CoverLoadStatus
  progressPercent: number | null
  message: string
}

const coverLoadStates = new Map<string, CoverLoadState>()
const SLOW_COVER_LOAD_LOG_THRESHOLD_MS = 250

function setCoverLoadState(printerId: string, state: CoverLoadState): void {
  coverLoadStates.set(printerId, state)
}

function clearCoverLoadState(printerId: string): void {
  coverLoadStates.delete(printerId)
}

function getCoverLoadState(printerId: string): CoverLoadState {
  return coverLoadStates.get(printerId) ?? { status: 'idle', progressPercent: null, message: '' }
}

async function assertBridgeAssignmentExists(bridgeId: string | null | undefined): Promise<void> {
  if (!bridgeId) {
    throw badRequest('Bridge assignment is required')
  }
  const bridge = await prisma.bridge.findUnique({
    where: { id: bridgeId },
    select: { id: true }
  })
  if (!bridge) {
    throw badRequest('Bridge not found')
  }
}

function uploadSinglePrinterStorageFile(field: string) {
  return singleUploadWithLimit({
    upload: printerStorageUpload,
    field,
    maxBytes: MAX_PRINTER_STORAGE_UPLOAD_BYTES,
    onLimitExceeded: (maxBytes) =>
      badRequest(`File exceeds ${Math.round(maxBytes / (1024 * 1024))} MB upload limit`),
    onMulterError: (error) => badRequest(error.message)
  })
}

function sanitizePrinterStorageUploadFileName(raw: string): string {
  const safe = path.posix.basename(raw.replace(/\\/g, '/')).replace(/[^\w.-]+/g, '_')
  if (!safe || safe === '.' || safe === '..') throw badRequest('Invalid filename')
  return safe
}

function logCoverLoad(printer: Printer, details: {
  outcome: string
  totalMs: number
  resolveMs: number | null
  extractMs: number | null
  sourcePath: string | null
  plateIndex: number | null
  gcodeFile: string | null
}): void {
  if (details.totalMs < SLOW_COVER_LOAD_LOG_THRESHOLD_MS && details.outcome.endsWith('cache-hit')) return

  const parts = [
    `[cover:${printer.name}]`,
    `outcome=${details.outcome}`,
    `totalMs=${details.totalMs}`,
    `resolveMs=${details.resolveMs ?? 'n/a'}`,
    `extractMs=${details.extractMs ?? 'n/a'}`,
    `plate=${details.plateIndex ?? 'n/a'}`
  ]
  if (details.sourcePath) parts.push(`source=${details.sourcePath}`)
  if (details.gcodeFile) parts.push(`gcode=${details.gcodeFile}`)
  console.info(parts.join(' '))
}

printersRouter.get('/', requireRequestPermission(PRINTERS_VIEW_PERMISSION), async (request, response) => {
  const tenantId = requireRequestTenantId(request)
  response.json({ printers: await listPrinters(prisma, tenantId) })
})

printersRouter.get('/status', requireRequestPermission(PRINTERS_VIEW_PERMISSION), async (request, response) => {
  const tenantId = requireRequestTenantId(request)
  const visiblePrinterIds = new Set((await prisma.printer.findMany({
    where: { tenantId },
    select: { id: true }
  })).map((printer) => printer.id))

  const statuses = Object.fromEntries(
    printerManager
      .snapshots()
      .filter((status) => visiblePrinterIds.has(status.printerId))
      .map((status) => [status.printerId, status])
  )

  response.json({ statuses })
})

printersRouter.get('/:id/stats', requireRequestPermission(PRINTERS_VIEW_PERMISSION), async (request, response) => {
  const printerId = requireRouteParam(request.params.id, 'Printer id')
  const stats = await readPrinterStats(printerId)
  if (!stats) throw notFound('Printer not found')
  response.json(printerStatsResponseSchema.parse({ stats }))
})

/**
 * LAN-discovered printers the user has not yet adopted. The discovery
 * service keeps an in-memory map keyed by serial number so a follow-up
 * `POST /api/printers` (with the access code from the printer screen)
 * can complete adoption. Returns an empty list if discovery never
 * received a packet (e.g. host without UDP multicast).
 */
printersRouter.get('/discovered', requireRequestPermission(PRINTERS_MANAGE_PERMISSION), async (request, response) => {
  const tenantId = requireRequestTenantId(request)
  const bridges = await rootPrisma.bridge.findMany({
    where: { tenantId },
    select: { id: true }
  })
  const bridgeIds = bridges.map((bridge) => bridge.id)
  if (bridgeIds.length === 0) {
    response.json({ printers: [] })
    return
  }
  const adopted = await prisma.printer.findMany({
    where: { tenantId },
    select: { serial: true }
  })
  const adoptedSerials = new Set(adopted.map((row) => row.serial))
  const printers = printerDiscovery
    .list({ tenantId, bridgeIds })
    .filter((entry) => !adoptedSerials.has(entry.serial))
  response.json({ printers })
})

/** Forget a discovered entry (e.g. user dismissed it from the UI). */
printersRouter.delete('/discovered/:serial', requireRequestPermission(PRINTERS_MANAGE_PERMISSION), (request, response) => {
  const serial = requireRouteParam(request.params.serial, 'Printer serial')
  printerDiscovery.dismiss(serial, requireRequestTenantId(request))
  annotateRequestAuditLog(request, {
    action: 'dismiss-discovered-printer',
    resource: 'printer',
    summary: `Dismissed discovered printer ${serial}.`,
    metadata: {
      serial
    }
  })
  response.status(204).end()
})

printersRouter.post('/validate', requireRequestPermission(PRINTERS_MANAGE_PERMISSION), async (request, response) => {
  requireRequestTenantId(request)
  const parsed = printerConnectionValidationRequestSchema.safeParse(request.body)
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid printer validation payload')
  }

  await assertBridgeAssignmentExists(parsed.data.bridgeId)
  const validation = await validatePrinterLanConnection({
    host: parsed.data.host,
    serial: parsed.data.serial,
    accessCode: parsed.data.accessCode
  }, parsed.data.bridgeId)
  response.json(validation)
})

printersRouter.post('/', requireRequestPermission(PRINTERS_MANAGE_PERMISSION), async (request, response) => {
  assertPrinterMutationsAllowed(request)
  const parsed = printerMutationInputSchema.safeParse(request.body)
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid printer payload')
  }
  await assertBridgeAssignmentExists(parsed.data.bridgeId)
  const tenantId = requireRequestTenantId(request)
  const last = await prisma.printer.findFirst({ orderBy: { position: 'desc' } })
  const created = await prisma.printer.create({
    data: {
      tenantId,
      name: parsed.data.name,
      host: parsed.data.host,
      serial: parsed.data.serial,
      accessCode: parsed.data.accessCode,
      model: parsed.data.model,
      bridgeId: parsed.data.bridgeId ?? null,
      currentPlateType: parsed.data.currentPlateType,
      currentNozzleDiameters: serializePrinterNozzleDiameters(parsed.data.currentNozzleDiameters),
      position: (last?.position ?? -1) + 1
    }
  })
  const dto = toPrinterDto(created)
  printerManager.add(dto, created.tenantId, created.bridgeId)
  await syncBridgePrinterConfig(created.bridgeId)
  // Hide the discovery entry only for the adopting tenant so the same
  // serial can still be adopted elsewhere if printers are shared or
  // migrated between tenants.
  printerDiscovery.dismiss(dto.serial, created.tenantId)
  // Never record the LAN access code in the audit trail.
  annotateRequestAuditLog(request, {
    action: 'add-printer',
    resource: 'printer',
    summary: `Added printer ${created.name} (${created.model}).`,
    metadata: {
      printerId: created.id,
      printerName: created.name,
      model: created.model,
      host: created.host,
      bridgeId: created.bridgeId
    }
  })
  response.status(201).json({ printer: toPublicPrinterDto(created) })
})

printersRouter.patch('/:id', requireRequestPermission(PRINTERS_MANAGE_PERMISSION), async (request, response) => {
  assertPrinterMutationsAllowed(request)
  const printerId = requireRouteParam(request.params.id, 'Printer id')
  const existing = await prisma.printer.findUnique({ where: { id: printerId } })
  if (!existing) throw notFound('Printer not found')
  const current = toPrinterDto(existing)
  const parsed = printerMutationInputSchema.safeParse({ ...current, ...request.body })
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid printer payload')
  }
  await assertBridgeAssignmentExists(parsed.data.bridgeId)
  const updated = await prisma.printer.update({
    where: { id: existing.id },
    data: {
      ...(request.body.name !== undefined ? { name: parsed.data.name } : {}),
      ...(request.body.host !== undefined ? { host: parsed.data.host } : {}),
      ...(request.body.serial !== undefined ? { serial: parsed.data.serial } : {}),
      ...(request.body.accessCode !== undefined ? { accessCode: parsed.data.accessCode } : {}),
      ...(request.body.model !== undefined ? { model: parsed.data.model } : {}),
      ...(request.body.bridgeId !== undefined ? { bridgeId: parsed.data.bridgeId ?? null } : {}),
      ...(request.body.currentPlateType !== undefined ? { currentPlateType: parsed.data.currentPlateType } : {}),
      ...(request.body.currentNozzleDiameters !== undefined
        ? { currentNozzleDiameters: serializePrinterNozzleDiameters(parsed.data.currentNozzleDiameters) }
        : {})
    }
  })
  const dto = toPrinterDto(updated)
  printerManager.update(dto, updated.tenantId, updated.bridgeId)
  await Promise.all(Array.from(new Set([existing.bridgeId, updated.bridgeId].filter((bridgeId): bridgeId is string => Boolean(bridgeId)))).map(syncBridgePrinterConfig))
  // Record which fields were edited. The LAN access code is a secret: never
  // record its value — only note that it changed.
  const editableFields = ['name', 'host', 'serial', 'accessCode', 'model', 'bridgeId', 'currentPlateType', 'currentNozzleDiameters'] as const
  const changedFields = editableFields.filter((field) => request.body[field] !== undefined)
  annotateRequestAuditLog(request, {
    action: 'edit-printer',
    resource: 'printer',
    summary: changedFields.length > 0
      ? `Edited printer ${updated.name} (${changedFields.join(', ')}).`
      : `Edited printer ${updated.name}.`,
    metadata: {
      printerId: updated.id,
      printerName: updated.name,
      changedFields
    }
  })
  response.json({ printer: toPublicPrinterDto(updated) })
})

printersRouter.delete('/:id', requireRequestPermission(PRINTERS_MANAGE_PERMISSION), async (request, response) => {
  assertPrinterMutationsAllowed(request)
  const printerId = requireRouteParam(request.params.id, 'Printer id')
  const existing = await prisma.printer.findUnique({ where: { id: printerId } })
  if (!existing) throw notFound('Printer not found')
  annotateRequestAuditLog(request, {
    action: 'delete-printer',
    resource: 'printer',
    summary: `Deleted printer ${existing.name}.`,
    metadata: {
      printerId: existing.id,
      printerName: existing.name
    }
  })
  await prisma.printer.delete({ where: { id: existing.id } })
  printerManager.remove(existing.id)
  await syncBridgePrinterConfig(existing.bridgeId)
  response.status(204).end()
})

printersRouter.post('/reorder', requireRequestPermission(PRINTERS_MANAGE_PERMISSION), async (request, response) => {
  assertPrinterMutationsAllowed(request)
  const parsed = printerReorderSchema.safeParse(request.body)
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid reorder payload')
  }
  await prisma.$transaction(
    parsed.data.orderedIds.map((id, index) =>
      prisma.printer.update({ where: { id }, data: { position: index } })
    )
  )
  response.status(204).end()
})

printersRouter.post('/:id/command', async (request, response) => {
  const parsed = printerCommandSchema.safeParse(request.body)
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid command payload')
  }
  assertRequestPermission(request, getPrinterCommandPermission(parsed.data))
  const printerId = requireRouteParam(request.params.id, 'Printer id')
  const existing = await prisma.printer.findUnique({ where: { id: printerId } })
  if (!existing) throw notFound('Printer not found')
  const status = printerManager.getStatus(existing.id)
  const relatedJobId = await resolveRelevantPrintJobId(existing.id)

  if (parsed.data.type === 'calibrate') {
    validateCalibrationCommand(existing.model, parsed.data)
  }

  validatePrinterControlCommand(existing.model, status, parsed.data)

  if (parsed.data.type === 'calibrate') {
    const option = calibrationOption(parsed.data)
    if (option === 0) throw badRequest('At least one calibration option must be selected')
    const blocked = printGuards.evaluate({ printerId: existing.id, source: 'calibration' })
    if (blocked) throw conflict(blocked.reason ?? 'Calibration blocked by a plugin')
    const calibrationJobId = await startCalibrationJob({ printerId: existing.id, printerName: existing.name, option })
    if (!calibrationJobId) {
      throw badRequest('Printer is not connected — command was not delivered')
    }
    annotateRequestAuditLog(request, {
      action: 'start-calibration',
      resource: 'print job',
      summary: `Started calibration on ${existing.name}.`,
      metadata: {
        printerId: existing.id,
        printerName: existing.name,
        calibrationOption: option,
        jobId: calibrationJobId
      }
    })
    response.status(202).end()
    return
  }

  const payloads = commandToMqttPayloads(existing.model, parsed.data, status)
  if (payloads.length > 0) {
    let anySent = false
    for (const payload of payloads) {
      if (printerManager.publishCommand(existing.id, payload)) anySent = true
    }
    if (!anySent) {
      if (parsed.data.type === 'refresh') {
        await reconnectPrinter(toPrinterDto(existing))
        response.status(202).end()
        return
      }
      throw badRequest('Printer is not connected — command was not delivered')
    }
  }
  const commandAudit = describePrinterCommandAudit(parsed.data)
  if (commandAudit) {
    annotateRequestAuditLog(request, {
      action: commandAudit.action,
      resource: commandAudit.resource,
      summary: `${commandAudit.summary} on ${existing.name}.`,
      metadata: {
        printerId: existing.id,
        printerName: existing.name,
        jobId: relatedJobId,
        commandType: parsed.data.type,
        ...describePrinterCommandAuditMetadata(parsed.data)
      }
    })
  }
  response.status(202).end()
})

printersRouter.get('/:id/pressure-advance-profiles', requireRequestPermission(PRINTERS_MANAGE_AMS_SCOPE), async (request, response) => {
  const parsed = pressureAdvanceProfilesQuerySchema.safeParse(request.query)
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid pressure-advance profile query')
  }

  const printerId = requireRouteParam(request.params.id, 'Printer id')
  const existing = await prisma.printer.findUnique({ where: { id: printerId } })
  if (!existing) throw notFound('Printer not found')

  const status = printerManager.getStatus(existing.id)
  requireLiveControlConnection(status, 'Pressure-advance profiles')
  const context = resolvePressureAdvanceCommandContext(status, parsed.data.amsId)

  try {
    const profiles = await printerManager.requestPressureAdvanceProfiles(existing.id, {
      filamentId: parsed.data.filamentId,
      extruderId: context.extruderId,
      nozzleDiameter: context.nozzleDiameter,
      nozzleTypeCode: context.nozzleTypeCode
    })
    response.json(printerPressureAdvanceProfilesResponseSchema.parse({ profiles }))
  } catch (error) {
    throw badRequest(extractErrorMessage(error, 'Unable to load pressure-advance profiles'))
  }
})

printersRouter.get('/:id/active-print-objects', requireRequestPermission(PRINTERS_VIEW_PERMISSION), async (request, response) => {
  const printer = await requireTenantOwnedConnectedPrinter(requireRouteParam(request.params.id, 'Printer id'))
  if (!printer) throw notFound('Printer not found or not connected')

  const status = printerManager.getStatus(printer.id)
  const jobName = status?.jobName ?? printerManager.getLastJobName(printer.id)
  if (!jobName) {
    response.json(printerActivePrintObjectsSchema.parse({ objects: [], loading: false }))
    return
  }

  const gcodeFile = status?.gcodeFile ?? null
  const taskId = status?.taskId ?? null
  const cached = getCachedActivePrintObjects(printer.id, jobName, gcodeFile, taskId)
  if (cached) {
    const persistedJob = taskId ? await getActivePrintJobAssets(printer.id, taskId) : null
    const unavailableGcodeFile = choosePreferredExactPrinterFilePath(gcodeFile, persistedJob?.printerFilePath) ?? gcodeFile
    const unavailableState = inferActivePrintObjectsUnavailableState(printer, unavailableGcodeFile, cached)

    response.json(printerActivePrintObjectsSchema.parse({
      objects: cached,
      loading: false,
      unavailableReason: unavailableState?.unavailableReason ?? null,
      unavailableMessage: unavailableState?.unavailableMessage ?? null
    }))
    return
  }

  void preloadActivePrintObjects(printer.id, {
    jobName,
    gcodeFile,
    taskId
  })

  response.json(printerActivePrintObjectsSchema.parse({
    objects: [],
    loading: true,
    unavailableReason: null,
    unavailableMessage: null
  }))
})

function getPrinterCommandPermission(
  command: ReturnType<typeof printerCommandSchema.parse>
): PermissionScope {
  switch (command.type) {
    case 'refresh':
      return PRINTERS_CONTROL_REFRESH_SCOPE
    case 'calibrate':
      return PRINTERS_CONTROL_CALIBRATE_SCOPE
    case 'clearHmsErrors':
      return PRINTERS_CONTROL_HMS_CLEAR_SCOPE
    case 'setPrintOption':
      return PRINTERS_MANAGE_SETTINGS_SCOPE
    case 'setAmsUserSettings':
    case 'setAmsFilamentBackup':
    case 'startAmsDrying':
    case 'stopAmsDrying':
    case 'rescanAmsSlot':
    case 'setAmsSlot':
    case 'resetAmsSlot':
    case 'loadAmsFilament':
    case 'unloadAmsFilament':
    case 'setExternalSpool':
    case 'resetExternalSpool':
    case 'loadExternalSpool':
    case 'unloadExternalSpool':
    case 'selectAmsPressureAdvanceProfile':
    case 'createAmsPressureAdvanceProfile':
    case 'deleteAmsPressureAdvanceProfile':
    case 'setAmsKValue':
      return PRINTERS_MANAGE_AMS_SCOPE
    default:
      return PRINTERS_CONTROL_MANUAL_CONTROLS_SCOPE
  }
}

/**
 * Maps a printer command to a readable audit action/resource/summary. Every
 * command type produces an entry so the durable audit trail stays readable;
 * the `:id/command` handler attaches the command type (and, for AMS slot
 * commands, the unit/slot indices — never filament secrets) as metadata.
 *
 * `calibrate` is intentionally absent: it is audited on its own success path
 * (with the calibration option + job id) before this helper runs.
 */
function describePrinterCommandAudit(
  command: ReturnType<typeof printerCommandSchema.parse>
): { action: string; resource: string; summary: string } | null {
  switch (command.type) {
    case 'pause':
      return { action: 'pause-print', resource: 'print job', summary: 'Paused print' }
    case 'resume':
      return { action: 'resume-print', resource: 'print job', summary: 'Resumed print' }
    case 'ignoreHmsError':
      return { action: 'resume-print', resource: 'print job', summary: 'Ignored printer warning and resumed print' }
    case 'retryAmsFilamentChange':
      return { action: 'resume-print', resource: 'filament change', summary: 'Retried filament change step' }
    case 'confirmAmsFilamentExtruded':
      return { action: 'resume-print', resource: 'filament change', summary: 'Confirmed filament extrusion and continued change' }
    case 'stop':
      return { action: 'stop-print', resource: 'print job', summary: 'Stopped print' }
    case 'skipObjects':
      return { action: 'skip-objects', resource: 'print job', summary: 'Skipped print objects' }
    case 'clearHmsErrors':
      return { action: 'clear-hms-errors', resource: 'printer', summary: 'Cleared printer HMS errors' }
    case 'refresh':
      return { action: 'refresh-printer', resource: 'printer', summary: 'Refreshed printer connection' }
    case 'light':
      return { action: 'set-printer-light', resource: 'printer', summary: `Turned ${command.on ? 'on' : 'off'} the ${command.node} light` }
    case 'setAirductMode':
      return { action: 'set-air-management', resource: 'printer', summary: 'Changed air management mode' }
    case 'setPrintOption':
      return { action: 'set-print-option', resource: 'printer', summary: `Changed print option ${command.option} (${command.enabled ? 'on' : 'off'})` }
    case 'setNozzleTemperature':
      return { action: 'set-nozzle-temperature', resource: 'printer', summary: `Set nozzle temperature to ${command.target}C` }
    case 'setBedTemperature':
      return { action: 'set-bed-temperature', resource: 'printer', summary: `Set bed temperature to ${command.target}C` }
    case 'setChamberTemperature':
      return { action: 'set-chamber-temperature', resource: 'printer', summary: `Set chamber temperature to ${command.target}C` }
    case 'setFanSpeed':
      return { action: 'set-fan-speed', resource: 'printer', summary: `Set ${command.fan} fan to ${command.percent}%` }
    case 'setPrintSpeed':
      return { action: 'set-print-speed', resource: 'print job', summary: `Set print speed to ${command.level}` }
    case 'moveAxis':
      return { action: 'move-axis', resource: 'printer', summary: `Jogged ${command.axis} axis by ${command.distanceMm}mm` }
    case 'homeAxes':
      return { action: 'home-axes', resource: 'printer', summary: 'Homed printer axes' }
    case 'extrudeFilament':
      return { action: 'extrude-filament', resource: 'printer', summary: `Extruded/retracted filament by ${command.distanceMm}mm` }
    case 'setAmsUserSettings':
      return { action: 'set-ams-settings', resource: 'ams', summary: 'Updated AMS user settings' }
    case 'setAmsFilamentBackup':
      return { action: 'set-ams-filament-backup', resource: 'ams', summary: `Turned AMS filament backup ${command.enabled ? 'on' : 'off'}` }
    case 'startAmsDrying':
      return { action: 'start-ams-drying', resource: 'ams', summary: 'Started AMS filament drying' }
    case 'stopAmsDrying':
      return { action: 'stop-ams-drying', resource: 'ams', summary: 'Stopped AMS filament drying' }
    case 'rescanAmsSlot':
      return { action: 'rescan-ams-slot', resource: 'ams', summary: 'Rescanned an AMS slot' }
    case 'setAmsSlot':
      return { action: 'set-ams-slot', resource: 'ams', summary: 'Configured an AMS slot' }
    case 'resetAmsSlot':
      return { action: 'reset-ams-slot', resource: 'ams', summary: 'Reset an AMS slot' }
    case 'loadAmsFilament':
      return { action: 'load-ams-filament', resource: 'ams', summary: 'Loaded filament from an AMS slot' }
    case 'unloadAmsFilament':
      return { action: 'unload-ams-filament', resource: 'ams', summary: 'Unloaded filament from an AMS slot' }
    case 'setExternalSpool':
      return { action: 'set-external-spool', resource: 'ams', summary: 'Configured the external spool' }
    case 'resetExternalSpool':
      return { action: 'reset-external-spool', resource: 'ams', summary: 'Reset the external spool' }
    case 'loadExternalSpool':
      return { action: 'load-external-spool', resource: 'ams', summary: 'Loaded filament from the external spool' }
    case 'unloadExternalSpool':
      return { action: 'unload-external-spool', resource: 'ams', summary: 'Unloaded filament from the external spool' }
    case 'selectAmsPressureAdvanceProfile':
      return { action: 'select-ams-pressure-advance-profile', resource: 'ams', summary: 'Selected an AMS pressure-advance profile' }
    case 'createAmsPressureAdvanceProfile':
      return { action: 'create-ams-pressure-advance-profile', resource: 'ams', summary: `Created AMS pressure-advance profile ${command.profileName}` }
    case 'deleteAmsPressureAdvanceProfile':
      return { action: 'delete-ams-pressure-advance-profile', resource: 'ams', summary: 'Deleted an AMS pressure-advance profile' }
    case 'setAmsKValue':
      return { action: 'set-ams-k-value', resource: 'ams', summary: `Set AMS pressure-advance K value to ${command.kValue}` }
    default:
      return null
  }
}

/**
 * Non-secret metadata to attach for a printer command. Includes AMS unit/slot
 * (and external-spool tray) indices where relevant, but never filament
 * secrets such as tray colors or filament preset ids.
 */
function describePrinterCommandAuditMetadata(
  command: ReturnType<typeof printerCommandSchema.parse>
): Record<string, unknown> {
  switch (command.type) {
    case 'skipObjects':
      return { objectIds: command.objectIds }
    case 'light':
      return { lightNode: command.node, on: command.on }
    case 'setPrintOption':
      return { option: command.option, enabled: command.enabled }
    case 'setFanSpeed':
      return { fan: command.fan, percent: command.percent }
    case 'setNozzleTemperature':
      return { target: command.target, extruderId: command.extruderId }
    case 'setBedTemperature':
    case 'setChamberTemperature':
      return { target: command.target }
    case 'setPrintSpeed':
      return { level: command.level }
    case 'moveAxis':
      return { axis: command.axis, distanceMm: command.distanceMm }
    case 'extrudeFilament':
      return { distanceMm: command.distanceMm, extruderId: command.extruderId }
    case 'setAmsFilamentBackup':
      return { enabled: command.enabled }
    case 'startAmsDrying':
    case 'stopAmsDrying':
      return { amsId: command.amsId }
    case 'rescanAmsSlot':
    case 'setAmsSlot':
    case 'resetAmsSlot':
    case 'loadAmsFilament':
    case 'unloadAmsFilament':
    case 'selectAmsPressureAdvanceProfile':
    case 'deleteAmsPressureAdvanceProfile':
    case 'setAmsKValue':
      return { amsId: command.amsId, slotId: command.slotId }
    case 'createAmsPressureAdvanceProfile':
      return { amsId: command.amsId, slotId: command.slotId, profileName: command.profileName }
    case 'setExternalSpool':
    case 'resetExternalSpool':
    case 'loadExternalSpool':
    case 'unloadExternalSpool':
      return { amsId: command.amsId }
    default:
      return {}
  }
}

function validateCalibrationCommand(
  model: string,
  command: Extract<ReturnType<typeof printerCommandSchema.parse>, { type: 'calibrate' }>
): void {
  const normalizedModel = printerModelSchema.safeParse(model).success ? printerModelSchema.parse(model) : 'unknown'
  const capabilities = getPrinterCalibrationCapabilities(normalizedModel)
  const unsupported: string[] = []
  if (command.xcam && !capabilities.xcam) unsupported.push('Micro Lidar calibration')
  if (command.bedLeveling && !capabilities.bedLeveling) unsupported.push('Auto bed leveling')
  if (command.vibration && !capabilities.vibration) unsupported.push('Vibration compensation')
  if (command.motorNoise && !capabilities.motorNoise) unsupported.push('Motor noise cancellation')
  if (command.nozzleOffset && !capabilities.nozzleOffset) unsupported.push('Nozzle offset calibration')
  if (command.highTempHeatbed && !capabilities.highTempHeatbed) unsupported.push('High-temperature bed leveling')
  if (command.nozzleClumping && !capabilities.nozzleClumping) unsupported.push('Nozzle clumping detection')
  if (unsupported.length > 0) {
    throw badRequest(`${unsupported.join(', ')} not supported on ${normalizedModel}`)
  }
}

function validatePrinterControlCommand(
  model: string,
  status: ReturnType<typeof printerManager.getStatus>,
  command: ReturnType<typeof printerCommandSchema.parse>
): void {
  const normalizedModel = printerModelSchema.safeParse(model).success ? printerModelSchema.parse(model) : 'unknown'
  const capabilities = getPrinterControlCapabilities(normalizedModel)

  switch (command.type) {
    case 'pause':
      requirePrinterActionAvailability(getPauseAvailability(status))
      return
    case 'resume':
      requirePrinterActionAvailability(getResumeAvailability(status))
      return
    case 'ignoreHmsError':
      requirePrinterActionAvailability(getIgnoreHmsErrorAvailability(status))
      return
    case 'retryAmsFilamentChange':
      requirePrinterActionAvailability(getRetryAmsFilamentChangeAvailability(status))
      return
    case 'confirmAmsFilamentExtruded':
      requirePrinterActionAvailability(getConfirmAmsFilamentExtrudedAvailability(status))
      return
    case 'stop':
      requirePrinterActionAvailability(getStopAvailability(status))
      return
    case 'light':
      requireLiveControlConnection(status, 'Light control')
      if (command.node !== 'chamber' && status?.lightCapabilities[command.node] !== true) {
        throw badRequest(`${lightNodeLabel(command.node)} is not available on this printer`)
      }
      return
    case 'setAirductMode':
      requireLiveControlConnection(status, 'Air management')
      if (!supportsPrinterAirductMode(normalizedModel)) {
        throw badRequest(`${normalizedModel} does not support air management`)
      }
      return
    case 'setPrintOption':
      requireLiveControlConnection(status, 'Printer settings')
      return
    case 'setNozzleTemperature':
      requireLiveControlConnection(status, 'Temperature control')
      if (!capabilities.nozzleTemperature) throw badRequest(`${normalizedModel} does not support nozzle temperature control`)
      if (command.extruderId > 0 && !capabilities.dualNozzles) {
        throw badRequest('This printer only has one controllable nozzle')
      }
      return
    case 'setBedTemperature':
      requireLiveControlConnection(status, 'Temperature control')
      if (!capabilities.bedTemperature) throw badRequest(`${normalizedModel} does not support bed temperature control`)
      return
    case 'setChamberTemperature': {
      requireLiveControlConnection(status, 'Temperature control')
      if (!capabilities.chamberTemperature) {
        throw badRequest(`${normalizedModel} does not support chamber temperature control`)
      }
      const chamberTargetMax = getPrinterChamberTemperatureMax(normalizedModel)
      if (command.target > chamberTargetMax) {
        throw badRequest(`${normalizedModel} chamber temperature must be ${chamberTargetMax}C or lower`)
      }
      return
    }
    case 'setFanSpeed':
      requireLiveControlConnection(status, 'Fan control')
      if (command.fan === 'aux' && !capabilities.auxFan) {
        throw badRequest(`${normalizedModel} does not support auxiliary fan control`)
      }
      if (command.fan === 'chamber' && !capabilities.chamberFan) {
        throw badRequest(`${normalizedModel} does not support chamber fan control`)
      }
      if (command.fan === 'part' && !capabilities.partFan) {
        throw badRequest(`${normalizedModel} does not support part fan control`)
      }
      return
    case 'setPrintSpeed':
      requireLiveControlConnection(status, 'Print speed control')
      if (!capabilities.printSpeed) throw badRequest(`${normalizedModel} does not support print speed control`)
      if (!canUsePrintSpeedControl(status)) {
        throw badRequest('Print speed can only be changed while a print is active')
      }
      return
    case 'moveAxis':
    case 'homeAxes':
      requireLiveControlConnection(status, 'Motion control')
      if (!capabilities.motion) throw badRequest(`${normalizedModel} does not support motion control`)
      if (!canUseMotionControl(status)) {
        throw badRequest('Motion control is only available while the printer is idle')
      }
      return
    case 'extrudeFilament':
      requireLiveControlConnection(status, 'Extruder control')
      if (!capabilities.extruderControl) throw badRequest(`${normalizedModel} does not support extruder control`)
      if (command.extruderId > 0 && !capabilities.dualNozzles) {
        throw badRequest('This printer only has one controllable nozzle')
      }
      if (!canUseExtruderControl(status, command.extruderId)) {
        throw badRequest(`Extruder control requires an idle printer with the nozzle heated to at least ${PRINTER_EXTRUDER_CONTROL_MIN_TEMP_C}C`)
      }
      return
    case 'selectAmsPressureAdvanceProfile':
    case 'createAmsPressureAdvanceProfile':
    case 'deleteAmsPressureAdvanceProfile':
    case 'setAmsKValue':
      requireLiveControlConnection(status, 'Pressure advance control')
      return
    case 'loadAmsFilament':
      requirePrinterActionAvailability(getAmsLoadFilamentAvailability(status, command.amsId, command.slotId))
      return
    case 'unloadAmsFilament':
      requirePrinterActionAvailability(getAmsUnloadFilamentAvailability(status, command.amsId, command.slotId))
      return
    case 'loadExternalSpool':
      requirePrinterActionAvailability(getExternalSpoolLoadAvailability(status, command.amsId))
      return
    case 'unloadExternalSpool':
      requirePrinterActionAvailability(getExternalSpoolUnloadAvailability(status, command.amsId))
      return
    default:
      return
  }
}

function requirePrinterActionAvailability(result: { allowed: boolean; reason: string | null }): void {
  if (!result.allowed) throw badRequest(result.reason ?? 'Command is not currently available')
}

function requireLiveControlConnection(status: ReturnType<typeof printerManager.getStatus>, label: string): void {
  if (status?.online !== true) {
    throw badRequest(`${label} is only available while the printer is connected`)
  }
}

function lightNodeLabel(node: Extract<ReturnType<typeof printerCommandSchema.parse>, { type: 'light' }>['node']): string {
  switch (node) {
    case 'chamber':
      return 'Chamber light'
    case 'heatbed':
      return 'Heatbed light'
  }
}

/**
 * Best-effort cover image for the currently printing job.
 *
 * Bambu's MQTT report does not include an embedded thumbnail in LAN
 * mode. We prefer PrintStream-owned local assets, then a persisted exact
 * printer archive path when one has been observed for the active job.
 */
printersRouter.get('/:id/cover/status', requireRequestPermission(PRINTERS_VIEW_PERMISSION), async (request, response) => {
  const printerId = requireRouteParam(request.params.id, 'Printer id')
  await assertTenantOwnsPrinter(printerId)
  response.json(getCoverLoadState(printerId))
})

printersRouter.get('/:id/cover', requireRequestPermission(PRINTERS_VIEW_PERMISSION), async (request, response) => {
  const printer = await requireTenantOwnedConnectedPrinter(requireRouteParam(request.params.id, 'Printer id'))
  if (!printer) throw notFound('Printer not found')
  const requestStartedAt = Date.now()
  let resolveDurationMs: number | null = null
  let extractDurationMs: number | null = null
  let sourcePath: string | null = null
  let outcome = 'error'
  const signal = requestAbortSignal(request, response)
  const status = printerManager.getStatus(printer.id)
  const jobQuery = typeof request.query.job === 'string' ? request.query.job : null
  const gcodeQuery = typeof request.query.gcode === 'string' ? request.query.gcode : null
  const taskQuery = typeof request.query.task === 'string' ? request.query.task : null
  const plateQuery = parsePositiveIntQuery(request.query.plate)
  const jobName = status?.jobName ?? printerManager.getLastJobName(printer.id) ?? jobQuery
  if (!jobName) throw notFound('No active job')

  const gcodeFile = choosePreferredCoverFileHint(status?.gcodeFile ?? null, gcodeQuery)
  const taskId = status?.taskId ?? taskQuery
  let plateIndex = extractObservedPrintPlateIndex(gcodeFile)
  const finishResolve = () => {
    if (resolveDurationMs == null) resolveDurationMs = Date.now() - requestStartedAt
  }

  try {
    setCoverLoadState(printer.id, {
      status: 'resolving',
      progressPercent: null,
      message: 'Resolving active print file…'
    })

    const persistedJob = await getActivePrintJobAssets(printer.id, taskId)
    const selectedPlateGcodeFile = buildPlateGcodeFileHint(persistedJob?.plate ?? plateQuery)
    const thumbnailGcodeFile = chooseCoverThumbnailFileHint(gcodeFile, selectedPlateGcodeFile)
    let exactPrinterFilePath = choosePreferredExactPrinterFilePath(status?.gcodeFile ?? null, persistedJob?.printerFilePath)
    plateIndex = extractObservedPrintPlateIndex(thumbnailGcodeFile)

    const localSourcePath = await getDispatchedPrintSource(printer.id, taskId)
    if (localSourcePath) {
      sourcePath = localSourcePath
      const localCacheKey = await buildLocalCoverCacheKey(printer, localSourcePath, thumbnailGcodeFile).catch(() => null)
      if (localCacheKey) {
        const cached = await getCachedCover(localCacheKey)
        if (cached) {
          finishResolve()
          outcome = 'local-cache-hit'
          clearCoverLoadState(printer.id)
          sendCover(response, cached)
          return
        }

        if (!isNegativeCached(localCacheKey)) {
          finishResolve()
          setCoverLoadState(printer.id, {
            status: 'extracting',
            progressPercent: null,
            message: 'Extracting plate preview…'
          })
          const extractingStartedAt = Date.now()
          try {
            const png = await readCoverFromLocalFile(localSourcePath, thumbnailGcodeFile, signal)
            extractDurationMs = Date.now() - extractingStartedAt
            outcome = 'local-extract'
            await setCachedCover(localCacheKey, png)
            clearCoverLoadState(printer.id)
            sendCover(response, png)
            return
          } catch (error) {
            extractDurationMs = Date.now() - extractingStartedAt
            if ((error as Error).name === 'AbortError') return
            markCoverMiss(localCacheKey)
          }
        }
      }
    }

    if (persistedJob?.localSourcePath) {
      sourcePath = persistedJob.localSourcePath
      const localCacheKey = await buildLocalCoverCacheKey(printer, persistedJob.localSourcePath, thumbnailGcodeFile).catch(() => null)
      if (localCacheKey) {
        const cached = await getCachedCover(localCacheKey)
        if (cached) {
          finishResolve()
          outcome = 'job-local-cache-hit'
          clearCoverLoadState(printer.id)
          sendCover(response, cached)
          return
        }

        if (!isNegativeCached(localCacheKey)) {
          finishResolve()
          setCoverLoadState(printer.id, {
            status: 'extracting',
            progressPercent: null,
            message: 'Extracting plate preview…'
          })
          const extractingStartedAt = Date.now()
          try {
            const png = await readCoverFromLocalFile(persistedJob.localSourcePath, thumbnailGcodeFile, signal)
            extractDurationMs = Date.now() - extractingStartedAt
            outcome = 'job-local-extract'
            await setCachedCover(localCacheKey, png)
            clearCoverLoadState(printer.id)
            sendCover(response, png)
            return
          } catch (error) {
            extractDurationMs = Date.now() - extractingStartedAt
            if ((error as Error).name === 'AbortError') return
            markCoverMiss(localCacheKey)
          }
        }
      }
    }

    if (persistedJob?.thumbnailPath) {
      const png = await readPrintJobThumbnail(persistedJob.thumbnailPath)
      if (png) {
        finishResolve()
        outcome = 'job-thumbnail-hit'
        clearCoverLoadState(printer.id)
        sendCover(response, png)
        return
      }
    }

    exactPrinterFilePath ??= await resolvePrinterCoverPath(
      printer,
      jobName,
      thumbnailGcodeFile,
      { allowLatestFallback: false }
    ).catch(() => null)

    if (exactPrinterFilePath) {
      sourcePath = exactPrinterFilePath
      const printerCacheKey = buildPrinterCoverCacheKey(printer, exactPrinterFilePath, thumbnailGcodeFile)
      const cached = await getCachedCover(printerCacheKey)
      if (cached) {
        finishResolve()
        outcome = 'printer-cache-hit'
        clearCoverLoadState(printer.id)
        sendCover(response, cached)
        return
      }

      if (!isNegativeCached(printerCacheKey)) {
        finishResolve()
        setCoverLoadState(printer.id, {
          status: 'extracting',
          progressPercent: null,
          message: 'Extracting plate preview…'
        })
        const extractingStartedAt = Date.now()
        try {
          const png = await readPrinterStorageThumbnail(printer, exactPrinterFilePath, {
            plateIndex: extractObservedPrintPlateIndex(thumbnailGcodeFile),
            signal
          })
          extractDurationMs = Date.now() - extractingStartedAt
          if (png) {
            outcome = 'printer-extract'
            await setCachedCover(printerCacheKey, png)
            clearCoverLoadState(printer.id)
            sendCover(response, png)
            return
          }
          markCoverMiss(printerCacheKey)
        } catch (error) {
          extractDurationMs = Date.now() - extractingStartedAt
          if ((error as Error).name === 'AbortError') return
          markCoverMiss(printerCacheKey)
        }
      }
    }

    finishResolve()
    outcome = 'not-found'
    clearCoverLoadState(printer.id)
    throw notFound('Cover image unavailable')
  } finally {
    clearCoverLoadState(printer.id)
    logCoverLoad(printer, {
      outcome,
      totalMs: Date.now() - requestStartedAt,
      resolveMs: resolveDurationMs,
      extractMs: extractDurationMs,
      sourcePath,
      plateIndex,
      gcodeFile
    })
  }
})

function sendCover(response: import('express').Response, png: Buffer): void {
  response.setHeader('Content-Type', 'image/png')
  response.setHeader('Cache-Control', 'private, max-age=300')
  response.send(png)
}

async function buildLocalCoverCacheKey(printer: Printer, filePath: string, gcodeFile: string | null): Promise<string> {
  const entry = await stat(filePath)
  return `${printer.serial}:local:${filePath}:${entry.mtimeMs}:${entry.size}:plate:${extractObservedPrintPlateIndex(gcodeFile) ?? 1}`
}

function buildPrinterCoverCacheKey(printer: Printer, filePath: string, gcodeFile: string | null): string {
  return `${printer.serial}:printer:${filePath}:plate:${extractObservedPrintPlateIndex(gcodeFile) ?? 1}`
}

async function readCoverFromLocalFile(filePath: string, gcodeFile: string | null, signal?: AbortSignal): Promise<Buffer> {
  try {
    return await readCoverFromArchive(filePath, gcodeFile, signal)
  } catch {
    throw notFound('Cover image not found in print file')
  }
}

async function readTimelapseThumbnail(
  printer: Printer,
  filePath: string,
  signal?: AbortSignal
): Promise<{ buffer: Buffer; mimeType: 'image/jpeg' | 'image/png' } | null> {
  const candidates = buildTimelapseThumbnailCandidates(filePath)
  const jpeg = await downloadFileFromPrinter(printer, candidates.jpg, undefined, { signal }).catch(() => null)
  if (jpeg) return { buffer: jpeg, mimeType: 'image/jpeg' }
  const png = await downloadFileFromPrinter(printer, candidates.png, undefined, { signal }).catch(() => null)
  if (png) return { buffer: png, mimeType: 'image/png' }
  return null
}

function logPrinterStorageThumbnailRequest(printer: Printer, details: {
  kind: 'model' | 'timelapse'
  filePath: string
  outcome: 'hit' | 'miss'
  mimeType?: string
}): void {
  if (env.NODE_ENV === 'production') return

  const parts = [
    `[storage-thumbnail:${printer.name}]`,
    `kind=${details.kind}`,
    `outcome=${details.outcome}`,
    `path=${details.filePath}`
  ]
  if (details.mimeType) parts.push(`mime=${details.mimeType}`)
  console.info(parts.join(' '))
}

/**
 * Normalise a user-supplied path to a printer-absolute POSIX path. We
 * disallow `..` segments to keep callers from escaping the FTP root, and
 * collapse double slashes for predictable matching.
 */
function normalizePrinterPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return '/'
  const segments = raw.split('/').filter((segment) => segment.length > 0)
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    throw badRequest('Invalid path')
  }
  return '/' + segments.join('/')
}

/**
 * Bambu firmware-managed directories that never contain user-printable
 * models. Skipping them keeps the recursive Models listing fast on
 * printers with full SD cards (timelapses, camera dumps, etc.). The
 * list is intentionally conservative — anything not on it is treated
 * as a possible custom folder and will be searched.
 */
const RECURSIVE_SKIP_DIRS: ReadonlySet<string> = new Set([
  'cam',
  'corelogger',
  'image',
  'upcam',
  'language',
  'logger',
  'recorder',
  'timelapse',
  // Thumbnails generated alongside recorded timelapses; nothing
  // user-actionable lives there.
  'thumbnail'
])

/** GET /api/printers/:id/storage?path=/&recursive=1 — list files+folders. */
printersRouter.get('/:id/storage', requireRequestPermission(PRINTER_STORAGE_VIEW_PERMISSION), async (request, response) => {
  const printer = await requireTenantOwnedConnectedPrinter(requireRouteParam(request.params.id, 'Printer id'))
  if (!printer) throw notFound('Printer not found or not connected')
  const dirPath = normalizePrinterPath(request.query.path)
  const recursive = request.query.recursive === '1' || request.query.recursive === 'true'
  const signal = requestAbortSignal(request, response)
  try {
    const entries = recursive
      ? await listPrinterDirectoryRecursive(printer, dirPath, 4, RECURSIVE_SKIP_DIRS, { signal })
      : await listPrinterDirectory(printer, dirPath, { signal })
    response.json({ path: dirPath, entries })
  } catch (error) {
    if ((error as Error).name === 'AbortError') return
    throw badRequest((error as Error).message || 'Failed to list directory')
  }
})

/** Upload a file directly into an existing printer-storage directory. */
printersRouter.post(
  '/:id/storage/upload',
  requireRequestPermission(PRINTERS_MANAGE_STORAGE_UPLOAD_SCOPE),
  uploadSinglePrinterStorageFile('file'),
  async (request, response) => {
  assertPrinterMutationsAllowed(request)
  const printerId = typeof request.params.id === 'string' ? request.params.id : request.params.id?.[0]
  if (!printerId) throw badRequest('Printer id is required')
  const printer = await requireTenantOwnedConnectedPrinter(printerId)
  if (!request.file) throw badRequest('File is required')

  const dirPath = normalizePrinterPath(request.query.path)
  const fileName = sanitizePrinterStorageUploadFileName(request.file.originalname)
  const remotePath = dirPath === '/' ? `/${fileName}` : `${dirPath}/${fileName}`

  try {
    const uploadedPath = await uploadFileToPrinterPath(printer, request.file.path, remotePath)
    annotateRequestAuditLog(request, {
      action: 'upload',
      resource: 'printer storage file',
      summary: `Uploaded ${path.basename(uploadedPath)} to printer storage on ${printer.name}.`,
      metadata: {
        printerId: printer.id,
        printerName: printer.name,
        path: uploadedPath,
        fileName: path.basename(uploadedPath),
        sizeBytes: request.file.size
      }
    })
    clearPrinterStorageThreeMfInspectionCache(printer.id)
    broadcastPrinterStorageChanged(printer.id)
    response.status(201).json({ path: uploadedPath })
  } catch (error) {
    throw badRequest((error as Error).message || 'Failed to upload file')
  } finally {
    await unlink(request.file.path).catch(() => undefined)
  }
})

/** Best-effort preview image for a printer-stored model or timelapse file. */
printersRouter.get('/:id/storage/thumbnail', async (request, response) => {
  const printer = await requireTenantOwnedConnectedPrinter(requireRouteParam(request.params.id, 'Printer id'))
  if (!printer) throw notFound('Printer not found or not connected')
  const filePath = normalizePrinterPath(request.query.path)
  const extension = path.extname(filePath).toLowerCase()
  assertRequestPermission(
    request,
    extension === '.mp4' ? PRINTER_STORAGE_VIEW_TIMELAPSES_SCOPE : PRINTER_STORAGE_VIEW_MODELS_SCOPE
  )
  const signal = requestAbortSignal(request, response)

  if (extension === '.3mf') {
    const png = await readPrinterStorageThumbnail(printer, filePath, { signal })
    logPrinterStorageThumbnailRequest(printer, {
      kind: 'model',
      filePath,
      outcome: png ? 'hit' : 'miss',
      mimeType: png ? 'image/png' : undefined
    })
    if (!png) throw notFound('Thumbnail unavailable')
    response.setHeader('Content-Type', 'image/png')
    response.setHeader('Cache-Control', 'private, max-age=300')
    response.send(png)
    return
  }

  if (extension === '.mp4') {
    const image = await readTimelapseThumbnail(printer, filePath, signal)
    logPrinterStorageThumbnailRequest(printer, {
      kind: 'timelapse',
      filePath,
      outcome: image ? 'hit' : 'miss',
      mimeType: image?.mimeType
    })
    if (!image) throw notFound('Thumbnail unavailable')
    response.setHeader('Content-Type', image.mimeType)
    response.setHeader('Cache-Control', 'private, max-age=300')
    response.send(image.buffer)
    return
  }

  throw notFound('Thumbnail unavailable')
})

/** Download a printer-stored file without copying it into the library first. */
printersRouter.get('/:id/storage/download', requireRequestPermission(PRINTER_STORAGE_DOWNLOAD_PERMISSION), async (request, response) => {
  const printer = await requireTenantOwnedConnectedPrinter(requireRouteParam(request.params.id, 'Printer id'))
  if (!printer) throw notFound('Printer not found or not connected')
  const filePath = normalizePrinterPath(request.query.path)
  if (filePath === '/') throw badRequest('Invalid path')
  const signal = requestAbortSignal(request, response)
  annotateRequestAuditLog(request, {
    action: 'download',
    resource: 'printer storage file',
    summary: `Downloaded ${path.basename(filePath)} from printer storage on ${printer.name}.`,
    metadata: {
      printerId: printer.id,
      printerName: printer.name,
      path: filePath,
      fileName: path.basename(filePath)
    }
  })

  response.type(resolvePrinterStorageDownloadContentType(filePath))
  response.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(filePath))}"`)

  try {
    await streamFileFromPrinter(printer, filePath, response, undefined, { signal })
  } catch (error) {
    if ((error as Error).name === 'AbortError') return
    if (!response.headersSent) {
      throw badRequest((error as Error).message || 'Failed to download file')
    }
    response.destroy(error as Error)
  }
})

function resolvePrinterStorageDownloadContentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    case '.mp4':
      return 'video/mp4'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.gcode':
    case '.config':
    case '.txt':
    case '.log':
    case '.csv':
    case '.md5':
      return 'text/plain; charset=utf-8'
    default:
      return 'application/octet-stream'
  }
}

/** Plate index for a 3MF already stored on the printer. */
printersRouter.get('/:id/storage/plates', requireRequestPermission(PRINTER_STORAGE_VIEW_MODELS_SCOPE), async (request, response) => {
  const printer = await requireTenantOwnedConnectedPrinter(requireRouteParam(request.params.id, 'Printer id'))
  if (!printer) throw notFound('Printer not found or not connected')
  const filePath = normalizePrinterPath(request.query.path)
  const signal = requestAbortSignal(request, response)
  if (path.extname(filePath).toLowerCase() !== '.3mf') {
    response.json({ plates: [], projectFilaments: [], compatiblePrinterModels: [], supportFilamentIds: [], printerProfileName: null, processProfileName: null } satisfies ThreeMfIndex)
    return
  }

  try {
    const index = await readPrinterStorageThreeMfIndex(printer, filePath, signal)
    if (!index) {
      response.json({ plates: [], projectFilaments: [], compatiblePrinterModels: [], supportFilamentIds: [], printerProfileName: null, processProfileName: null } satisfies ThreeMfIndex)
      return
    }
    response.json({
      plates: index.plates.map((plate) => ({
        index: plate.index,
        name: plate.name,
        hasThumbnail: plate.thumbnailFile != null,
        plateType: plate.plateType,
        nozzleSizes: plate.nozzleSizes,
        filaments: plate.filaments,
        objects: plate.objects
      })),
      projectFilaments: index.projectFilaments,
      compatiblePrinterModels: index.compatiblePrinterModels,
      supportFilamentIds: index.supportFilamentIds,
      printerProfileName: index.printerProfileName,
      processProfileName: index.processProfileName
    } satisfies ThreeMfIndex)
  } catch (error) {
    if ((error as Error).name === 'AbortError') return
    throw badRequest(extractErrorMessage(error, 'Failed to read print file metadata'))
  }
})

/** DELETE /api/printers/:id/storage?path=/x.3mf&type=file — remove a file or empty directory. */
printersRouter.delete('/:id/storage', requireRequestPermission(PRINTERS_MANAGE_STORAGE_EDIT_SCOPE), async (request, response) => {
  const printer = await requireTenantOwnedConnectedPrinter(requireRouteParam(request.params.id, 'Printer id'))
  if (!printer) throw notFound('Printer not found or not connected')
  const targetPath = normalizePrinterPath(request.query.path)
  if (targetPath === '/') throw badRequest('Cannot delete root')
  const entryType = request.query.type === 'directory' ? 'directory' : 'file'
  annotateRequestAuditLog(request, {
    action: 'delete',
    resource: entryType === 'directory' ? 'printer storage directory' : 'printer storage file',
    summary: `Deleted ${targetPath} from printer storage on ${printer.name}.`,
    metadata: {
      printerId: printer.id,
      printerName: printer.name,
      path: targetPath,
      entryType
    }
  })
  try {
    if (entryType === 'directory') {
      await deletePrinterDirectory(printer, targetPath)
    } else {
      await deletePrinterFile(printer, targetPath)
    }
    clearPrinterStorageThreeMfInspectionCache(printer.id)
    broadcastPrinterStorageChanged(printer.id)
    response.status(204).end()
  } catch (error) {
    throw badRequest((error as Error).message || 'Failed to delete')
  }
})

printersRouter.post('/:id/storage/delete-jobs', requireRequestPermission(PRINTERS_MANAGE_STORAGE_EDIT_SCOPE), async (request, response) => {
  const printer = await requireTenantOwnedConnectedPrinter(requireRouteParam(request.params.id, 'Printer id'))
  if (!printer) throw notFound('Printer not found or not connected')
  const parsed = startPrinterStorageDeleteJobSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid delete payload')

  const entries = parsed.data.entries.map((entry) => ({
    path: normalizePrinterPath(entry.path),
    type: entry.type
  }))
  if (entries.some((entry) => entry.path === '/')) throw badRequest('Cannot delete root')

  const job = deleteOperationDispatcher.enqueuePrinterStorageDelete(printer.id, printer.name, entries, request.tenant?.id ?? null)
  annotateRequestAuditLog(request, {
    action: 'delete',
    resource: 'printer storage entry',
    summary: job.totalItems === 1
      ? `Queued delete of printer storage entry ${job.summaryLabel} on ${printer.name}.`
      : `Queued delete of ${job.totalItems} printer storage entries on ${printer.name}.`,
    metadata: {
      deleteOperationId: job.id,
      printerId: printer.id,
      printerName: printer.name,
      entries,
      itemCount: job.totalItems,
      summaryLabel: job.summaryLabel
    }
  })
  response.status(202).json({ job })
})

/** POST /api/printers/:id/storage/rename — rename or move a file/folder. */
printersRouter.post('/:id/storage/rename', requireRequestPermission(PRINTERS_MANAGE_STORAGE_EDIT_SCOPE), async (request, response) => {
  const printer = await requireTenantOwnedConnectedPrinter(requireRouteParam(request.params.id, 'Printer id'))
  if (!printer) throw notFound('Printer not found or not connected')
  const fromPath = normalizePrinterPath((request.body as { from?: unknown })?.from)
  const toPath = normalizePrinterPath((request.body as { to?: unknown })?.to)
  if (fromPath === '/' || toPath === '/') throw badRequest('Invalid rename target')
  annotateRequestAuditLog(request, {
    action: 'rename',
    resource: 'printer storage entry',
    summary: `Renamed printer storage entry on ${printer.name}.`,
    metadata: {
      printerId: printer.id,
      printerName: printer.name,
      fromPath,
      toPath
    }
  })
  try {
    await renamePrinterPath(printer, fromPath, toPath)
    clearPrinterStorageThreeMfInspectionCache(printer.id)
    broadcastPrinterStorageChanged(printer.id)
    response.status(204).end()
  } catch (error) {
    throw badRequest((error as Error).message || 'Failed to rename')
  }
})

/**
 * POST /api/printers/:id/storage/print — start a print of a file already
 * present on the printer's storage. No upload happens; we just publish
 * the `project_file` MQTT command pointing at the existing path.
 */
printersRouter.post('/:id/storage/print', requireRequestPermission(PRINTS_DISPATCH_PRINTER_STORAGE_SCOPE), async (request, response) => {
  const printer = await requireTenantOwnedConnectedPrinter(requireRouteParam(request.params.id, 'Printer id'))
  if (!printer) throw notFound('Printer not found or not connected')
  const parsed = printerStoragePrintSchema.safeParse(request.body)
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid print payload')
  }
  const filePath = normalizePrinterPath(parsed.data.path)
  if (!isDirectPrintableFileName(filePath)) {
    throw badRequest('Only .gcode or .gcode.3mf files can be printed directly')
  }

  const sourceKind = getPrintSourceKind(filePath)
  let storageThreeMfIndex: Awaited<ReturnType<typeof readPrinterStorageThreeMfIndex>> | null = null
  if (path.extname(filePath).toLowerCase() === '.3mf') {
    storageThreeMfIndex = await readPrinterStorageThreeMfIndex(printer, filePath)
    assertAutomaticPrintCompatibility({
      index: storageThreeMfIndex,
      plate: parsed.data.plate,
      printerModel: printer.model,
      printerStatus: printerManager.getStatus(printer.id),
      useAms: parsed.data.useAms,
      amsMapping: parsed.data.amsMapping,
      allowIncompatibleFilament: parsed.data.allowIncompatibleFilament
    })
  }

  const remoteName = filePath.replace(/^\//, '')
  const submissionId = String((Date.now() % 2_147_483_647) || 1)
  const jobName = resolvePrinterStorageJobName(
    path.basename(filePath),
    sourceKind,
    parsed.data.plate,
    storageThreeMfIndex
  )
  const printParam = sourceKind === '3mf'
    ? `Metadata/plate_${parsed.data.plate}.gcode`
    : remoteName
  const printerStatus = printerManager.getStatus(printer.id)
  const firstLayerInspectionProvided =
    typeof request.body === 'object'
    && request.body != null
    && Object.prototype.hasOwnProperty.call(request.body, 'firstLayerInspection')
  const normalizedOptions = normalizePrintStartOptionsForPrinter(
    printer.model,
    {
      ...parsed.data,
      firstLayerInspection: firstLayerInspectionProvided
        ? parsed.data.firstLayerInspection
        : resolvePrinterFirstLayerInspectionDefault(printer.model, printerStatus)
    },
    printerStatus
  )
  // Printing a file already on the printer's SD is still a print start, so it must
  // honor plugin print guards (e.g. plate-clearing) like dispatch and reprint do —
  // otherwise this route is a hole that prints onto an uncleared plate.
  const blocked = printGuards.evaluate({ printerId: printer.id, source: 'reprint' })
  if (blocked) throw conflict(blocked.reason ?? 'Print blocked by a plugin')
  printDispatcher.assertNoActiveDispatchForPrinter(printer.id)
  const trackedJobId = await startTrackedPrintJob({
    printerId: printer.id,
    jobName,
    fileName: path.basename(filePath),
    metadata: {
      jobKind: 'file',
      jobId: null,
      printerFilePath: filePath,
      fileId: null,
      fileName: path.basename(filePath),
      fileSizeBytes: null,
      sourceKind,
      plate: parsed.data.plate,
      useAms: parsed.data.useAms,
      bedLevel: normalizedOptions.bedLevel !== 'off',
      amsMapping: parsed.data.amsMapping ?? null,
      calibrationOption: null
    },
    publish: () => printerManager.publishCommand(printer.id, {
      print: buildProjectFilePrintCommand({
        remoteName,
        param: printParam,
        subtaskName: jobName,
        submissionId,
        bedLevel: normalizedOptions.bedLevel,
        flowCalibration: normalizedOptions.flowCalibration,
        vibrationCompensation: normalizedOptions.vibrationCompensation,
        firstLayerInspection: normalizedOptions.firstLayerInspection,
        filamentDynamicsCalibration: normalizedOptions.filamentDynamicsCalibration,
        nozzleOffsetCalibration: normalizedOptions.nozzleOffsetCalibration,
        timelapse: normalizedOptions.timelapse,
        useAms: parsed.data.useAms,
        amsMapping: parsed.data.amsMapping
      })
    })
  })
  if (!trackedJobId) throw badRequest('Printer is not connected — command was not delivered')
  annotateRequestAuditLog(request, {
    action: 'start-printer-storage-print',
    resource: 'print job',
    summary: `Started print from printer storage on ${printer.name}.`,
    metadata: {
      printerId: printer.id,
      printerName: printer.name,
      path: filePath,
      fileName: path.basename(filePath),
      plate: parsed.data.plate,
      jobId: trackedJobId
    }
  })
  response.status(202).json({ path: filePath })
})

function resolveRequestedPrinterStoragePlateName(
  index: Awaited<ReturnType<typeof readPrinterStorageThreeMfIndex>> | null,
  plate: number
): string | null {
  const name = index?.plates.find((entry) => entry.index === plate)?.name?.trim()
  return name || null
}

export function resolvePrinterStorageJobName(
  fileName: string,
  sourceKind: '3mf' | 'gcode',
  plate: number,
  index: Awaited<ReturnType<typeof readPrinterStorageThreeMfIndex>> | null
): string {
  const fallbackJobName = fileName.replace(/\.gcode\.3mf$/i, '').replace(/\.(3mf|gcode)$/i, '').replace(/^.*\//, '')
  if (sourceKind !== '3mf') return fallbackJobName

  const isMultiPlate = (index?.plates.length ?? 0) > 1
  // A single-plate 3MF already names one plate; reuse the file's own name so the job
  // label does not duplicate the plate (e.g. a sliced "Best Shot Golf - Plate 4").
  if (!isMultiPlate) return fallbackJobName

  const plateName = resolveRequestedPrinterStoragePlateName(index, plate)
  return plateName
    ? getRemotePrintTarget(path.basename(fileName), sourceKind, plate, plateName, { isMultiPlate }).subtaskName
    : fallbackJobName
}

