/**
 * Best-effort thumbnail extraction for job history entries.
 *
 * History cards should survive later library cleanup or manual file deletion,
 * so callers can read a thumbnail from a current library file and persist it
 * under a job-scoped path.
 */
import { readBridgeLibraryThumbnail, resolveLibraryFileToLocalPath } from './bridge-library-files.js'
import { savePrintJobThumbnail } from './print-job-thumbnails.js'
import { rootPrisma } from './prisma.js'
import { readEntry, readPlateIndex } from './three-mf.js'

export async function readLibraryJobThumbnail(fileId: string | null, plate: number): Promise<Buffer | null> {
  if (!fileId) return null

  const file = await rootPrisma.libraryFile.findUnique({
    where: { id: fileId },
    select: { ownerBridgeId: true, storedPath: true, kind: true }
  })
  if (!file || (file.kind !== '3mf' && file.kind !== 'gcode')) return null

  try {
    if (file.ownerBridgeId) {
      return await readBridgeLibraryThumbnail(file, plate)
    }
    const onDisk = await resolveLibraryFileToLocalPath(file)
    const index = await readPlateIndex(onDisk).catch(() => null)
    const entryPath = index?.plates.find((entry) => entry.index === plate)?.thumbnailFile
      ?? index?.plates[0]?.thumbnailFile
      ?? `Metadata/plate_${plate}.png`
    return await readEntry(onDisk, entryPath)
  } catch {
    return null
  }
}

export async function persistHistoryThumbnailFromLibrary(input: {
  jobId: string
  preferredFileIds: Array<string | null | undefined>
  plate: number
}): Promise<string | null> {
  const seen = new Set<string>()
  for (const fileId of input.preferredFileIds) {
    if (!fileId || seen.has(fileId)) continue
    seen.add(fileId)
    const png = await readLibraryJobThumbnail(fileId, input.plate)
    if (!png) continue
    return await savePrintJobThumbnail(input.jobId, png)
  }
  return null
}