/**
 * Server-side delete operation queue.
 *
 * Delete requests can take time against printer FTPS storage or while
 * removing many library files. This module keeps those operations in the
 * API process so the initiating browser can disconnect while progress is
 * still tracked and exposed over the normal HTTP/WS surfaces.
 */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { DeleteOperationJob, DeleteOperationStatus, PrinterStorageDeleteEntry } from '@printstream/shared'
import { deleteLibraryFileBytes } from './bridge-library-files.js'
import { prisma } from './prisma.js'
import { printerManager } from './printer-manager.js'
import { deletePrinterDirectory, deletePrinterFile } from './printer-ftp.js'
import { clearPrinterStorageThreeMfInspectionCache } from './printer-storage-3mf.js'
import { deleteTimelapseThumbnails, isTimelapseVideoPath } from './timelapse-thumbnails.js'
import {
  broadcastDeleteOperationsChanged,
  broadcastLibraryChanged,
  broadcastPrinterStorageChanged
} from './ws-resource-events.js'

type DeleteJobKind = DeleteOperationJob['kind']
type JobRunner = (job: DeleteJobState) => Promise<void>
type ManagedPrinter = NonNullable<ReturnType<typeof printerManager.getPrinter>>

interface LibraryDeleteRow {
  id: string
  tenantId: string
  name: string
  ownerBridgeId?: string | null
  storedPath: string
  hidden: boolean
  versions?: Array<{
    ownerBridgeId?: string | null
    storedPath: string
  }>
}

interface DeleteOperationDispatcherDeps {
  now(): Date
  createId(): string
  listLibraryRows(fileIds: string[]): Promise<LibraryDeleteRow[]>
  deleteLibraryRow(fileId: string): Promise<void>
  onLibraryDeleted(hidden: boolean, tenantId: string | null): void
  getPrinter(printerId: string): ManagedPrinter | null
  deletePrinterEntry(printer: ManagedPrinter, entry: PrinterStorageDeleteEntry): Promise<void>
  clearPrinterStorageCache(printerId: string): void
  onPrinterStorageDeleted(printerId: string, tenantId: string | null): void
  onJobChanged(tenantId: string | null): void
}

interface DeleteJobState {
  id: string
  kind: DeleteJobKind
  targetName: string
  summaryLabel: string
  printerId: string | null
  tenantId: string | null
  queueKey: string
  totalItems: number
  completedItems: number
  progressPercent: number | null
  progressMessage: string
  status: DeleteOperationStatus
  error: string | null
  createdAt: Date
  updatedAt: Date
  startedAt: Date | null
  finishedAt: Date | null
  run: JobRunner
}

export class DeleteOperationDispatcher {
  private readonly jobs = new Map<string, DeleteJobState>()
  private readonly queues = new Map<string, Promise<void>>()

  constructor(private readonly deps: DeleteOperationDispatcherDeps = {
    now: () => new Date(),
    createId: () => randomUUID(),
    listLibraryRows: (fileIds) => prisma.libraryFile.findMany({
      where: { id: { in: fileIds } },
      include: {
        versions: {
          select: {
            ownerBridgeId: true,
            storedPath: true
          }
        }
      }
    }),
    deleteLibraryRow: (fileId) => prisma.libraryFile.delete({ where: { id: fileId } }).then(() => undefined),
    onLibraryDeleted: (hidden, tenantId) => {
      if (!hidden) broadcastLibraryChanged(tenantId)
    },
    getPrinter: (printerId) => printerManager.getPrinter(printerId) ?? null,
    deletePrinterEntry: async (printer, entry) => {
      if (entry.type === 'directory') await deletePrinterDirectory(printer, entry.path)
      else {
        await deletePrinterFile(printer, entry.path)
        // Match BambuStudio's net behavior: removing a timelapse video also
        // removes its companion thumbnail (firmware does this over MQTT; we
        // browse via raw FTPS so we clean up the orphan ourselves).
        if (isTimelapseVideoPath(entry.path)) {
          await deleteTimelapseThumbnails(printer, entry.path)
        }
      }
    },
    clearPrinterStorageCache: (printerId) => clearPrinterStorageThreeMfInspectionCache(printerId),
    onPrinterStorageDeleted: (printerId, tenantId) => broadcastPrinterStorageChanged(printerId, tenantId),
    onJobChanged: (tenantId) => broadcastDeleteOperationsChanged(tenantId)
  }) {}

