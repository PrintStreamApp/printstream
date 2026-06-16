/**
 * In-memory cache for notification snapshots.
 *
 * Two related caches live here:
 *
 *  1. **Public snapshots** (`storeSnapshot` / `getSnapshot`). When a
 *     template asks for media, the API caches the JPEG and serves it
 *     from `/api/notifications/snapshots/<id>` for a short TTL so
 *     every delivery channel can reference the same image.
 *
 *  2. **Per-printer pre-captures** (`getPrecapturedSnapshot`). Bambu
 *     reports `finished` only after the build plate has been lowered,
 *     by which point the chamber camera is usually pointing at empty
 *     space. To get a useful "finished" image we capture a frame
 *     opportunistically while the print is still on the bed — once
 *     the progress crosses a high watermark, and again right at the
 *     printing→finished transition. The notification formatter
 *     prefers this cached frame and only falls back to a live capture
 *     if pre-capture missed (e.g. the API was just restarted).
 *
 * Both caches are intentionally in-memory. Snapshots are transient by
 * design, and a process restart that drops a few pending images is
 * preferable to leaking growing JPEG files on disk.
 */
import { randomUUID } from 'node:crypto'
import { buildPlateGcodeFileHint, type Printer, type PrinterStatus } from '@printstream/shared'
import { getActivePrintJobAssets } from './active-print-job-assets.js'
import { fetchSnapshot, supportsChamberCamera } from './camera.js'
import { analyzePrintFinishGcode } from './print-finish-gcode.js'
import { readPrinterZipEntries } from './printer-remote-zip.js'
import { printerEvents } from './printer-events.js'
import { printerManager } from './printer-manager.js'
import { readEntry } from './three-mf.js'

let snapshotFetcher: typeof fetchSnapshot = fetchSnapshot

interface FinishGcodeAnalysisDeps {
  getActivePrintJobAssets: typeof getActivePrintJobAssets
  readEntry: typeof readEntry
  readPrinterZipEntries: typeof readPrinterZipEntries
}

const ACTIVE_PRINT_GCODE_MAX_BYTES = 128 * 1024 * 1024

const defaultFinishGcodeAnalysisDeps: FinishGcodeAnalysisDeps = {
  getActivePrintJobAssets,
  readEntry,
  readPrinterZipEntries
}

let finishGcodeAnalysisDeps: FinishGcodeAnalysisDeps = defaultFinishGcodeAnalysisDeps

interface StoredSnapshot {
  buffer: Buffer
  contentType: string
  expiresAt: number
}

const TTL_MS = 10 * 60 * 1000
const MAX_ENTRIES = 64

const store = new Map<string, StoredSnapshot>()

function evictExpired(): void {
  const now = Date.now()
  for (const [id, entry] of store) {
    if (entry.expiresAt <= now) store.delete(id)
  }
}

/**
 * Cache a snapshot and return its public id. The id is a fresh UUID
 * so it cannot be guessed from the printer id; sharing the URL only
 * exposes that one snapshot.
 */
export function storeSnapshot(buffer: Buffer, contentType = 'image/jpeg'): string {
  evictExpired()
  // Keep the cache from growing unbounded if a flood of notifications
  // arrives. Drop the oldest entry first.
  if (store.size >= MAX_ENTRIES) {
    const oldestKey = store.keys().next().value
    if (oldestKey) store.delete(oldestKey)
  }
  const id = randomUUID()
  store.set(id, { buffer, contentType, expiresAt: Date.now() + TTL_MS })
  return id
}

export function getSnapshot(id: string): StoredSnapshot | null {
  const entry = store.get(id)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    store.delete(id)
    return null
  }
  return entry
}

// ---------------------------------------------------------------------------
// Per-printer pre-capture cache
// ---------------------------------------------------------------------------

/**
 * Progress threshold at which we grab the "near-end" snapshot. Picked
 * empirically: late enough that the print is essentially done, early
 * enough that the part hasn't been hidden by plate lowering or by the
 * head parking over it.
 */
const PRECAPTURE_THRESHOLD_PERCENT = 97
/** How long a pre-captured frame stays valid after capture. */
const PRECAPTURE_TTL_MS = 5 * 60 * 1000

