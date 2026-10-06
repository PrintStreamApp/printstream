/**
 * Dispatch a file already on printer storage and preserve its print intent.
 *
 * The route owns compatibility checks, object-skip resolution, plugin guards, job recording,
 * post-start skip arming, and audit metadata as one ordered print-start transaction. The parent
 * registers it at the original position in the printer router.
 */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Router } from 'express'
import {
  getPrinterPrintStartOptions,
  isDirectPrintableFileName,
  printerModelHasDualNozzles,
  printerStoragePrintSchema,
  printStartOptionSelectionSchema,
  PRINTS_DISPATCH_PRINTER_STORAGE_SCOPE,
  type Printer,
  type PrinterStatus
} from '@printstream/shared'
import { annotateRequestAuditLog, printOverrideAuditMetadata } from '../lib/audit-logs.js'
import { requireRequestPermission } from '../lib/authorization.js'
import { badRequest, conflict, notFound } from '../lib/http-error.js'
import { requireWorkspaceOwnedConnectedPrinter } from '../lib/printer-access.js'
import { assertAutomaticPrintCompatibility } from '../lib/print-filament-compatibility.js'
import {
  buildProjectFilePrintCommand,
  getPrintSourceKind,
  getRemotePrintTarget,
  normalizePrintStartOptionsForPrinter,
  printDispatcher
} from '../lib/print-dispatcher.js'
import { printGuards } from '../lib/print-guards.js'
import { startTrackedPrintJob } from '../lib/print-job-recorder.js'
import { printerManager } from '../lib/printer-manager.js'
import { readPrinterStorageThreeMfIndex } from '../lib/printer-storage-3mf.js'
import { armPostStartObjectSkip } from '../lib/post-start-object-skip.js'
import { requireRequestWorkspaceId, requireRouteParam } from '../lib/request-helpers.js'
import { plateSkipIdentifyIdsFromIndex } from '../lib/three-mf-output.js'
import { normalizePrinterPath } from './printer-storage-policy.js'

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

