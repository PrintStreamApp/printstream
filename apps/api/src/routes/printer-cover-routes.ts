/**
 * Cover-image routes and in-flight status for the active printer job.
 *
 * Bambu LAN status carries no embedded thumbnail. The route first tries PrintStream-owned local
 * assets, then an observed exact printer archive path. Both endpoints share the same load-state
 * map; cancellation and cache misses leave it idle, and slow loads retain diagnostic timing.
 */
import { stat } from 'node:fs/promises'
import type { Response, Router } from 'express'
import {
  buildPlateGcodeFileHint,
  extractObservedPrintPlateIndex,
  PRINTERS_VIEW_PERMISSION,
  type Printer
} from '@printstream/shared'
import { requireRequestPermission } from '../lib/authorization.js'
import { getActivePrintJobAssets } from '../lib/active-print-job-assets.js'
import { getCachedCover, isNegativeCached, markCoverMiss, setCachedCover } from '../lib/cover-cache.js'
import { chooseCoverThumbnailFileHint, choosePreferredCoverFileHint, readCoverFromArchive } from '../lib/cover-thumbnail.js'
import { getDispatchedPrintSource } from '../lib/dispatched-print-source-cache.js'
import { notFound } from '../lib/http-error.js'
import { assertWorkspaceOwnsPrinter, requireWorkspaceOwnedConnectedPrinter } from '../lib/printer-access.js'
import { choosePreferredExactPrinterFilePath } from '../lib/printer-file-path.js'
import { printerManager } from '../lib/printer-manager.js'
import { resolvePrinterCoverPath } from '../lib/printer-cover-source.js'
import { readPrintJobThumbnail } from '../lib/print-job-thumbnails.js'
import { readPrinterStorageThumbnail } from '../lib/printer-storage-3mf.js'
import { parsePositiveIntQuery, requestAbortSignal, requireRouteParam } from '../lib/request-helpers.js'

type CoverLoadStatus = 'idle' | 'resolving' | 'downloading' | 'extracting'

interface CoverLoadState {
  status: CoverLoadStatus
  progressPercent: number | null
  message: string
}

const coverLoadStates = new Map<string, CoverLoadState>()
const SLOW_COVER_LOAD_LOG_THRESHOLD_MS = 250

function setCoverLoadState(printerId: string, state: CoverLoadState): void {
  coverLoadStates.set(printerId, state)
}

function clearCoverLoadState(printerId: string): void {
  coverLoadStates.delete(printerId)
}

function getCoverLoadState(printerId: string): CoverLoadState {
  return coverLoadStates.get(printerId) ?? { status: 'idle', progressPercent: null, message: '' }
}

function logCoverLoad(printer: Printer, details: {
  outcome: string
  totalMs: number
  resolveMs: number | null
  extractMs: number | null
  sourcePath: string | null
  plateIndex: number | null
  gcodeFile: string | null
}): void {
  if (details.totalMs < SLOW_COVER_LOAD_LOG_THRESHOLD_MS && details.outcome.endsWith('cache-hit')) return

  const parts = [
    `[cover:${printer.name}]`,
    `outcome=${details.outcome}`,
    `totalMs=${details.totalMs}`,
    `resolveMs=${details.resolveMs ?? 'n/a'}`,
    `extractMs=${details.extractMs ?? 'n/a'}`,
    `plate=${details.plateIndex ?? 'n/a'}`
  ]
  if (details.sourcePath) parts.push(`source=${details.sourcePath}`)
  if (details.gcodeFile) parts.push(`gcode=${details.gcodeFile}`)
  console.info(parts.join(' '))
}