interface PrecaptureEntry {
  buffer: Buffer
  capturedAt: number
}

interface PrinterCaptureState {
  /** Identifier for the current job, used to dedupe captures per print. */
  jobKey: string | null
  /** Most recent successful capture for this printer. */
  latest: PrecaptureEntry | null
  /** Callers waiting for an in-flight capture to complete. */
  waiters: Array<(buffer: Buffer | null) => void>
  /**
   * Whether the high-watermark capture has been attempted for the
   * current job. We only attempt once to avoid hammering the camera
   * while the printer sits at 99% for a while.
   */
  highWatermarkAttempted: boolean
  /** Whether a capture is currently in flight; prevents overlap. */
  inFlight: boolean
  /** Whether we've observed the current job on its final layer yet. */
  finalLayerSeen: boolean
  /** Whether we've already attempted the late final-layer capture for this job. */
  finalLayerAttempted: boolean
  /** Last sub-stage observed while the current job was printing. */
  lastPrintingSubStage: string | null
  /** Whether this job's finish G-code has a parked-head terminal bed drop. */
  hasTerminalParkedBedDrop: boolean | null
  /** In-flight finish G-code analysis for the current job. */
  finishGcodeAnalysis: Promise<boolean> | null
  /** Preserve the latest pre-finish frame instead of overwriting it on job.finished. */
  preserveLatestOnJobFinished: boolean
}

const precapture = new Map<string, PrinterCaptureState>()
const finishGcodeAnalysisCache = new Map<string, boolean>()

function ensureState(printerId: string): PrinterCaptureState {
  let state = precapture.get(printerId)
  if (!state) {
    state = {
      jobKey: null,
      latest: null,
      waiters: [],
      highWatermarkAttempted: false,
      inFlight: false,
      finalLayerSeen: false,
      finalLayerAttempted: false,
      lastPrintingSubStage: null,
      hasTerminalParkedBedDrop: null,
      finishGcodeAnalysis: null,
      preserveLatestOnJobFinished: false
    }
    precapture.set(printerId, state)
  }
  return state
}

function jobKeyFor(status: PrinterStatus): string {
  return `${status.jobName ?? ''}::${status.gcodeFile ?? ''}`
}

function isOnFinalLayer(status: PrinterStatus): boolean {
  if (status.stage !== 'printing') return false
  if (status.currentLayer == null || status.totalLayers == null) return false
  if (status.totalLayers <= 0) return false
  return status.currentLayer >= status.totalLayers
}

function shouldCaptureLateFinalLayer(
  status: PrinterStatus,
  state: PrinterCaptureState,
  wasOnFinalLayer: boolean
): boolean {
  if (state.finalLayerAttempted) return false
  if (!isOnFinalLayer(status)) return false

  const progressComplete = status.progressPercent === 100
  const noTimeRemaining = status.remainingMinutes === 0
  const subStageChangedAfterFinalLayer =
    wasOnFinalLayer && state.lastPrintingSubStage !== null && status.subStage !== state.lastPrintingSubStage

  return progressComplete || noTimeRemaining || subStageChangedAfterFinalLayer
}

async function captureFor(printer: Printer, state: PrinterCaptureState): Promise<void> {
  await captureForReason(printer, state, { preserveLatestOnJobFinished: false })
}

async function captureForReason(
  printer: Printer,
  state: PrinterCaptureState,
  options: { preserveLatestOnJobFinished: boolean }
): Promise<void> {
  if (state.inFlight) return
  if (!supportsChamberCamera(printer.model)) return
  state.inFlight = true
  try {
    const buffer = await snapshotFetcher(printer)
    if (state.waiters.length > 0) {
      const waiters = [...state.waiters]
      state.waiters.length = 0
      for (const resolve of waiters) resolve(buffer)
      state.latest = null
    } else {
      state.latest = { buffer, capturedAt: Date.now() }
      if (options.preserveLatestOnJobFinished) {
        state.preserveLatestOnJobFinished = true
      }
    }
  } catch {
    if (state.waiters.length > 0) {
      const waiters = [...state.waiters]
      state.waiters.length = 0
      for (const resolve of waiters) resolve(null)
    }
    // Best-effort: a transient camera failure shouldn't surface or retry.
  } finally {
    state.inFlight = false
  }
}