  async enqueueLibraryDelete(fileIds: string[]): Promise<DeleteOperationJob> {
    const rows = await this.deps.listLibraryRows(fileIds)
    if (rows.length !== fileIds.length) throw new Error('One or more files were not found')

    const rowsById = new Map(rows.map((row) => [row.id, row] as const))
    const orderedRows = fileIds.map((id) => rowsById.get(id)).filter((row): row is NonNullable<typeof row> => Boolean(row))
    const firstRow = orderedRows[0]
    if (!firstRow) throw new Error('No files were queued for deletion')
    const summaryLabel = orderedRows.length === 1 ? firstRow.name : `${orderedRows.length} files`
    const job = this.createJob({
      kind: 'library.delete',
      targetName: 'Library',
      summaryLabel,
      printerId: null,
      tenantId: firstRow.tenantId,
      queueKey: 'library',
      totalItems: orderedRows.length,
      initialMessage: orderedRows.length === 1
        ? `Deleting ${firstRow.name}…`
        : `Deleting 1 of ${orderedRows.length} files…`,
      run: async (state) => {
        for (const [index, row] of orderedRows.entries()) {
          state.progressMessage = orderedRows.length === 1
            ? `Deleting ${row.name}…`
            : `Deleting ${index + 1} of ${orderedRows.length} files…`
          this.touch(state)

          await this.deps.deleteLibraryRow(row.id)
          await deleteLibraryFileBytes(row).catch((err) => {
            console.warn(`[delete-operation] failed to delete bytes for ${row.id}${row.ownerBridgeId ? ` (bridge ${row.ownerBridgeId})` : ''}`, (err as Error).message)
          })
          await Promise.all((row.versions ?? []).map(async (version) => {
            await deleteLibraryFileBytes(version).catch((err) => {
              console.warn(`[delete-operation] failed to delete bytes for ${row.id} (version)${version.ownerBridgeId ? ` (bridge ${version.ownerBridgeId})` : ''}`, (err as Error).message)
            })
          }))
          this.deps.onLibraryDeleted(row.hidden, state.tenantId)
          state.completedItems = index + 1
          state.progressPercent = Math.round((state.completedItems / state.totalItems) * 100)
          this.touch(state)
        }
      }
    })

    this.enqueue(job)
    return this.toDto(job)
  }

  enqueuePrinterStorageDelete(
    printerId: string,
    printerName: string,
    entries: PrinterStorageDeleteEntry[],
    tenantId: string | null
  ): DeleteOperationJob {
    const firstEntry = entries[0]
    const firstEntryLabel = firstEntry
      ? (path.posix.basename(firstEntry.path) || firstEntry.path)
      : 'Entry'
    const summaryLabel = entries.length === 1
      ? firstEntryLabel
      : `${entries.length} files`
    const job = this.createJob({
      kind: 'printer.storage.delete',
      targetName: printerName,
      summaryLabel,
      printerId,
      tenantId,
      queueKey: `printer:${printerId}`,
      totalItems: entries.length,
      initialMessage: entries.length === 1
        ? `Deleting ${firstEntry?.type === 'directory' ? 'folder' : 'file'} ${firstEntryLabel}…`
        : `Deleting 1 of ${entries.length} files…`,
      run: async (state) => {
        const printer = this.deps.getPrinter(printerId)
        if (!printer) throw new Error('Printer not found or not connected')

        for (const [index, entry] of entries.entries()) {
          const label = path.posix.basename(entry.path) || entry.path
          state.progressMessage = entries.length === 1
            ? `Deleting ${entry.type === 'directory' ? 'folder' : 'file'} ${label}…`
            : `Deleting ${index + 1} of ${entries.length} files…`
          this.touch(state)

          await this.deps.deletePrinterEntry(printer, entry)
          this.deps.clearPrinterStorageCache(printerId)
          this.deps.onPrinterStorageDeleted(printerId, state.tenantId)
          state.completedItems = index + 1
          state.progressPercent = Math.round((state.completedItems / state.totalItems) * 100)
          this.touch(state)
        }
      }
    })

    this.enqueue(job)
    return this.toDto(job)
  }

