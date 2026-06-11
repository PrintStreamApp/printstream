/**
 * Plate-aware 3MF thumbnail helpers.
 *
 * PrintStream keeps the original multi-plate 3MF on disk even when only one
 * plate was dispatched. Cover extraction must therefore choose the thumbnail
 * for the active `Metadata/plate_N.gcode` entry rather than always falling
 * back to the first plate in the archive.
 */
import { extractObservedPrintPlateIndex } from '@printstream/shared'
import type { ThreeMfIndex } from './three-mf.js'
import { readEntry, readPlateIndex } from './three-mf.js'

export function isDirectArchiveCoverHint(value: string | null): boolean {
  if (!value) return false
  const trimmed = value.trim().replace(/^file:\/\//, '')
  return /\.3mf$/i.test(trimmed)
}

export function choosePreferredCoverFileHint(primary: string | null, fallback: string | null): string | null {
  if (isDirectArchiveCoverHint(primary)) return primary
  if (isDirectArchiveCoverHint(fallback)) return fallback
  return primary ?? fallback
}

export function chooseCoverThumbnailFileHint(sourceHint: string | null, selectedPlateHint: string | null): string | null {
  return selectedPlateHint ?? sourceHint
}

export function buildCoverThumbnailCandidates(index: ThreeMfIndex | null, plateIndex: number | null): string[] {
  const preferredThumbnail = (plateIndex != null
    ? index?.plates.find((entry) => entry.index === plateIndex)?.thumbnailFile
    : null)
    ?? index?.plates[0]?.thumbnailFile
    ?? 'Metadata/plate_1.png'

  return Array.from(new Set([preferredThumbnail, 'Metadata/plate_1.png', 'Metadata/top_1.png']))
}

export async function readCoverFromArchive(
  filePath: string,
  gcodeFile: string | null,
  signal?: AbortSignal
): Promise<Buffer> {
  const index = await readPlateIndex(filePath, signal).catch(() => null)
  const plateIndex = extractObservedPrintPlateIndex(gcodeFile)

  for (const entry of buildCoverThumbnailCandidates(index, plateIndex)) {
    try {
      const png = await readEntry(filePath, entry, signal)
      if (png) return png
    } catch {
      // Try the next embedded preview candidate.
    }
  }

  throw new Error('Cover image not found in print file')
}