/**
 * Reprint a library file already present on the printer SD card.
 *
 * This late file-id route validates the original print choice, applies current printer guardrails,
 * sends the native project_file command, and records both the job and accepted safety overrides.
 */
import type { Router } from 'express'
import {
  getPrinterPrintStartOptions,
  isDirectPrintableFileName,
  PRINTS_DISPATCH_PERMISSION,
  printerModelHasDualNozzles,
  printFromLibrarySchema,
  printStartOptionSelectionSchema,
  type LibraryFile,
  type PrinterStatus
} from '@printstream/shared'
import type { ThreeMfIndex as ParsedThreeMfIndex } from '../lib/three-mf.js'
import { annotateRequestAuditLog, printOverrideAuditMetadata } from '../lib/audit-logs.js'
import { requireRequestPermission } from '../lib/authorization.js'
import { badRequest, conflict, notFound } from '../lib/http-error.js'
import { requireWorkspaceOwnedConnectedPrinter } from '../lib/printer-access.js'
import {
  buildProjectFilePrintCommand,
  getPrintSourceKind,
  getRemotePrintTarget,
  normalizePrintStartOptionsForPrinter,
  printDispatcher
} from '../lib/print-dispatcher.js'
import { assertLibraryPrintCompatibilityForIndex } from '../lib/print-filament-compatibility.js'
import { printGuards } from '../lib/print-guards.js'
import { startTrackedPrintJob } from '../lib/print-job-recorder.js'
import { printerManager } from '../lib/printer-manager.js'
import { prisma } from '../lib/prisma.js'
import { requireRequestWorkspaceId, requireRouteParam } from '../lib/request-helpers.js'

