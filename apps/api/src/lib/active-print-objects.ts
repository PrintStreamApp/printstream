/**
 * Active-print object cache.
 *
 * Object skipping needs the sliced object list for the currently printing
 * plate. Resolving that lazily from printer FTPS is too slow for a UI
 * button, so this module warms and caches the list when a job starts and
 * lets routes reuse or continue that background work later.
 */
import {
  buildPlateGcodeFileHint,
  inferObservedPrintPlateIndex,
  type Printer,
  type PrinterActivePrintObject
} from '@printstream/shared'
import { getActivePrintJobAssets } from './active-print-job-assets.js'
import { matchesActivePrintTask } from './active-print-task.js'
import { printerEvents } from './printer-events.js'
import { printerManager } from './printer-manager.js'
import { resolvePrinterCoverPath } from './printer-cover-source.js'
import { choosePreferredExactPrinterFilePath, isMetadataPlateGcodePath } from './printer-file-path.js'
import { clearDispatchedPrintSource, getDispatchedPrintSource } from './dispatched-print-source-cache.js'
import { DEMO_PRINTER_SEEDS } from './demo/demo-printers.js'
import { readPrinterStorageActivePrintObjects, readPrinterStorageActivePrintObjectsFromMetadata } from './printer-storage-3mf.js'
import { readPlateObjectsWithPreview } from './three-mf.js'

const ACTIVE_PRINT_OBJECT_PRELOAD_TIMEOUT_MS = 45_000
const ACTIVE_PRINT_OBJECT_PRELOAD_DELAY_MS = 10_000
const INTERNAL_STORAGE_SKIP_OBJECT_MESSAGE = 'This printer is only exposing the active job through internal metadata. PrintStream cannot read skippable objects from that proprietary path yet. If the printer supports it, enable Store Sent Files on External Storage for more reliable skip-object loading.'
const ACTIVE_SKIP_OBJECT_EXTERNAL_STORAGE_MODELS = new Set<Printer['model']>([
  'P2S',
  'H2D',
  'H2DPRO',
  'H2S'
])
const DEMO_PRINTER_SERIALS = new Set(DEMO_PRINTER_SEEDS.map((seed) => seed.serial))

interface ActivePrintObjectDeps {
  getActivePrintJobAssets: typeof getActivePrintJobAssets
  getDispatchedPrintSource: typeof getDispatchedPrintSource
  resolvePrinterArchivePath: typeof resolvePrinterCoverPath
  readPlateObjectsWithPreview: typeof readPlateObjectsWithPreview
  readPrinterStorageActivePrintObjects: typeof readPrinterStorageActivePrintObjects
  readPrinterStorageActivePrintObjectsFromMetadata: typeof readPrinterStorageActivePrintObjectsFromMetadata
}

const defaultDeps: ActivePrintObjectDeps = {
  getActivePrintJobAssets,
  getDispatchedPrintSource,
  resolvePrinterArchivePath: resolvePrinterCoverPath,
  readPlateObjectsWithPreview,
  readPrinterStorageActivePrintObjects,
  readPrinterStorageActivePrintObjectsFromMetadata
}

let deps: ActivePrintObjectDeps = defaultDeps
let activePrintObjectPreloadTimeoutMs = ACTIVE_PRINT_OBJECT_PRELOAD_TIMEOUT_MS

interface ActivePrintObjectCacheEntry {
  jobName: string
  gcodeFile: string | null
  taskId: string | null
  objects: PrinterActivePrintObject[]
}

interface ActivePrintObjectInflightEntry {
  jobName: string
  gcodeFile: string | null
  taskId: string | null
  promise: Promise<PrinterActivePrintObject[]>
}

interface ActivePrintObjectRequestContext {
  printer: Printer
  jobName: string
  gcodeFile: string | null
  taskId: string | null
}

interface ActivePrintObjectLoadContext extends ActivePrintObjectRequestContext {
  persistedJob: Awaited<ReturnType<typeof getActivePrintJobAssets>>
  resolvedGcodeFile: string | null
  activePlateIndex: number | null
}

interface ActivePrintObjectLoadState {
  emptyObjects: PrinterActivePrintObject[] | null
}

const activePrintObjectCache = new Map<string, ActivePrintObjectCacheEntry>()
const inflightLoads = new Map<string, ActivePrintObjectInflightEntry>()
const scheduledPreloads = new Map<string, ReturnType<typeof setTimeout>>()

let started = false

export function setActivePrintObjectDepsForTests(overrides: Partial<ActivePrintObjectDeps> | null): void {
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps
}