/** Register printer-storage print dispatch at its original router position. */
export function registerPrinterStoragePrintRoute(router: Router): void {
  /**
   * POST /api/printers/:id/storage/print: start a print of a file already
   * present on the printer's storage. No upload happens; we just publish
   * the `project_file` MQTT command pointing at the existing path.
   */
  router.post('/:id/storage/print', requireRequestPermission(PRINTS_DISPATCH_PRINTER_STORAGE_SCOPE), async (request, response) => {
    const printer = await requireWorkspaceOwnedConnectedPrinter(requireRouteParam(request.params.id, 'Printer id'))
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
      try {
        await assertAutomaticPrintCompatibility({
          workspaceId: requireRequestWorkspaceId(request),
          printerId: printer.id,
          index: storageThreeMfIndex,
          plate: parsed.data.plate,
          printerModel: printer.model,
          printerStatus: printerManager.getStatus(printer.id),
          useAms: parsed.data.useAms,
          amsMapping: parsed.data.amsMapping,
          allowIncompatibleFilament: parsed.data.allowIncompatibleFilament,
          allowFilamentTrackSwitchMismatch: parsed.data.allowFilamentTrackSwitchMismatch,
          allowPrinterModelMismatch: parsed.data.allowPrinterModelMismatch,
          allowInsufficientFilament: parsed.data.allowInsufficientFilament,
          allowBlacklistedFilament: parsed.data.allowBlacklistedFilament
        })
      } catch (error) {
        // Mirror the library-print pre-flight logging: a rejection here starts no
        // job, so this warn is the only server-side trace of why the print never
        // began (self-hosted operators diagnose via docker logs).
        console.warn(
          `[dispatch] storage-print pre-flight rejected for printer ${printer.id} (${filePath}): ${(error as Error).message}`
        )
        throw error
      }
    }

    // Resolve deselected objects to the instance identify_ids the firmware skips on,
    // through the same (cached) plates index the storage plates route serves: the ids the
    // client selected against. Fail-loud like the library dispatcher: the user explicitly
    // deselected objects, so printing them anyway would violate intent.
    const skipIdentifyIds = resolveStorageSkipIdentifyIds(
      sourceKind,
      storageThreeMfIndex,
      parsed.data.plate,
      parsed.data.skipObjects,
      parsed.data.skipInstances
    )

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
    // honor plugin print guards (e.g. plate-clearing) like dispatch and reprint do,
    // otherwise this route is a hole that prints onto an uncleared plate.
    const blocked = printGuards.evaluate({ printerId: printer.id, source: 'reprint' })
    if (blocked) throw conflict(blocked.reason ?? 'Print blocked by a plugin')
    printDispatcher.assertNoActiveDispatchForPrinter(printer.id)
    // Pre-generate the tracked job id so the post-start skip fallback can be armed
    // BEFORE the start command publishes (a fast printer status cannot slip through the
    // gap) with the same strong job-id match the dispatcher uses: `print-job.started`
    // reports this exact id once the recorder confirms the job running.
    const jobId = randomUUID()
    const disarmPostStartSkip = skipIdentifyIds
      ? armPostStartObjectSkip({
        printerId: printer.id,
        printerModel: printer.model,
        dispatchJobId: jobId,
        jobName,
        objectIds: skipIdentifyIds
      })
      : null
    const trackedJobId = await startTrackedPrintJob({
      jobId,
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
        // The user's selection, not `normalizedOptions`. See `print-job-options.ts`.
        printOptions: printStartOptionSelectionSchema.parse(parsed.data),
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
          timelapseStorage: normalizedOptions.timelapseStorage,
          externalFilamentChangeAssist: normalizedOptions.externalFilamentChangeAssist,
          useAms: parsed.data.useAms,
          amsMapping: parsed.data.amsMapping,
          dualNozzles: printerModelHasDualNozzles(printer.model),
          skipObjects: skipIdentifyIds
        })
      })
    }).catch((error: unknown) => {
      disarmPostStartSkip?.()
      throw error
    })
    if (!trackedJobId) {
      disarmPostStartSkip?.()
      throw badRequest('Printer is not connected: command was not delivered')
    }
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
        jobId: trackedJobId,
        ...(skipIdentifyIds ? { skippedObjectCount: skipIdentifyIds.length } : {}),
        // Which safety gates this dispatch deliberately bypassed, when any.
        ...printOverrideAuditMetadata(parsed.data)
      }
    })
    response.status(202).json({ path: filePath })
  })
}

/**
 * Map a storage-print request's deselection to instance `identify_id`s via the same index the
 * route already derived. Both id spaces are honoured: `skipObjects` names whole models by the
 * storage plates index's `objects[].id` values, `skipInstances` names individual placements by
 * `identify_id` (what the picker sends, so one of eight copies can be skipped). NOT
 * fail-safe-passthrough: an unresolvable selection (non-3MF source, unreadable index, unknown
 * object id, an identify_id not on this plate, or a selection that would skip every object)
 * rejects the print with a clear message instead of printing objects the user deselected.
 * Returns null when nothing was deselected.
 */
function resolveStorageSkipIdentifyIds(
  sourceKind: '3mf' | 'gcode',
  index: Awaited<ReturnType<typeof readPrinterStorageThreeMfIndex>> | null,
  plate: number,
  skipObjects: number[] | undefined,
  skipInstances: number[] | undefined
): number[] | null {
  if ((!skipObjects || skipObjects.length === 0) && (!skipInstances || skipInstances.length === 0)) return null
  if (sourceKind !== '3mf') {
    throw badRequest('Object skipping is only available for sliced 3MF files')
  }
  if (!index) {
    throw badRequest('Could not read the file to resolve the deselected objects. Try again, or print without deselecting objects.')
  }
  const mapped = plateSkipIdentifyIdsFromIndex(index, plate, new Set(skipObjects), new Set(skipInstances))
  if (mapped.unmatchedObjectIds.length > 0 || mapped.unmatchedInstanceIds.length > 0 || mapped.identifyIds.length === 0) {
    throw badRequest('Some deselected objects could not be matched on the selected plate. Re-open the print dialog and try again.')
  }
  if (mapped.identifyIds.length >= mapped.plateInstanceCount) {
    throw badRequest('Cannot skip every object on the plate. Keep at least one object selected.')
  }
  return mapped.identifyIds
}

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
