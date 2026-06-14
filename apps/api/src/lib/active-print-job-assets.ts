/**
 * Recover persisted assets for a printer's currently active print job.
 *
 * Dispatch-time in-memory caches are the fast path, but active prints can
 * outlive an API restart. The matching `PrintJob` row is the durable fallback
 * for library-backed 3MF assets such as thumbnails and skip-object metadata.
 */
import { rootPrisma } from './prisma.js'
import { resolveLibraryFileToLocalPath } from './bridge-library-files.js'

export interface ActivePrintJobAssets {
  jobId: string
  jobName: string
  plate: number | null
  printerFilePath: string | null
  thumbnailPath: string | null
  localSourcePath: string | null
}

interface ActivePrintJobAssetsDeps {
  resolveLocalPath(file: { ownerBridgeId?: string | null; storedPath: string }): Promise<string>
}

interface ActivePrintJobAssetRow {
  id: string
  jobName: string
  plate: number | null
  printerFilePath: string | null
  thumbnailPath: string | null
  sourceType: string
  startedAt: Date
  file: {
    ownerBridgeId: string | null
    storedPath: string
  } | null
}

const defaultDeps: ActivePrintJobAssetsDeps = {
  resolveLocalPath: resolveLibraryFileToLocalPath
}

export async function getActivePrintJobAssets(
  printerId: string,
  taskId: string | null,
  deps: ActivePrintJobAssetsDeps = defaultDeps
): Promise<ActivePrintJobAssets | null> {
  if (!taskId) return null

  const rows = await rootPrisma.printJob.findMany({
    where: {
      printerId,
      finishedAt: null,
      taskId
    },
    orderBy: { startedAt: 'desc' },
    select: {
      id: true,
      jobName: true,
      plate: true,
      printerFilePath: true,
      thumbnailPath: true,
      sourceType: true,
      startedAt: true,
      file: {
        select: {
          ownerBridgeId: true,
          storedPath: true
        }
      }
    }
  })
  const row = pickPreferredActivePrintJobAssetRow(rows)
  if (!row) return null

  const localSourcePath = row.file?.storedPath
    ? await deps.resolveLocalPath(row.file).catch(() => null)
    : null

  return {
    jobId: row.id,
    jobName: row.jobName,
    plate: row.plate,
    printerFilePath: row.printerFilePath,
    thumbnailPath: row.thumbnailPath,
    localSourcePath
  }
}

function pickPreferredActivePrintJobAssetRow(rows: ActivePrintJobAssetRow[]): ActivePrintJobAssetRow | null {
  if (rows.length === 0) return null

  return rows.reduce((best, current) => {
    if (!best) return current

    const currentScore = scoreActivePrintJobAssetRow(current)
    const bestScore = scoreActivePrintJobAssetRow(best)
    if (currentScore !== bestScore) return currentScore > bestScore ? current : best

    return current.startedAt.getTime() > best.startedAt.getTime() ? current : best
  }, rows[0] ?? null)
}

function scoreActivePrintJobAssetRow(row: ActivePrintJobAssetRow): number {
  let score = 0
  if (row.sourceType === 'library') score += 100
  if (row.file?.storedPath) score += 50
  if (row.thumbnailPath) score += 10
  if (row.printerFilePath) score += 5
  return score
}