export function setActivePrintObjectPreloadTimeoutMsForTests(timeoutMs: number | null): void {
  activePrintObjectPreloadTimeoutMs = timeoutMs ?? ACTIVE_PRINT_OBJECT_PRELOAD_TIMEOUT_MS
}

export function startActivePrintObjectCache(): void {
  if (started) return
  started = true
  printerEvents.on('job.started', onJobStarted)
  printerEvents.on('job.finished', onJobFinished)
}

export function stopActivePrintObjectCache(): void {
  if (!started) return
  started = false
  printerEvents.off('job.started', onJobStarted)
  printerEvents.off('job.finished', onJobFinished)
  clearScheduledPreloads()
  activePrintObjectCache.clear()
  inflightLoads.clear()
}

export function getCachedActivePrintObjects(
  printerId: string,
  jobName: string,
  gcodeFile: string | null,
  taskId: string | null
): PrinterActivePrintObject[] | null {
  const cached = activePrintObjectCache.get(printerId)
  if (!cached) return null
  if (cached.jobName !== jobName) return null
  if (!matchesActivePrintTask(cached.taskId, taskId)) return null
  if (cached.gcodeFile && gcodeFile && cached.gcodeFile !== gcodeFile) return null
  return cached.objects
}

export function preloadActivePrintObjects(
  printerId: string,
  options: {
    jobName?: string | null
    gcodeFile?: string | null
    taskId?: string | null
  } = {}
): Promise<PrinterActivePrintObject[]> {
  const requestContext = resolveActivePrintObjectRequestContext(printerId, options)
  if (!requestContext) return Promise.resolve([])

  const cached = getCachedActivePrintObjects(printerId, requestContext.jobName, requestContext.gcodeFile, requestContext.taskId)
  if (cached) return Promise.resolve(cached)

  const current = inflightLoads.get(printerId)
  if (
    current
    && current.jobName === requestContext.jobName
    && current.gcodeFile === requestContext.gcodeFile
    && matchesActivePrintTask(current.taskId, requestContext.taskId)
  ) {
    return current.promise
  }

  const promise = loadActivePrintObjects(requestContext)
  inflightLoads.set(printerId, {
    jobName: requestContext.jobName,
    gcodeFile: requestContext.gcodeFile,
    taskId: requestContext.taskId,
    promise
  })
  const cleanup = () => {
    if (inflightLoads.get(printerId)?.promise === promise) inflightLoads.delete(printerId)
  }
  promise.then(cleanup, cleanup)
  return promise
}

export async function fetchActivePrintObjects(
  printerId: string,
  options: {
    jobName?: string | null
    gcodeFile?: string | null
    taskId?: string | null
    signal?: AbortSignal
  } = {}
): Promise<PrinterActivePrintObject[]> {
  const requestContext = resolveActivePrintObjectRequestContext(printerId, options)
  if (!requestContext) return []

  const cached = getCachedActivePrintObjects(printerId, requestContext.jobName, requestContext.gcodeFile, requestContext.taskId)
  if (cached) return cached

  const objects = await loadActivePrintObjects(requestContext, options.signal)
  return objects
}

