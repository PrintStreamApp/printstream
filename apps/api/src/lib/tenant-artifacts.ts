/**
 * Delete a tenant's stored file bytes before the tenant row (and its cascading
 * children) are removed.
 *
 * Tenant deletion relies on Prisma `onDelete: Cascade` to drop the DB rows, but
 * the actual bytes those rows point at — library files (and versions) on the
 * bridge, plus print-job thumbnails/snapshots on disk — are not in the database
 * and would otherwise be orphaned forever (a data-retention/GDPR gap and a slow
 * disk leak). This enumerates them while the rows still exist and removes the
 * bytes, then detaches the tenant's printers from the in-process manager so their
 * MQTT/bridge state is torn down.
 *
 * Best-effort: every byte delete is isolated so one failure (e.g. an offline
 * bridge) is logged but never blocks the tenant deletion. Call this BEFORE
 * `prisma.tenant.delete` — afterwards the rows are gone and cannot be enumerated.
 */
import { deleteLibraryFileBytes } from './bridge-library-files.js'
import { deletePrintJobSnapshot } from './print-job-snapshots.js'
import { deletePrintJobThumbnail } from './print-job-thumbnails.js'
import { printerManager } from './printer-manager.js'
import { rootPrisma } from './prisma.js'

interface LibraryFileBytes {
  id: string
  ownerBridgeId: string | null
  storedPath: string
  versions: Array<{ ownerBridgeId: string | null; storedPath: string }>
}

interface PrintJobArtifact {
  id: string
  thumbnailPath: string | null
  snapshotPath: string | null
}

export interface TenantArtifactDeps {
  loadLibraryFiles: (tenantId: string) => Promise<LibraryFileBytes[]>
  loadPrintJobArtifacts: (tenantId: string) => Promise<PrintJobArtifact[]>
  loadPrinterIds: (tenantId: string) => Promise<string[]>
  deleteLibraryFileBytes: (input: { ownerBridgeId?: string | null; storedPath: string }) => Promise<void>
  deletePrintJobThumbnail: (storedPath: string) => Promise<void>
  deletePrintJobSnapshot: (storedPath: string) => Promise<void>
  removePrinter: (printerId: string) => void
  log: (message: string, error?: unknown) => void
}

const defaultDeps: TenantArtifactDeps = {
  loadLibraryFiles: (tenantId) => rootPrisma.libraryFile.findMany({
    where: { tenantId },
    select: {
      id: true,
      ownerBridgeId: true,
      storedPath: true,
      versions: { select: { ownerBridgeId: true, storedPath: true } }
    }
  }),
  loadPrintJobArtifacts: (tenantId) => rootPrisma.printJob.findMany({
    where: { tenantId, OR: [{ thumbnailPath: { not: null } }, { snapshotPath: { not: null } }] },
    select: { id: true, thumbnailPath: true, snapshotPath: true }
  }),
  loadPrinterIds: (tenantId) => rootPrisma.printer
    .findMany({ where: { tenantId }, select: { id: true } })
    .then((rows) => rows.map((row) => row.id)),
  deleteLibraryFileBytes,
  deletePrintJobThumbnail,
  deletePrintJobSnapshot,
  removePrinter: (printerId) => printerManager.remove(printerId),
  log: (message, error) => console.warn(message, error instanceof Error ? error.message : (error ?? ''))
}

export interface TenantArtifactCleanupResult {
  libraryFiles: number
  printJobArtifacts: number
  printers: number
}

export async function deleteTenantArtifactBytes(
  tenantId: string,
  deps: TenantArtifactDeps = defaultDeps
): Promise<TenantArtifactCleanupResult> {
  const libraryFiles = await deps.loadLibraryFiles(tenantId)
  for (const file of libraryFiles) {
    await deps.deleteLibraryFileBytes(file).catch((error) =>
      deps.log(`[tenant-delete] failed to delete library bytes for ${file.id}`, error))
    for (const version of file.versions) {
      await deps.deleteLibraryFileBytes(version).catch((error) =>
        deps.log(`[tenant-delete] failed to delete library version bytes for ${file.id}`, error))
    }
  }

  const printJobs = await deps.loadPrintJobArtifacts(tenantId)
  let printJobArtifacts = 0
  for (const job of printJobs) {
    if (job.thumbnailPath) {
      await deps.deletePrintJobThumbnail(job.thumbnailPath).catch((error) =>
        deps.log(`[tenant-delete] failed to delete thumbnail for job ${job.id}`, error))
      printJobArtifacts += 1
    }
    if (job.snapshotPath) {
      await deps.deletePrintJobSnapshot(job.snapshotPath).catch((error) =>
        deps.log(`[tenant-delete] failed to delete snapshot for job ${job.id}`, error))
      printJobArtifacts += 1
    }
  }

  const printerIds = await deps.loadPrinterIds(tenantId)
  for (const printerId of printerIds) {
    try {
      deps.removePrinter(printerId)
    } catch (error) {
      deps.log(`[tenant-delete] failed to detach printer ${printerId}`, error)
    }
  }

  return { libraryFiles: libraryFiles.length, printJobArtifacts, printers: printerIds.length }
}