  list(tenantId: string | null = null): DeleteOperationJob[] {
    return Array.from(this.jobs.values())
      .filter((job) => tenantId == null || job.tenantId === tenantId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .map((job) => this.toDto(job))
  }

  async waitForIdle(): Promise<void> {
    await Promise.all(this.queues.values())
  }

  private createJob(input: {
    kind: DeleteJobKind
    targetName: string
    summaryLabel: string
    printerId: string | null
    tenantId: string | null
    queueKey: string
    totalItems: number
    initialMessage: string
    run: JobRunner
  }): DeleteJobState {
    const now = this.deps.now()
    return {
      id: this.deps.createId(),
      kind: input.kind,
      targetName: input.targetName,
      summaryLabel: input.summaryLabel,
      printerId: input.printerId,
      tenantId: input.tenantId,
      queueKey: input.queueKey,
      totalItems: input.totalItems,
      completedItems: 0,
      progressPercent: input.totalItems > 0 ? 0 : null,
      progressMessage: input.initialMessage,
      status: 'queued',
      error: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      run: input.run
    }
  }

  private enqueue(job: DeleteJobState): void {
    this.jobs.set(job.id, job)
    this.pruneOldJobs()
    this.emitChanged()

    const previous = this.queues.get(job.queueKey) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(() => this.runJob(job))
    const tail = next.then(() => undefined, () => undefined)
    this.queues.set(job.queueKey, tail)
    tail.finally(() => {
      if (this.queues.get(job.queueKey) === tail) this.queues.delete(job.queueKey)
    })
  }

  private async runJob(job: DeleteJobState): Promise<void> {
    job.status = 'running'
    job.startedAt = this.deps.now()
    this.touch(job)

    try {
      await job.run(job)
      job.status = 'completed'
      job.progressPercent = 100
      job.progressMessage = job.totalItems === 1 ? 'Delete completed' : `Deleted ${job.totalItems} files`
      job.error = null
      job.finishedAt = this.deps.now()
      this.touch(job)
    } catch (error) {
      job.status = 'failed'
      job.error = error instanceof Error ? error.message : 'Delete failed'
      job.progressMessage = job.error
      job.finishedAt = this.deps.now()
      this.touch(job)
    }
  }

  private touch(job: DeleteJobState): void {
    job.updatedAt = this.deps.now()
    this.emitChanged()
  }

  private emitChanged(): void {
    if (Array.from(this.jobs.values()).some((job) => job.tenantId == null)) {
      this.deps.onJobChanged(null)
    }
    const tenantIds = new Set(
      Array.from(this.jobs.values())
        .map((job) => job.tenantId)
        .filter((tenantId): tenantId is string => Boolean(tenantId))
    )
    for (const tenantId of tenantIds) {
      this.deps.onJobChanged(tenantId)
    }
  }

  private pruneOldJobs(): void {
    const cutoff = Date.now() - 15 * 60 * 1000
    for (const [id, job] of this.jobs.entries()) {
      if ((job.status === 'completed' || job.status === 'failed') && job.updatedAt.getTime() < cutoff) {
        this.jobs.delete(id)
      }
    }
  }

  private toDto(job: DeleteJobState): DeleteOperationJob {
    return {
      id: job.id,
      kind: job.kind,
      targetName: job.targetName,
      summaryLabel: job.summaryLabel,
      printerId: job.printerId,
      status: job.status,
      totalItems: job.totalItems,
      completedItems: job.completedItems,
      progressPercent: job.progressPercent,
      progressMessage: job.progressMessage,
      error: job.error,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
      startedAt: job.startedAt?.toISOString() ?? null,
      finishedAt: job.finishedAt?.toISOString() ?? null
    }
  }
}

export const deleteOperationDispatcher = new DeleteOperationDispatcher()