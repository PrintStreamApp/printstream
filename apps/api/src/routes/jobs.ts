/**
 * Print-job archive routes: list/read the history, delete rows (with their
 * thumbnails/snapshots), reprint from a row, and fetch the audit logs related
 * to a job.
 *
 * This module only reads and prunes `PrintJob` rows; it never creates them.
 * Rows originate in `print-job-recorder.ts` two ways: reserved at dispatch
 * time when PrintStream itself starts a print (`startTrackedPrintJob`, called
 * from the dispatcher and the printers/library/calibration routes), and
 * created by the printer manager when it observes a job it did not dispatch
 * (an externally started print). Both paths converge on the same table, so a
 * history row may carry rich PrintStream metadata (library file, plate, AMS
 * mapping) or almost none for an external job.
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
import { isMissingColumnError } from '../lib/prisma-errors.js'
import { badRequest, notFound } from '../lib/http-error.js'
import { readLibraryProjectFilamentChips } from '../lib/library-three-mf.js'
import { deletePrintJobThumbnail } from '../lib/print-job-thumbnails.js'
import { readPrintJobThumbnail } from '../lib/print-job-thumbnails.js'
import { deletePrintJobSnapshot } from '../lib/print-job-snapshots.js'
import { readPrintJobSnapshot } from '../lib/print-job-snapshots.js'
import { assertRequestPermission, requireRequestPermission } from '../lib/authorization.js'
import { requireRequestTenantId, requireRouteParam } from '../lib/request-helpers.js'
import { broadcastJobsChanged, broadcastPrintDispatchChanged } from '../lib/ws-resource-events.js'
import { parseAmsMapping, reprintJobFromRow, toPrintJobKind } from '../lib/print-reprint.js'

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

  annotateRequestAuditLog(request, {
    action: 'delete-print-job',
    resource: 'print job',
    summary: `Deleted print job ${row.id} from history.`,
    metadata: {
      jobId: row.id
    }
  })

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

  const result = await reprintJobFromRow({
    row,
    overrides: parsed.data,
    tenantId,
    assertPermission: (kind) => {
      if (kind === 'calibration') {
        assertRequestPermission(request, PRINTERS_CONTROL_CALIBRATE_SCOPE)
        return
      }
      assertRequestPermission(request, PRINTS_DISPATCH_PERMISSION)
    }
  })

  if (result.kind === 'calibration') {
    annotateRequestAuditLog(request, {
      action: 'restart-print-job',
      resource: 'print job',
      summary: `Restarted calibration on ${result.printerName}.`,
      metadata: {
        jobId: result.jobId,
        previousJobId: row.id,
        printerId: result.printerId,
        printerName: result.printerName,
        jobKind: result.kind
      }
    })
    response.status(202).end()
    return
  }

  const job = result.job
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
      jobKind: result.kind
    }
  })
  broadcastPrintDispatchChanged(tenantId)
  response.status(202).json({ job })
})

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
    if (!isMissingColumnError(error)) throw error
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