function resolvePrinterFirstLayerInspectionDefault(
  model: LibraryFile['compatiblePrinterModels'][number],
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

/** Register the SD-card reprint route after static library route families. */
export function registerLibraryReprintRoute(
  router: Router,
  readLibraryThreeMfIndex: (row: { ownerBridgeId?: string | null; storedPath: string }) => Promise<ParsedThreeMfIndex>
): void {
  router.post('/:id/reprint', requireRequestPermission(PRINTS_DISPATCH_PERMISSION), async (request, response) => {
    const fileId = requireRouteParam(request.params.id, 'File id')
    const parsed = printFromLibrarySchema.omit({ fileId: true }).pick({
      printerId: true,
      useAms: true,
      bedLevel: true,
      vibrationCompensation: true,
      flowCalibration: true,
      firstLayerInspection: true,
      timelapse: true,
      timelapseStorage: true,
      externalFilamentChangeAssist: true,
      filamentDynamicsCalibration: true,
      nozzleOffsetCalibration: true,
      allowIncompatibleFilament: true,
      allowPlateTypeMismatch: true,
      allowPrinterModelMismatch: true,
      allowFilamentTrackSwitchMismatch: true,
      allowInsufficientFilament: true,
      allowBlacklistedFilament: true,
      currentPlateType: true,
      currentNozzleDiameters: true,
      plate: true,
      amsMapping: true
    }).safeParse(request.body)
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid re-print payload')
    }
    const file = await prisma.libraryFile.findUnique({ where: { id: fileId } })
    if (!file) throw notFound('File not found')
    // Resolve the target printer through the workspace gate: getPrinter() alone is keyed by
    // id only, which would let a workspace start a print on another workspace's printer.
    const printer = await requireWorkspaceOwnedConnectedPrinter(parsed.data.printerId)

    if (!isDirectPrintableFileName(file.name)) {
      throw badRequest('Only .gcode or .gcode.3mf files can be printed directly')
    }
    const blocked = printGuards.evaluate({ printerId: printer.id, source: 'reprint' })
    if (blocked) throw conflict(blocked.reason ?? 'Print blocked by a plugin')
    printDispatcher.assertNoActiveDispatchForPrinter(printer.id)

    const sourceKind = getPrintSourceKind(file.name)
    let index: ParsedThreeMfIndex | null = null
    if (sourceKind === '3mf') {
      try {
        index = await readLibraryThreeMfIndex(file)
      } catch {
        throw notFound('File missing on bridge')
      }

      await assertLibraryPrintCompatibilityForIndex(index, {
        workspaceId: requireRequestWorkspaceId(request),
        printerId: printer.id,
        plate: parsed.data.plate,
        printerModel: printer.model,
        printerStatus: printerManager.getStatus(printer.id),
        amsMapping: parsed.data.amsMapping,
        allowIncompatibleFilament: parsed.data.allowIncompatibleFilament,
        allowPlateTypeMismatch: parsed.data.allowPlateTypeMismatch,
        allowPrinterModelMismatch: parsed.data.allowPrinterModelMismatch,
        allowFilamentTrackSwitchMismatch: parsed.data.allowFilamentTrackSwitchMismatch,
        allowInsufficientFilament: parsed.data.allowInsufficientFilament,
        allowBlacklistedFilament: parsed.data.allowBlacklistedFilament,
        currentPlateType: parsed.data.currentPlateType,
        currentNozzleDiameters: parsed.data.currentNozzleDiameters
      })
    }

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
    const plateName = resolveRequestedPlateName(file.name, index, parsed.data.plate)
    const target = getRemotePrintTarget(file.name, getPrintSourceKind(file.name), parsed.data.plate, plateName, {
      isMultiPlate: index ? index.plates.length > 1 : true
    })
    const submissionId = String((Date.now() % 2_147_483_647) || 1)
    const printPayload = buildProjectFilePrintCommand({
      remoteName: target.remoteName,
      param: target.param,
      subtaskName: target.subtaskName,
      submissionId,
      bedLevel: normalizedOptions.bedLevel,
      flowCalibration: normalizedOptions.flowCalibration,
      vibrationCompensation: normalizedOptions.vibrationCompensation,
      firstLayerInspection: normalizedOptions.firstLayerInspection,
      filamentDynamicsCalibration: normalizedOptions.filamentDynamicsCalibration,
      nozzleOffsetCalibration: normalizedOptions.nozzleOffsetCalibration,
      timelapse: normalizedOptions.timelapse,
      timelapseStorage: normalizedOptions.timelapseStorage,
      externalFilamentChangeAssist: normalizedOptions.externalFilamentChangeAssist,
      useAms: parsed.data.useAms,
      amsMapping: parsed.data.amsMapping,
      dualNozzles: printerModelHasDualNozzles(printer.model)
    })
    const trackedJobId = await startTrackedPrintJob({
      printerId: printer.id,
      jobName: target.subtaskName,
      fileName: file.name,
      metadata: {
        jobKind: 'file',
        jobId: null,
        printerFilePath: `/${target.remoteName}`,
        fileId: file.id,
        fileName: file.name,
        fileSizeBytes: file.sizeBytes,
        sourceKind: getPrintSourceKind(file.name),
        plate: parsed.data.plate,
        useAms: parsed.data.useAms,
        bedLevel: normalizedOptions.bedLevel !== 'off',
        amsMapping: parsed.data.amsMapping ?? null,
        // The user's selection, not `normalizedOptions`. See `print-job-options.ts`.
        printOptions: printStartOptionSelectionSchema.parse(parsed.data),
        calibrationOption: null
      },
      publish: () => printerManager.publishCommand(printer.id, { print: printPayload })
    })
    if (!trackedJobId) throw badRequest('Printer is not connected: command was not delivered')
    annotateRequestAuditLog(request, {
      action: 'reprint-print',
      resource: 'print job',
      summary: `Started reprint of ${file.name} on ${printer.name}.`,
      metadata: {
        printerId: printer.id,
        printerName: printer.name,
        fileId: file.id,
        fileName: file.name,
        plate: parsed.data.plate,
        jobId: trackedJobId,
        // Which safety gates this dispatch deliberately bypassed, when any.
        ...printOverrideAuditMetadata(parsed.data)
      }
    })
    response.status(202).end()
  })
}

function resolveRequestedPlateName(fileName: string, index: ParsedThreeMfIndex | null, plate: number): string | null {
  if (getPrintSourceKind(fileName) !== '3mf') return null
  return index?.plates.find((entry) => entry.index === plate)?.name?.trim() || null
}
