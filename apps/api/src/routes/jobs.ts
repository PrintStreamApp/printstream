/**
 * Print-job archive. Rows are inserted by the printer manager when it
 * observes job lifecycle transitions.
 */
import { Router } from 'express'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import {
  type AuditLogEntry,
  JOBS_DELETE_PERMISSION,
  JOBS_VIEW_PERMISSION,
  PRINTS_DISPATCH_PERMISSION,
  printFromLibrarySchema,
  PRINTERS_CONTROL_CALIBRATE_SCOPE
} from '@printstream/shared'
import { annotateRequestAuditLog } from '../lib/audit-logs.js'
import { getRelatedAuditLogsForPrintJobs } from '../lib/audit-logs.js'
import { prisma } from '../lib/prisma.js'
import { badRequest, conflict, notFound } from '../lib/http-error.js'
import { readLibraryProjectFilamentChips } from '../lib/library-three-mf.js'
import { deletePrintJobThumbnail } from '../lib/print-job-thumbnails.js'
import { readPrintJobThumbnail } from '../lib/print-job-thumbnails.js'
import { deletePrintJobSnapshot } from '../lib/print-job-snapshots.js'
import { readPrintJobSnapshot } from '../lib/print-job-snapshots.js'
import { printerManager } from '../lib/printer-manager.js'
import { printGuards } from '../lib/print-guards.js'
import { startCalibrationJob } from '../lib/calibration-jobs.js'
import { assertRequestPermission, requireRequestPermission } from '../lib/authorization.js'
import { requireRequestTenantId, requireRouteParam } from '../lib/request-helpers.js'
import { broadcastJobsChanged, broadcastPrintDispatchChanged } from '../lib/ws-resource-events.js'
import { enqueueLibraryPrint } from '../lib/library-printing.js'

export const jobsRouter = Router()
const reprintJobSchema = printFromLibrarySchema
  .omit({ fileId: true, printerId: true })
  .partial()
  .extend({
    printerId: z.string().trim().min(1).optional()
  })

interface JobRowBase {
  id: string
  printerId: string
  jobName: string
  startedAt: Date
  finishedAt: Date | null
  progressPercent: number | null
  durationSeconds: number | null
  result: string
  fileId: string | null
  fileName: string | null
  fileSizeBytes: number | null
  plate: number | null
  useAms: boolean | null
  bedLevel: boolean | null
  amsMapping: string | null
  thumbnailPath: string | null
}

interface LegacyJobRow extends JobRowBase {
  printerName: string
}

interface ModernJobRow extends JobRowBase {
  sourceType: string | null
  calibrationOption: number | null
  snapshotPath: string | null
  printer: { name: string }
  file: {
    sizeBytes: number
    ownerBridgeId: string | null
    storedPath: string
    kind: string
  } | null
}

jobsRouter.get('/:id/thumbnail', requireRequestPermission(JOBS_VIEW_PERMISSION), async (request, response) => {
  const jobId = requireRouteParam(request.params.id, 'Job id')
  const tenantId = requireRequestTenantId(request)
  const row = await prisma.printJob.findFirst({
    where: {
      id: jobId,
      printer: { tenantId }
    },
    select: {
      fileId: true,
      plate: true,
      thumbnailPath: true
    }
  })
  if (!row) throw notFound('Job not found')

  if (row.thumbnailPath) {
    const png = await readPrintJobThumbnail(row.thumbnailPath)
    if (png) {
      response.setHeader('Content-Type', 'image/png')
      response.setHeader('Cache-Control', 'private, max-age=300')
      response.send(png)
      return
    }
  }

  if (row.fileId) {
    response.redirect(307, `/api/library/${encodeURIComponent(row.fileId)}/thumbnail?plate=${row.plate ?? 1}`)
    return
  }

  throw notFound('Thumbnail missing')
})