function hasFreshPrecapture(state: PrinterCaptureState): boolean {
  return state.latest != null && Date.now() - state.latest.capturedAt <= PRECAPTURE_TTL_MS
}

function selectActiveFinishGcodeEntryPath(status: PrinterStatus, plate: number | null): string | null {
  if (status.gcodeFile && /(?:^|\/)Metadata\/plate_\d+\.gcode$/i.test(status.gcodeFile)) {
    return status.gcodeFile
  }
  return buildPlateGcodeFileHint(plate)
}

async function resolveTerminalParkedBedDrop(status: PrinterStatus, state: PrinterCaptureState): Promise<boolean> {
  if (state.hasTerminalParkedBedDrop != null) return state.hasTerminalParkedBedDrop
  if (state.finishGcodeAnalysis) return await state.finishGcodeAnalysis

  state.finishGcodeAnalysis = (async () => {
    if (!status.taskId) return false

    const assets = await finishGcodeAnalysisDeps.getActivePrintJobAssets(status.printerId, status.taskId).catch(() => null)
    const localSourcePath = assets?.localSourcePath ?? null
    const printerFilePath = assets?.printerFilePath ?? null

    const entryPath = selectActiveFinishGcodeEntryPath(status, assets?.plate ?? null)
    if (!entryPath) return false

    const sourceCacheKey = localSourcePath
      ? `local:${localSourcePath}`
      : printerFilePath
        ? `printer:${printerFilePath}`
        : null
    if (!sourceCacheKey) return false

    const cacheKey = `${sourceCacheKey}\u0000${entryPath}`
    const cached = finishGcodeAnalysisCache.get(cacheKey)
    if (cached != null) return cached

    const gcodeBuffer = localSourcePath
      ? await finishGcodeAnalysisDeps.readEntry(
        localSourcePath,
        entryPath,
        undefined,
        ACTIVE_PRINT_GCODE_MAX_BYTES
      ).catch(() => null)
      : await readFinishGcodeFromPrinterArchive(status, printerFilePath, entryPath)
    if (!gcodeBuffer) {
      finishGcodeAnalysisCache.set(cacheKey, false)
      return false
    }

    const detected = analyzePrintFinishGcode(gcodeBuffer.toString('utf8')).hasTerminalParkedBedDrop
    finishGcodeAnalysisCache.set(cacheKey, detected)
    return detected
  })()

  try {
    const detected = await state.finishGcodeAnalysis
    state.hasTerminalParkedBedDrop = detected
    return detected
  } finally {
    state.finishGcodeAnalysis = null
  }
}

async function readFinishGcodeFromPrinterArchive(
  status: PrinterStatus,
  printerFilePath: string | null,
  entryPath: string
): Promise<Buffer | null> {
  if (!printerFilePath) return null

  const printer = printerManager.getPrinter(status.printerId)
  if (!printer) return null

  const entries = await finishGcodeAnalysisDeps.readPrinterZipEntries(
    printer,
    printerFilePath,
    [entryPath]
  ).catch(() => null)
  return entries?.get(entryPath) ?? null
}

async function captureLateFinalLayer(printer: Printer, status: PrinterStatus, state: PrinterCaptureState): Promise<void> {
  if (state.inFlight) return
  const preserveLatestOnJobFinished = await resolveTerminalParkedBedDrop(status, state)
  await captureForReason(printer, state, { preserveLatestOnJobFinished })
}

/**
 * Most recent pre-captured snapshot for a printer, or `null` if there
 * isn't one within the freshness window. Calling this consumes the
 * entry so a later print can't accidentally reuse it.
 */
export function getPrecapturedSnapshot(printerId: string): Buffer | null {
  const state = precapture.get(printerId)
  if (!state?.latest) return null
  const fresh = Date.now() - state.latest.capturedAt <= PRECAPTURE_TTL_MS
  const buffer = fresh ? state.latest.buffer : null
  state.latest = null
  return buffer
}

/**
 * Wait briefly for an in-flight pre-capture to finish. This lets the
 * print-job recorder consume the same frame that was kicked off by the
 * terminal `job.finished` event instead of racing it with a second live
 * camera fetch.
 */