async function loadActivePrintObjects(
  requestContext: ActivePrintObjectRequestContext,
  signal?: AbortSignal
): Promise<PrinterActivePrintObject[]> {
  const loadContext = await createActivePrintObjectLoadContext(requestContext, signal)
  if (!loadContext) return []

  const timeoutController = new AbortController()
  const timeout = setTimeout(() => timeoutController.abort(), activePrintObjectPreloadTimeoutMs)
  const abortFromCaller = () => timeoutController.abort()
  signal?.addEventListener('abort', abortFromCaller, { once: true })
  try {
    const timedContext = { ...loadContext, signal: timeoutController.signal }
    const loadState: ActivePrintObjectLoadState = { emptyObjects: null }

    const metadataObjects = await runActivePrintObjectLoadAttempt(
      loadState,
      () => deps.readPrinterStorageActivePrintObjectsFromMetadata(timedContext.printer, {
        plateIndex: timedContext.activePlateIndex,
        gcodeFile: timedContext.resolvedGcodeFile,
        signal: timedContext.signal
      }),
      (objects) => cacheActivePrintObjectsIfCurrent(timedContext.printer.id, timedContext.jobName, timedContext.gcodeFile, timedContext.taskId, objects)
    )
    if (metadataObjects) return metadataObjects

    const localSourcePath = await deps.getDispatchedPrintSource(timedContext.printer.id, timedContext.taskId)
      ?? timedContext.persistedJob?.localSourcePath
    if (localSourcePath) {
      const localObjects = await runActivePrintObjectLoadAttempt(
        loadState,
        () => deps.readPlateObjectsWithPreview(localSourcePath, timedContext.activePlateIndex, timedContext.signal),
        (objects) => cacheActivePrintObjectsIfCurrent(timedContext.printer.id, timedContext.jobName, timedContext.gcodeFile, timedContext.taskId, objects)
      )
      if (localObjects) return localObjects
    }

    let liveArchivePath = choosePreferredExactPrinterFilePath(timedContext.resolvedGcodeFile, null)
    if (!liveArchivePath) {
      liveArchivePath = await deps.resolvePrinterArchivePath(
        timedContext.printer,
        timedContext.jobName,
        timedContext.resolvedGcodeFile ?? buildPlateGcodeFileHint(timedContext.activePlateIndex)
      ).catch(() => null)
    }

    if (liveArchivePath && !isMetadataPlateGcodePath(liveArchivePath)) {
      const liveArchivePlateIndex = timedContext.activePlateIndex
        ?? parseActivePrintPlateIndex(liveArchivePath)
        ?? inferObservedPrintPlateIndex({
          jobName: timedContext.jobName,
          gcodeFile: liveArchivePath
        })
        ?? null
      const liveArchiveObjects = await runActivePrintObjectLoadAttempt(
        loadState,
        () => deps.readPrinterStorageActivePrintObjects(
          timedContext.printer,
          liveArchivePath as string,
          liveArchivePlateIndex,
          timedContext.signal
        ),
        (objects) => cacheActivePrintObjectsIfCurrent(timedContext.printer.id, timedContext.jobName, timedContext.gcodeFile, timedContext.taskId, objects)
      )
      if (liveArchiveObjects) return liveArchiveObjects
    }

    const emptyObjects = loadState.emptyObjects
      ?? buildDemoPlaceholderActivePrintObjects(timedContext)
      ?? []
    if (!signal?.aborted) {
      cacheActivePrintObjectsIfCurrent(
        timedContext.printer.id,
        timedContext.jobName,
        timedContext.gcodeFile,
        timedContext.taskId,
        emptyObjects
      )
    }

    return emptyObjects
  } catch {
    if (timeoutController.signal.aborted && !signal?.aborted) {
      cacheActivePrintObjectsIfCurrent(
        loadContext.printer.id,
        loadContext.jobName,
        loadContext.gcodeFile,
        loadContext.taskId,
        []
      )
    }
    return []
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}

function resolveActivePrintObjectRequestContext(
  printerId: string,
  options: {
    jobName?: string | null
    gcodeFile?: string | null
    taskId?: string | null
  }
): ActivePrintObjectRequestContext | null {
  const printer = printerManager.getPrinter(printerId)
  if (!printer) return null

  const status = printerManager.getStatus(printerId)
  const jobName = options.jobName ?? status?.jobName ?? printerManager.getLastJobName(printerId)
  if (!jobName) return null

  return {
    printer,
    jobName,
    gcodeFile: options.gcodeFile ?? status?.gcodeFile ?? null,
    taskId: options.taskId ?? status?.taskId ?? null
  }
}

async function createActivePrintObjectLoadContext(
  requestContext: ActivePrintObjectRequestContext,
  signal?: AbortSignal
): Promise<ActivePrintObjectLoadContext | null> {
  if (signal?.aborted) return null

  const persistedJob = await deps.getActivePrintJobAssets(requestContext.printer.id, requestContext.taskId)
  const preferredExactPrinterFilePath = choosePreferredExactPrinterFilePath(requestContext.gcodeFile, persistedJob?.printerFilePath)
  const resolvedGcodeFile = preferredExactPrinterFilePath
    ?? requestContext.gcodeFile
    ?? buildPlateGcodeFileHint(persistedJob?.plate ?? null)

  return {
    ...requestContext,
    persistedJob,
    resolvedGcodeFile,
    activePlateIndex: persistedJob?.plate
      ?? parseActivePrintPlateIndex(resolvedGcodeFile)
      ?? inferObservedPrintPlateIndex({
        jobName: requestContext.jobName,
        gcodeFile: resolvedGcodeFile
      })
      ?? null
  }
}

async function runActivePrintObjectLoadAttempt(
  state: ActivePrintObjectLoadState,
  load: () => Promise<PrinterActivePrintObject[] | null>,
  onObjects: (objects: PrinterActivePrintObject[]) => void
): Promise<PrinterActivePrintObject[] | null> {
  const objects = await load().catch(() => null)
  if (!objects) return null
  if (objects.length === 0) {
    state.emptyObjects ??= objects
    return null
  }

  onObjects(objects)
  return objects
}

function cacheActivePrintObjectsIfCurrent(
  printerId: string,
  jobName: string,
  gcodeFile: string | null,
  taskId: string | null,
  objects: PrinterActivePrintObject[]
): void {
  const currentStatus = printerManager.getStatus(printerId)
  const currentJobName = currentStatus?.jobName ?? printerManager.getLastJobName(printerId)
  if (currentJobName === jobName && matchesActivePrintTask(currentStatus?.taskId ?? null, taskId)) {
    activePrintObjectCache.set(printerId, { jobName, gcodeFile, taskId, objects })
  }
}

function parseActivePrintPlateIndex(gcodeFile: string | null): number | null {
  const match = gcodeFile?.match(/(?:^|\/)Metadata\/plate_(\d+)\.gcode$/i)
  if (!match) return null
  const plateIndex = Number.parseInt(match[1] ?? '', 10)
  return Number.isFinite(plateIndex) && plateIndex > 0 ? plateIndex : null
}

function buildDemoPlaceholderActivePrintObjects(
  context: Pick<ActivePrintObjectLoadContext, 'printer' | 'jobName' | 'resolvedGcodeFile' | 'activePlateIndex'>
): PrinterActivePrintObject[] | null {
  if (!DEMO_PRINTER_SERIALS.has(context.printer.serial)) return null

  const seed = hashDemoObjectSeed(`${context.printer.serial}:${context.jobName}:${context.resolvedGcodeFile ?? ''}:${context.activePlateIndex ?? 0}`)
  const objectCount = 3 + (Math.abs(seed) % 3)

  return Array.from({ length: objectCount }, (_value, index) => {
    const column = index % 2
    const row = Math.floor(index / 2)
    const minX = column * 12
    const minY = row * 10
    const maxX = minX + 9
    const maxY = minY + 7
    return {
      id: index,
      name: `Object ${index + 1}`,
      previewPath: `M ${minX} ${minY} L ${maxX} ${minY} L ${maxX} ${maxY} L ${minX} ${maxY} L ${minX} ${minY} Z`,
      previewBounds: { minX, minY, maxX, maxY }
    }
  })
}

function hashDemoObjectSeed(value: string): number {
  let hash = 0
  for (const char of value) {
    hash = ((hash << 5) - hash) + char.charCodeAt(0)
    hash |= 0
  }
  return hash
}

export function inferActivePrintObjectsUnavailableState(
  printer: Pick<Printer, 'model'>,
  gcodeFile: string | null,
  objects: PrinterActivePrintObject[]
): {
  unavailableReason: 'internalStorageUnsupported'
  unavailableMessage: string
} | null {
  if (objects.length > 0) return null
  if (!gcodeFile || !isMetadataPlateGcodePath(gcodeFile)) return null
  if (!ACTIVE_SKIP_OBJECT_EXTERNAL_STORAGE_MODELS.has(printer.model)) return null

  return {
    unavailableReason: 'internalStorageUnsupported',
    unavailableMessage: INTERNAL_STORAGE_SKIP_OBJECT_MESSAGE
  }
}


async function onJobStarted(event: { printer: { id: string }; jobName: string }): Promise<void> {
  scheduleActivePrintObjectPreload(event.printer.id, event.jobName)
}

function onJobFinished(event: { printer: { id: string }; jobName: string }): void {
  clearScheduledPreload(event.printer.id)
  activePrintObjectCache.delete(event.printer.id)
  const taskId = printerManager.getStatus(event.printer.id)?.taskId ?? null
  void clearDispatchedPrintSource(event.printer.id, taskId)
}

function scheduleActivePrintObjectPreload(printerId: string, jobName: string): void {
  clearScheduledPreload(printerId)
  const timer = setTimeout(() => {
    scheduledPreloads.delete(printerId)
    void preloadActivePrintObjects(printerId, { jobName })
  }, ACTIVE_PRINT_OBJECT_PRELOAD_DELAY_MS)
  scheduledPreloads.set(printerId, timer)
}

function clearScheduledPreload(printerId: string): void {
  const timer = scheduledPreloads.get(printerId)
  if (!timer) return
  clearTimeout(timer)
  scheduledPreloads.delete(printerId)
}

function clearScheduledPreloads(): void {
  for (const timer of scheduledPreloads.values()) {
    clearTimeout(timer)
  }
  scheduledPreloads.clear()
}