jobsRouter.get('/:id/snapshot', requireRequestPermission(JOBS_VIEW_PERMISSION), async (request, response) => {
  const jobId = requireRouteParam(request.params.id, 'Job id')
  const tenantId = requireRequestTenantId(request)
  const row = await prisma.printJob.findFirst({
    where: {
      id: jobId,
      printer: { tenantId }
    },
    select: { snapshotPath: true }
  })
  if (!row) throw notFound('Job not found')
  if (!row.snapshotPath) throw notFound('Snapshot missing')

  const image = await readPrintJobSnapshot(row.snapshotPath)
  if (!image) throw notFound('Snapshot missing')

  response.setHeader('Content-Type', 'image/jpeg')
  response.setHeader('Cache-Control', 'private, max-age=300')
  response.send(image)
})

jobsRouter.get('/', requireRequestPermission(JOBS_VIEW_PERMISSION), async (request, response) => {
  const printerId = typeof request.query.printerId === 'string' ? request.query.printerId : undefined
  const tenantId = requireRequestTenantId(request)
  const rows = await listJobs(tenantId, printerId)
  const activityByJobId = await getRelatedAuditLogsForPrintJobs(rows.map((row) => ({
    id: row.id,
    printerId: row.printerId,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt
  })), tenantId)
  response.json({
    jobs: await Promise.all(rows.map(async (row) => await toPrintJobDto(row, activityByJobId.get(row.id) ?? [])))
  })
})

jobsRouter.delete('/:id', requireRequestPermission(JOBS_DELETE_PERMISSION), async (request, response) => {
  const jobId = requireRouteParam(request.params.id, 'Job id')
  const tenantId = requireRequestTenantId(request)
  const row = await prisma.printJob.findFirst({
    where: {
      id: jobId,
      printer: { tenantId }
    },
    select: {
      id: true,
      finishedAt: true,
      thumbnailPath: true,
      snapshotPath: true
    }
  })
  if (!row) throw notFound('Job not found')
  if (!row.finishedAt) throw badRequest('Only finished jobs can be deleted from history')

  await prisma.printJob.delete({ where: { id: row.id } })
  await Promise.all([
    row.thumbnailPath ? deletePrintJobThumbnail(row.thumbnailPath) : Promise.resolve(),
    row.snapshotPath ? deletePrintJobSnapshot(row.snapshotPath) : Promise.resolve()
  ])
  broadcastJobsChanged(tenantId)
  response.status(204).end()
})