export async function waitForPrecapturedSnapshot(printerId: string, timeoutMs = 1_500): Promise<Buffer | null> {
  const immediate = getPrecapturedSnapshot(printerId)
  if (immediate) return immediate

  const state = precapture.get(printerId)
  if (!state?.inFlight) return null

  return await new Promise((resolve) => {
    const waiter = (buffer: Buffer | null) => {
      clearTimeout(timeout)
      const index = state.waiters.indexOf(waiter)
      if (index >= 0) state.waiters.splice(index, 1)
      resolve(buffer)
    }

    const timeout = setTimeout(() => {
      const index = state.waiters.indexOf(waiter)
      if (index >= 0) state.waiters.splice(index, 1)
      resolve(getPrecapturedSnapshot(printerId))
    }, timeoutMs)

    state.waiters.push(waiter)
  })
}

let precaptureStarted = false
/** Internal teardown registered for tests / shutdown. */
let stopPrecapture: (() => void) | null = null

/**
 * Start the per-printer pre-capture listener. Idempotent so it's safe
 * to call from `index.ts` on every boot. The listener subscribes to
 * the shared printer event bus and uses {@link printerManager} to
 * resolve the live `Printer` record (host, access code, model) when
 * it needs to capture a frame.
 */
export function startNotificationSnapshotPrecapture(): void {
  if (precaptureStarted) return
  precaptureStarted = true

  const onStatus = (status: PrinterStatus) => {
    const printer = printerManager.getPrinter(status.printerId)
    if (!printer) return
    const state = ensureState(status.printerId)
    const nextKey = jobKeyFor(status)

    // New job (or job change) — clear the per-job dedupe flag. We keep
    // a stale `latest` around so an in-flight notification can still
    // find it; the next high-watermark capture replaces it.
    if (state.jobKey !== nextKey) {
      state.jobKey = nextKey
      state.highWatermarkAttempted = false
      state.finalLayerSeen = false
      state.finalLayerAttempted = false
      state.lastPrintingSubStage = null
      state.hasTerminalParkedBedDrop = null
      state.finishGcodeAnalysis = null
      state.preserveLatestOnJobFinished = false
    }

    if (
      status.stage === 'printing' &&
      typeof status.progressPercent === 'number' &&
      status.progressPercent >= PRECAPTURE_THRESHOLD_PERCENT &&
      !state.highWatermarkAttempted
    ) {
      state.highWatermarkAttempted = true
      void captureFor(printer, state)
    }

    const wasOnFinalLayer = state.finalLayerSeen
    if (shouldCaptureLateFinalLayer(status, state, wasOnFinalLayer)) {
      state.finalLayerAttempted = true
      void captureLateFinalLayer(printer, status, state)
    }

    if (status.stage === 'printing') {
      state.finalLayerSeen = isOnFinalLayer(status)
      state.lastPrintingSubStage = status.subStage
    } else {
      state.lastPrintingSubStage = null
    }
  }

  // Capture again the moment the printer flips to finished/failed: the
  // bed hasn't started lowering yet, but `mc_percent` may have skipped
  // straight from a low value to 100 if we missed updates.
  const onJobFinished = (event: { printer: Printer }) => {
    const state = ensureState(event.printer.id)
    if (state.preserveLatestOnJobFinished && hasFreshPrecapture(state)) return
    void captureFor(event.printer, state)
  }

  printerEvents.on('status', onStatus)
  printerEvents.on('job.finished', onJobFinished)
  stopPrecapture = () => {
    printerEvents.off('status', onStatus)
    printerEvents.off('job.finished', onJobFinished)
    precaptureStarted = false
    stopPrecapture = null
  }
}

export function stopNotificationSnapshotPrecapture(): void {
  stopPrecapture?.()
}

export function setNotificationSnapshotFetcherForTests(fetcher: typeof fetchSnapshot | null): void {
  snapshotFetcher = fetcher ?? fetchSnapshot
}

export function setNotificationSnapshotFinishGcodeDepsForTests(
  deps: Partial<FinishGcodeAnalysisDeps> | null
): void {
  finishGcodeAnalysisDeps = deps
    ? { ...defaultFinishGcodeAnalysisDeps, ...deps }
    : defaultFinishGcodeAnalysisDeps
}

