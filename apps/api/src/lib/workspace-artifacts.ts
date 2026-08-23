/**
 * Delete a workspace's stored file bytes before the workspace row (and its cascading
 * children) are removed.
 *
 * Workspace deletion relies on Prisma `onDelete: Cascade` to drop the DB rows, but
 * the actual bytes those rows point at, library files (and versions) on the
 * bridge, plus print-job thumbnails/snapshots on disk, are not in the database
 * and would otherwise be orphaned forever (a data-retention/GDPR gap and a slow
 * disk leak). This enumerates them while the rows still exist and removes the
 * bytes, then detaches the workspace's printers from the in-process manager so their
 * MQTT/bridge state is torn down.
 *
 * Best-effort: every byte delete is isolated so one failure (e.g. an offline
 * bridge) is logged but never blocks the workspace deletion. Call this BEFORE
 * `prisma.workspace.delete`: afterwards the rows are gone and cannot be enumerated.
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

export interface WorkspaceArtifactDeps {
  loadLibraryFiles: (workspaceId: string) => Promise<LibraryFileBytes[]>
  loadPrintJobArtifacts: (workspaceId: string) => Promise<PrintJobArtifact[]>
  loadPrinterIds: (workspaceId: string) => Promise<string[]>
  deleteLibraryFileBytes: (input: { ownerBridgeId?: string | null; storedPath: string }) => Promise<void>
  deletePrintJobThumbnail: (storedPath: string) => Promise<void>
  deletePrintJobSnapshot: (storedPath: string) => Promise<void>
  removePrinter: (printerId: string) => void
  log: (message: string, error?: unknown) => void
}

const defaultDeps: WorkspaceArtifactDeps = {
  loadLibraryFiles: (workspaceId) => rootPrisma.libraryFile.findMany({
    where: { workspaceId },
    select: {
      id: true,
      ownerBridgeId: true,
      storedPath: true,
      versions: { select: { ownerBridgeId: true, storedPath: true } }
    }
  }),
  loadPrintJobArtifacts: (workspaceId) => rootPrisma.printJob.findMany({
    where: { workspaceId, OR: [{ thumbnailPath: { not: null } }, { snapshotPath: { not: null } }] },
    select: { id: true, thumbnailPath: true, snapshotPath: true }
  }),
  loadPrinterIds: (workspaceId) => rootPrisma.printer
    .findMany({ where: { workspaceId }, select: { id: true } })
    .then((rows) => rows.map((row) => row.id)),
  deleteLibraryFileBytes,
  deletePrintJobThumbnail,
  deletePrintJobSnapshot,
  removePrinter: (printerId) => printerManager.remove(printerId),
  log: (message, error) => console.warn(message, error instanceof Error ? error.message : (error ?? ''))
}

export interface WorkspaceArtifactCleanupResult {
  libraryFiles: number
  printJobArtifacts: number
  printers: number
}

export async function deleteWorkspaceArtifactBytes(
  workspaceId: string,
  deps: WorkspaceArtifactDeps = defaultDeps
): Promise<WorkspaceArtifactCleanupResult> {
  const libraryFiles = await deps.loadLibraryFiles(workspaceId)
  for (const file of libraryFiles) {
    await deps.deleteLibraryFileBytes(file).catch((error) =>
      deps.log(`[workspace-delete] failed to delete library bytes for ${file.id}`, error))
    for (const version of file.versions) {
      await deps.deleteLibraryFileBytes(version).catch((error) =>
        deps.log(`[workspace-delete] failed to delete library version bytes for ${file.id}`, error))
    }
  }

  const printJobs = await deps.loadPrintJobArtifacts(workspaceId)
  let printJobArtifacts = 0
  for (const job of printJobs) {
    if (job.thumbnailPath) {
      await deps.deletePrintJobThumbnail(job.thumbnailPath).catch((error) =>
        deps.log(`[workspace-delete] failed to delete thumbnail for job ${job.id}`, error))
      printJobArtifacts += 1
    }
    if (job.snapshotPath) {
      await deps.deletePrintJobSnapshot(job.snapshotPath).catch((error) =>
        deps.log(`[workspace-delete] failed to delete snapshot for job ${job.id}`, error))
      printJobArtifacts += 1
    }
  }

  const printerIds = await deps.loadPrinterIds(workspaceId)
  for (const printerId of printerIds) {
    try {
      deps.removePrinter(printerId)
    } catch (error) {
      deps.log(`[workspace-delete] failed to detach printer ${printerId}`, error)
    }
  }

  return { libraryFiles: libraryFiles.length, printJobArtifacts, printers: printerIds.length }
}