jobsRouter.post('/:id/reprint', async (request, response) => {
  const jobId = requireRouteParam(request.params.id, 'Job id')
  const tenantId = requireRequestTenantId(request)
  const parsed = reprintJobSchema.safeParse(request.body ?? {})
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid re-print payload')
  }

  const row = await prisma.printJob.findFirst({
    where: {
      id: jobId,
      printer: { tenantId }
    },
    include: { printer: true }
  })
  if (!row) throw notFound('Job not found')
  if (!row.finishedAt) throw badRequest('Only finished jobs can be restarted from history')

  const jobKind = toPrintJobKind(row.sourceType, row.fileId)

  if (jobKind === 'calibration') {
    assertRequestPermission(request, PRINTERS_CONTROL_CALIBRATE_SCOPE)
    if (row.calibrationOption == null) throw badRequest('Calibration details are missing for this job')

    const targetPrinterId = parsed.data.printerId ?? row.printerId
    const printer = await prisma.printer.findFirst({ where: { id: targetPrinterId, tenantId } })
    if (!printer) throw notFound('Printer not found')
    if (!printerManager.getPrinter(printer.id)) throw badRequest('Printer is not connected — command was not delivered')

    const blocked = printGuards.evaluate({ printerId: printer.id, source: 'calibration' })
    if (blocked) throw conflict(blocked.reason ?? 'Calibration blocked by a plugin')

    const started = await startCalibrationJob({
      printerId: printer.id,
      printerName: printer.name,
      option: row.calibrationOption
    })
    if (!started) throw badRequest('Printer is not connected — command was not delivered')

    annotateRequestAuditLog(request, {
      action: 'restart-print-job',
      resource: 'print job',
      summary: `Restarted calibration on ${printer.name}.`,
      metadata: {
        jobId: started,
        previousJobId: row.id,
        printerId: printer.id,
        printerName: printer.name,
        jobKind
      }
    })
    response.status(202).end()
    return
  }

  if (jobKind === 'file') {
    assertRequestPermission(request, PRINTS_DISPATCH_PERMISSION)
    if (!row.fileId) throw badRequest('File details are missing for this job')

    const targetPrinterId = parsed.data.printerId ?? row.printerId
    const restartOptions = printFromLibrarySchema.omit({ fileId: true }).parse({
      printerId: targetPrinterId,
      useAms: parsed.data.useAms ?? row.useAms ?? true,
      bedLevel: parsed.data.bedLevel ?? (row.bedLevel === false ? 'off' : 'on'),
      vibrationCompensation: parsed.data.vibrationCompensation,
      flowCalibration: parsed.data.flowCalibration,
      firstLayerInspection: parsed.data.firstLayerInspection,
      timelapse: parsed.data.timelapse,
      filamentDynamicsCalibration: parsed.data.filamentDynamicsCalibration,
      nozzleOffsetCalibration: parsed.data.nozzleOffsetCalibration,
      allowIncompatibleFilament: parsed.data.allowIncompatibleFilament,
      allowPlateTypeMismatch: parsed.data.allowPlateTypeMismatch,
      currentPlateType: parsed.data.currentPlateType,
      currentNozzleDiameters: parsed.data.currentNozzleDiameters,
      plate: parsed.data.plate ?? row.plate ?? 1,
      amsMapping: parsed.data.amsMapping ?? parseAmsMapping(row.amsMapping)
    })

    const job = await enqueueLibraryPrint({
      fileId: row.fileId,
      ...restartOptions
    }, tenantId)
    annotateRequestAuditLog(request, {
      action: 'restart-print-job',
      resource: 'print job',
      summary: `Queued restart of ${job.fileName} on ${job.printerName}.`,
      metadata: {
        jobId: job.id,
        previousJobId: row.id,
        printerId: job.printerId,
        printerName: job.printerName,
        fileId: job.fileId,
        fileName: job.fileName,
        plate: job.plate,
        jobKind
      }
    })
    broadcastPrintDispatchChanged(tenantId)
    response.status(202).json({ job })
    return
  }

  throw badRequest('Externally started jobs cannot be restarted from history')
})

function parseAmsMapping(value: string | null): number[] | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every((entry) => Number.isInteger(entry)) ? parsed : null
  } catch {
    return null
  }
}

async function listJobs(tenantId: string, printerId: string | undefined): Promise<Array<ModernJobRow | LegacyJobRow>> {
  try {
    return await prisma.printJob.findMany({
      where: {
        printer: { tenantId },
        ...(printerId ? { printerId } : {})
      },
      select: {
        id: true,
        printerId: true,
        jobName: true,
        sourceType: true,
        calibrationOption: true,
        fileId: true,
        fileName: true,
        fileSizeBytes: true,
        plate: true,
        useAms: true,
        bedLevel: true,
        amsMapping: true,
        progressPercent: true,
        startedAt: true,
        finishedAt: true,
        durationSeconds: true,
        result: true,
        thumbnailPath: true,
        snapshotPath: true,
        printer: {
          select: {
            name: true
          }
        },
        file: {
          select: {
            sizeBytes: true,
            ownerBridgeId: true,
            storedPath: true,
            kind: true
          }
        }
      },
      orderBy: [
        { finishedAt: 'desc' },
        { startedAt: 'desc' }
      ],
      take: 100
    })
  } catch (error) {
    if (!isMissingPrintJobHistoryColumnsError(error)) throw error
    console.warn('Falling back to legacy jobs query; newer PrintJob columns are missing')
    return await listJobsLegacy(tenantId, printerId)
  }
}