/** Register cover status and media endpoints at their existing printer-router position. */
export function registerPrinterCoverRoutes(router: Router): void {
  /**
   * Best-effort cover image for the currently printing job.
   *
   * Bambu's MQTT report does not include an embedded thumbnail in LAN
   * mode. We prefer PrintStream-owned local assets, then a persisted exact
   * printer archive path when one has been observed for the active job.
   */
  router.get('/:id/cover/status', requireRequestPermission(PRINTERS_VIEW_PERMISSION), async (request, response) => {
    const printerId = requireRouteParam(request.params.id, 'Printer id')
    await assertWorkspaceOwnsPrinter(printerId)
    response.json(getCoverLoadState(printerId))
  })

  router.get('/:id/cover', requireRequestPermission(PRINTERS_VIEW_PERMISSION), async (request, response) => {
    const printer = await requireWorkspaceOwnedConnectedPrinter(requireRouteParam(request.params.id, 'Printer id'))
    if (!printer) throw notFound('Printer not found')
    const requestStartedAt = Date.now()
    let resolveDurationMs: number | null = null
    let extractDurationMs: number | null = null
    let sourcePath: string | null = null
    let outcome = 'error'
    const signal = requestAbortSignal(request, response)
    const status = printerManager.getStatus(printer.id)
    const jobQuery = typeof request.query.job === 'string' ? request.query.job : null
    const gcodeQuery = typeof request.query.gcode === 'string' ? request.query.gcode : null
    const taskQuery = typeof request.query.task === 'string' ? request.query.task : null
    const plateQuery = parsePositiveIntQuery(request.query.plate)
    const jobName = status?.jobName ?? printerManager.getLastJobName(printer.id) ?? jobQuery
    if (!jobName) throw notFound('No active job')

    const gcodeFile = choosePreferredCoverFileHint(status?.gcodeFile ?? null, gcodeQuery)
    const taskId = status?.taskId ?? taskQuery
    let plateIndex = extractObservedPrintPlateIndex(gcodeFile)
    const finishResolve = () => {
      if (resolveDurationMs == null) resolveDurationMs = Date.now() - requestStartedAt
    }

    try {
      setCoverLoadState(printer.id, {
        status: 'resolving',
        progressPercent: null,
        message: 'Resolving active print file…'
      })

      const persistedJob = await getActivePrintJobAssets(printer.id, taskId)
      const selectedPlateGcodeFile = buildPlateGcodeFileHint(persistedJob?.plate ?? plateQuery)
      const thumbnailGcodeFile = chooseCoverThumbnailFileHint(gcodeFile, selectedPlateGcodeFile)
      let exactPrinterFilePath = choosePreferredExactPrinterFilePath(status?.gcodeFile ?? null, persistedJob?.printerFilePath)
      plateIndex = extractObservedPrintPlateIndex(thumbnailGcodeFile)

      const localSourcePath = await getDispatchedPrintSource(printer.id, taskId)
      if (localSourcePath) {
        sourcePath = localSourcePath
        const localCacheKey = await buildLocalCoverCacheKey(printer, localSourcePath, thumbnailGcodeFile).catch(() => null)
        if (localCacheKey) {
          const cached = await getCachedCover(localCacheKey)
          if (cached) {
            finishResolve()
            outcome = 'local-cache-hit'
            clearCoverLoadState(printer.id)
            sendCover(response, cached)
            return
          }

          if (!isNegativeCached(localCacheKey)) {
            finishResolve()
            setCoverLoadState(printer.id, {
              status: 'extracting',
              progressPercent: null,
              message: 'Extracting plate preview…'
            })
            const extractingStartedAt = Date.now()
            try {
              const png = await readCoverFromLocalFile(localSourcePath, thumbnailGcodeFile, signal)
              extractDurationMs = Date.now() - extractingStartedAt
              outcome = 'local-extract'
              await setCachedCover(localCacheKey, png)
              clearCoverLoadState(printer.id)
              sendCover(response, png)
              return
            } catch (error) {
              extractDurationMs = Date.now() - extractingStartedAt
              if ((error as Error).name === 'AbortError') return
              markCoverMiss(localCacheKey)
            }
          }
        }
      }

      if (persistedJob?.localSourcePath) {
        sourcePath = persistedJob.localSourcePath
        const localCacheKey = await buildLocalCoverCacheKey(printer, persistedJob.localSourcePath, thumbnailGcodeFile).catch(() => null)
        if (localCacheKey) {
          const cached = await getCachedCover(localCacheKey)
          if (cached) {
            finishResolve()
            outcome = 'job-local-cache-hit'
            clearCoverLoadState(printer.id)
            sendCover(response, cached)
            return
          }

          if (!isNegativeCached(localCacheKey)) {
            finishResolve()
            setCoverLoadState(printer.id, {
              status: 'extracting',
              progressPercent: null,
              message: 'Extracting plate preview…'
            })
            const extractingStartedAt = Date.now()
            try {
              const png = await readCoverFromLocalFile(persistedJob.localSourcePath, thumbnailGcodeFile, signal)
              extractDurationMs = Date.now() - extractingStartedAt
              outcome = 'job-local-extract'
              await setCachedCover(localCacheKey, png)
              clearCoverLoadState(printer.id)
              sendCover(response, png)
              return
            } catch (error) {
              extractDurationMs = Date.now() - extractingStartedAt
              if ((error as Error).name === 'AbortError') return
              markCoverMiss(localCacheKey)
            }
          }
        }
      }

      if (persistedJob?.thumbnailPath) {
        const png = await readPrintJobThumbnail(persistedJob.thumbnailPath)
        if (png) {
          finishResolve()
          outcome = 'job-thumbnail-hit'
          clearCoverLoadState(printer.id)
          sendCover(response, png)
          return
        }
      }

      exactPrinterFilePath ??= await resolvePrinterCoverPath(
        printer,
        jobName,
        thumbnailGcodeFile,
        { allowLatestFallback: false }
      ).catch(() => null)

      if (exactPrinterFilePath) {
        sourcePath = exactPrinterFilePath
        const printerCacheKey = buildPrinterCoverCacheKey(printer, exactPrinterFilePath, thumbnailGcodeFile)
        const cached = await getCachedCover(printerCacheKey)
        if (cached) {
          finishResolve()
          outcome = 'printer-cache-hit'
          clearCoverLoadState(printer.id)
          sendCover(response, cached)
          return
        }

        if (!isNegativeCached(printerCacheKey)) {
          finishResolve()
          setCoverLoadState(printer.id, {
            status: 'extracting',
            progressPercent: null,
            message: 'Extracting plate preview…'
          })
          const extractingStartedAt = Date.now()
          try {
            const png = await readPrinterStorageThumbnail(printer, exactPrinterFilePath, {
              plateIndex: extractObservedPrintPlateIndex(thumbnailGcodeFile),
              signal
            })
            extractDurationMs = Date.now() - extractingStartedAt
            if (png) {
              outcome = 'printer-extract'
              await setCachedCover(printerCacheKey, png)
              clearCoverLoadState(printer.id)
              sendCover(response, png)
              return
            }
            markCoverMiss(printerCacheKey)
          } catch (error) {
            extractDurationMs = Date.now() - extractingStartedAt
            if ((error as Error).name === 'AbortError') return
            markCoverMiss(printerCacheKey)
          }
        }
      }

      finishResolve()
      outcome = 'not-found'
      clearCoverLoadState(printer.id)
      throw notFound('Cover image unavailable')
    } finally {
      clearCoverLoadState(printer.id)
      logCoverLoad(printer, {
        outcome,
        totalMs: Date.now() - requestStartedAt,
        resolveMs: resolveDurationMs,
        extractMs: extractDurationMs,
        sourcePath,
        plateIndex,
        gcodeFile
      })
    }
  })
}

function sendCover(response: Response, png: Buffer): void {
  response.setHeader('Content-Type', 'image/png')
  response.setHeader('Cache-Control', 'private, max-age=300')
  response.send(png)
}

async function buildLocalCoverCacheKey(printer: Printer, filePath: string, gcodeFile: string | null): Promise<string> {
  const entry = await stat(filePath)
  return `${printer.serial}:local:${filePath}:${entry.mtimeMs}:${entry.size}:plate:${extractObservedPrintPlateIndex(gcodeFile) ?? 1}`
}

function buildPrinterCoverCacheKey(printer: Printer, filePath: string, gcodeFile: string | null): string {
  return `${printer.serial}:printer:${filePath}:plate:${extractObservedPrintPlateIndex(gcodeFile) ?? 1}`
}

async function readCoverFromLocalFile(filePath: string, gcodeFile: string | null, signal?: AbortSignal): Promise<Buffer> {
  try {
    return await readCoverFromArchive(filePath, gcodeFile, signal)
  } catch {
    throw notFound('Cover image not found in print file')
  }
}
