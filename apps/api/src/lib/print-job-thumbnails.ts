/**
 * Persistent thumbnails for completed print jobs.
 *
 * History cards should not depend on live printer state or the continued
 * presence of a library file. We therefore store a best-effort PNG per job on
 * disk and serve it back through the jobs API.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { env } from './env.js'

const PRINT_JOB_THUMBNAIL_DIR = path.resolve(path.dirname(env.LIBRARY_DIR), 'job-history-thumbnails')

export function getPrintJobThumbnailDir(): string {
  return PRINT_JOB_THUMBNAIL_DIR
}

export async function savePrintJobThumbnail(jobId: string, png: Buffer): Promise<string> {
  await mkdir(PRINT_JOB_THUMBNAIL_DIR, { recursive: true })
  const storedPath = `${jobId}.png`
  await writeFile(resolvePrintJobThumbnailPath(storedPath), png)
  return storedPath
}

export async function readPrintJobThumbnail(storedPath: string): Promise<Buffer | null> {
  try {
    return await readFile(resolvePrintJobThumbnailPath(storedPath))
  } catch {
    return null
  }
}

export async function deletePrintJobThumbnail(storedPath: string): Promise<void> {
  await rm(resolvePrintJobThumbnailPath(storedPath), { force: true }).catch(() => undefined)
}

function resolvePrintJobThumbnailPath(storedPath: string): string {
  if (path.isAbsolute(storedPath)) return storedPath
  return path.join(PRINT_JOB_THUMBNAIL_DIR, storedPath)
}