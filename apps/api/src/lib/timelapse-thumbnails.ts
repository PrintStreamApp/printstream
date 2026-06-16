/**
 * Helpers for locating and cleaning up the companion thumbnails that Bambu
 * printers store for timelapse videos.
 *
 * PrintStream browses printer storage over raw FTPS. BambuStudio's device view
 * instead talks to the printer's MQTT/TLS file service, where the firmware
 * deletes the associated thumbnail (kept in a separate `/timelapse/thumbnail/`
 * directory) whenever a timelapse video is removed. Because our FTPS deletes
 * never reach that firmware path, we have to remove the orphaned thumbnail
 * ourselves to match BambuStudio's net behavior.
 */
import path from 'node:path'
import type { Printer } from '@printstream/shared'
import type { PrinterFsEntry } from '@printstream/bridge-runtime'
import { deletePrinterFile, listPrinterDirectory } from './printer-ftp.js'

const THUMBNAIL_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png'])

/** Candidate thumbnail paths for a timelapse video, ordered most-likely first. */
export function buildTimelapseThumbnailCandidates(filePath: string): { jpg: string[]; png: string[] } {
  const trimmed = filePath.replace(/^\/+/, '')
  const relative = trimmed.replace(/^timelapse\/?/i, '')
  const stem = relative.replace(/\.[^.]+$/u, '')
  const baseName = path.posix.basename(stem)
  const parentDir = path.posix.dirname(relative)
  const siblingBase = parentDir === '.' ? `/timelapse/${baseName}` : `/timelapse/${parentDir}/${baseName}`
  const siblingStem = parentDir === '.' ? `/timelapse/${stem}` : `/timelapse/${stem}`
  const thumbnailBase = parentDir === '.' ? `/timelapse/thumbnail/${baseName}` : `/timelapse/thumbnail/${parentDir}/${baseName}`
  const thumbnailStem = parentDir === '.' ? `/timelapse/thumbnail/${stem}` : `/timelapse/thumbnail/${stem}`
  const unique = (candidates: string[]) => Array.from(new Set(candidates))
  return {
    jpg: unique([
      `${thumbnailStem}.jpg`,
      `${thumbnailBase}.jpg`,
      `${thumbnailStem}.jpeg`,
      `${thumbnailBase}.jpeg`,
      `${siblingStem}.jpg`,
      `${siblingBase}.jpg`,
      `${siblingStem}.jpeg`,
      `${siblingBase}.jpeg`,
      `/thumbnail/${stem}.jpg`,
      `/thumbnail/${baseName}.jpg`,
      `/thumbnail/${stem}.jpeg`,
      `/thumbnail/${baseName}.jpeg`
    ]),
    png: unique([
      `${thumbnailStem}.png`,
      `${thumbnailBase}.png`,
      `${siblingStem}.png`,
      `${siblingBase}.png`,
      `/thumbnail/${stem}.png`,
      `/thumbnail/${baseName}.png`
    ])
  }
}

/**
 * True when `filePath` is a timelapse video that lives under `/timelapse/`
 * (and not within the `/timelapse/thumbnail/` subdirectory).
 */
export function isTimelapseVideoPath(filePath: string): boolean {
  const normalized = filePath.replace(/^\/+/, '').toLowerCase()
  if (!normalized.startsWith('timelapse/')) return false
  if (normalized.startsWith('timelapse/thumbnail/')) return false
  return normalized.endsWith('.mp4')
}

/** The `/timelapse/thumbnail/` directory and bare file stem for a timelapse video. */
function resolveTimelapseThumbnailLocation(filePath: string): { dir: string; stem: string } {
  const relative = filePath.replace(/^\/+/, '').replace(/^timelapse\/?/i, '')
  const stem = path.posix.basename(relative).replace(/\.[^.]+$/u, '')
  const parentDir = path.posix.dirname(relative)
  const dir = parentDir === '.' ? '/timelapse/thumbnail' : `/timelapse/thumbnail/${parentDir}`
  return { dir, stem }
}

export interface TimelapseThumbnailCleanupDeps {
  listDirectory: (printer: Printer, dir: string) => Promise<PrinterFsEntry[]>
  deleteFile: (printer: Printer, filePath: string) => Promise<void>
}

const defaultCleanupDeps: TimelapseThumbnailCleanupDeps = {
  listDirectory: (printer, dir) => listPrinterDirectory(printer, dir),
  deleteFile: (printer, filePath) => deletePrinterFile(printer, filePath)
}

/**
 * Best-effort deletion of the thumbnail(s) that accompany a timelapse video in
 * the printer's `/timelapse/thumbnail/` directory. Returns the paths removed.
 *
 * The video file itself is not touched. Listing or delete failures are
 * swallowed so that thumbnail cleanup can never fail an otherwise successful
 * video deletion.
 */
export async function deleteTimelapseThumbnails(
  printer: Printer,
  videoPath: string,
  deps: TimelapseThumbnailCleanupDeps = defaultCleanupDeps
): Promise<string[]> {
  if (!isTimelapseVideoPath(videoPath)) return []
  const { dir, stem } = resolveTimelapseThumbnailLocation(videoPath)
  const stemLower = stem.toLowerCase()

  let entries: PrinterFsEntry[]
  try {
    entries = await deps.listDirectory(printer, dir)
  } catch {
    return []
  }

  const targets = entries.filter((entry) => {
    if (entry.type !== 'file') return false
    const extension = path.posix.extname(entry.name).toLowerCase()
    if (!THUMBNAIL_IMAGE_EXTENSIONS.has(extension)) return false
    const entryStem = path.posix.basename(entry.name).replace(/\.[^.]+$/u, '').toLowerCase()
    return entryStem === stemLower
  })

  const deleted: string[] = []
  for (const entry of targets) {
    const target = entry.path ?? `${dir}/${entry.name}`
    try {
      await deps.deleteFile(printer, target)
      deleted.push(target)
    } catch {
      // Best effort: thumbnail may already be gone or the printer disconnected.
    }
  }
  return deleted
}
