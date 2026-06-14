/**
 * Persistent camera snapshots for print-job history.
 *
 * Unlike notification images, these frames belong to the `PrintJob` itself.
 * Notifications and future UI surfaces should reference the persisted job
 * snapshot rather than maintaining a separate ownership path.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Printer } from '@printstream/shared'
import { env } from './env.js'
import { fetchSnapshot, supportsChamberCamera } from './camera.js'
import { getPrecapturedSnapshot, waitForPrecapturedSnapshot } from './notification-snapshots.js'
import { rootPrisma } from './prisma.js'

const PRINT_JOB_SNAPSHOT_DIR = path.resolve(path.dirname(env.LIBRARY_DIR), 'job-history-snapshots')
const inflightPersists = new Map<string, Promise<string | null>>()

let snapshotFetcher: typeof fetchSnapshot = fetchSnapshot

export function getPrintJobSnapshotDir(): string {
  return PRINT_JOB_SNAPSHOT_DIR
}

export async function savePrintJobSnapshot(jobId: string, image: Buffer): Promise<string> {
  await mkdir(PRINT_JOB_SNAPSHOT_DIR, { recursive: true })
  const storedPath = `${jobId}.jpg`
  await writeFile(resolvePrintJobSnapshotPath(storedPath), image)
  return storedPath
}

export async function readPrintJobSnapshot(storedPath: string): Promise<Buffer | null> {
  try {
    return await readFile(resolvePrintJobSnapshotPath(storedPath))
  } catch {
    return null
  }
}

export async function deletePrintJobSnapshot(storedPath: string): Promise<void> {
  await rm(resolvePrintJobSnapshotPath(storedPath), { force: true }).catch(() => undefined)
}

export async function ensurePrintJobSnapshot(
  printer: Printer,
  jobId: string
): Promise<string | null> {
  const existingInflight = inflightPersists.get(jobId)
  if (existingInflight) return existingInflight

  const persistPromise = persistPrintJobSnapshot(printer, jobId)
  inflightPersists.set(jobId, persistPromise)
  const cleanup = () => {
    if (inflightPersists.get(jobId) === persistPromise) {
      inflightPersists.delete(jobId)
    }
  }
  persistPromise.then(cleanup, cleanup)
  return persistPromise
}

export function setPrintJobSnapshotFetcherForTests(fetcher: typeof fetchSnapshot | null): void {
  snapshotFetcher = fetcher ?? fetchSnapshot
}

async function persistPrintJobSnapshot(printer: Printer, jobId: string): Promise<string | null> {
  const row = await rootPrisma.printJob.findUnique({
    where: { id: jobId },
    select: { snapshotPath: true }
  })
  if (!row) return null
  if (row.snapshotPath) return row.snapshotPath
  if (!supportsChamberCamera(printer.model)) return null

  let buffer = getPrecapturedSnapshot(printer.id)
  if (!buffer) {
    buffer = await waitForPrecapturedSnapshot(printer.id)
  }
  if (!buffer) {
    try {
      buffer = await snapshotFetcher(printer)
    } catch {
      return null
    }
  }

  const snapshotPath = await savePrintJobSnapshot(jobId, buffer)
  await rootPrisma.printJob.update({
    where: { id: jobId },
    data: { snapshotPath }
  })
  return snapshotPath
}

function resolvePrintJobSnapshotPath(storedPath: string): string {
  if (path.isAbsolute(storedPath)) return storedPath
  return path.join(PRINT_JOB_SNAPSHOT_DIR, storedPath)
}