type PrintJobRow = Awaited<ReturnType<typeof listJobs>>[number]

async function toPrintJobDto(row: PrintJobRow, activity: AuditLogEntry[]) {
  const jobKind = toPrintJobKind('sourceType' in row ? row.sourceType : 'library', row.fileId)
  const projectFilamentChips = await resolveJobProjectFilamentChips(row)
  return {
    id: row.id,
    printerId: row.printerId,
    printerName: 'printer' in row ? row.printer.name : row.printerName,
    jobName: row.jobName,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    progressPercent: row.progressPercent,
    durationSeconds: row.durationSeconds,
    result: row.result,
    fileId: row.fileId,
    fileName: row.fileName,
    fileSizeBytes: 'file' in row ? row.fileSizeBytes ?? row.file?.sizeBytes ?? null : row.fileSizeBytes,
    projectFilamentChips,
    plate: row.plate,
    useAms: row.useAms,
    bedLevel: row.bedLevel,
    amsMapping: parseAmsMapping(row.amsMapping),
    jobKind,
    calibrationOption: 'calibrationOption' in row ? row.calibrationOption : null,
    activity,
    thumbnailPath: row.thumbnailPath,
    snapshotPath: 'snapshotPath' in row ? row.snapshotPath : null
  }
}

async function resolveJobProjectFilamentChips(row: PrintJobRow) {
  if (!('file' in row) || !row.file) return []
  try {
    return await readLibraryProjectFilamentChips({
      ownerBridgeId: row.file.ownerBridgeId,
      storedPath: row.file.storedPath,
      kind: row.file.kind
    })
  } catch {
    return []
  }
}

function toPrintJobKind(sourceType: string | null | undefined, fileId: string | null): 'file' | 'calibration' | 'external' {
  if (sourceType === 'calibration') return 'calibration'
  if (sourceType === 'external') return 'external'
  return fileId ? 'file' : 'external'
}

function isMissingPrintJobHistoryColumnsError(error: unknown): boolean {
  return typeof error === 'object'
    && error != null
    && 'code' in error
    && (error as { code?: unknown }).code === 'P2022'
}

async function listJobsLegacy(tenantId: string, printerId: string | undefined): Promise<LegacyJobRow[]> {
  const printerFilter = printerId
    ? Prisma.sql`AND job."printerId" = ${printerId}`
    : Prisma.empty

  return await prisma.$queryRaw<LegacyJobRow[]>(Prisma.sql`
    SELECT
      job."id" AS "id",
      job."printerId" AS "printerId",
      printer."name" AS "printerName",
      job."jobName" AS "jobName",
      job."startedAt" AS "startedAt",
      job."finishedAt" AS "finishedAt",
      job."progressPercent" AS "progressPercent",
      job."durationSeconds" AS "durationSeconds",
      job."result" AS "result",
      job."fileId" AS "fileId",
      job."fileName" AS "fileName",
      COALESCE(job."fileSizeBytes", file."sizeBytes") AS "fileSizeBytes",
      job."plate" AS "plate",
      job."useAms" AS "useAms",
      job."bedLevel" AS "bedLevel",
      job."amsMapping" AS "amsMapping",
      job."thumbnailPath" AS "thumbnailPath"
    FROM "PrintJob" job
    INNER JOIN "Printer" printer ON printer."id" = job."printerId"
    LEFT JOIN "LibraryFile" file ON file."id" = job."fileId"
    WHERE 1 = 1
    AND printer."tenantId" = ${tenantId}
    ${printerFilter}
    ORDER BY job."finishedAt" DESC NULLS FIRST, job."startedAt" DESC
    LIMIT 100
  `)
}
