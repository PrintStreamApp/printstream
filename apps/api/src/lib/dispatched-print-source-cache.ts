/**
 * Short-lived cache of local 3MF sources for prints started by PrintStream.
 *
 * When we dispatch a library file to a printer, we already have the original
 * archive on disk. Reusing that path avoids downloading the same job back from
 * printer storage just to render skip-object metadata or first-layer previews.
 */
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { env } from './env.js'

type DispatchedPrintSourceKind = '3mf' | 'gcode'

interface DispatchedPrintSourceEntry {
  printerId: string
  taskId: string
  localPath: string
  sourceKind: DispatchedPrintSourceKind
  expiresAt: number
}

interface PendingDispatchedPrintSourceEntry {
  printerId: string
  jobId: string
  localPath: string
  sourceKind: DispatchedPrintSourceKind
  expiresAt: number
}

const ENTRY_TTL_MS = 6 * 60 * 60 * 1000
const CACHE_FILE = path.resolve(path.dirname(env.LIBRARY_DIR), 'dispatched-print-sources.json')

const dispatchedPrintSources = new Map<string, DispatchedPrintSourceEntry>()
const pendingDispatchedPrintSources = new Map<string, PendingDispatchedPrintSourceEntry>()
let hydrationPromise: Promise<void> | null = null
let persistPromise: Promise<void> = Promise.resolve()

export async function registerPendingDispatchedPrintSource(input: {
  printerId: string
  jobId: string | null
  localPath: string | null
  sourceKind: DispatchedPrintSourceKind
}): Promise<void> {
  await ensureHydrated()
  await pruneExpiredEntries()
  if (input.sourceKind !== '3mf' || !input.localPath || !input.jobId) return

  pendingDispatchedPrintSources.set(buildPendingKey(input.printerId, input.jobId), {
    printerId: input.printerId,
    jobId: input.jobId,
    localPath: input.localPath,
    sourceKind: input.sourceKind,
    expiresAt: Date.now() + ENTRY_TTL_MS
  })
  await persistSoon()
}

export async function registerDispatchedPrintSource(input: {
  printerId: string
  taskId: string | null
  localPath: string | null
  sourceKind: DispatchedPrintSourceKind
}): Promise<void> {
  await ensureHydrated()
  await pruneExpiredEntries()
  if (input.sourceKind !== '3mf' || !input.localPath || !input.taskId) return

  dispatchedPrintSources.set(buildKey(input.printerId, input.taskId), {
    printerId: input.printerId,
    taskId: input.taskId,
    localPath: input.localPath,
    sourceKind: input.sourceKind,
    expiresAt: Date.now() + ENTRY_TTL_MS
  })
  await persistSoon()
}

export async function getDispatchedPrintSource(
  printerId: string,
  taskId: string | null
): Promise<string | null> {
  await ensureHydrated()
  await pruneExpiredEntries()

  if (!taskId) return null

  const entry = dispatchedPrintSources.get(buildKey(printerId, taskId))
  if (!entry) return null
  if (!(await fileExists(entry.localPath))) {
    dispatchedPrintSources.delete(buildKey(printerId, taskId))
    await persistSoon()
    return null
  }
  return entry.localPath
}

export async function clearDispatchedPrintSource(printerId: string, taskId: string | null): Promise<void> {
  await ensureHydrated()
  if (!taskId) return
  if (!dispatchedPrintSources.delete(buildKey(printerId, taskId))) return
  await persistSoon()
}

export async function clearPendingDispatchedPrintSource(printerId: string, jobId: string | null): Promise<void> {
  await ensureHydrated()
  if (!jobId) return
  if (!pendingDispatchedPrintSources.delete(buildPendingKey(printerId, jobId))) return
  await persistSoon()
}

export async function assignPendingDispatchedPrintSourceTask(
  printerId: string,
  jobId: string | null,
  taskId: string | null
): Promise<void> {
  await ensureHydrated()
  await pruneExpiredEntries()
  if (!jobId || !taskId) return

  const entry = pendingDispatchedPrintSources.get(buildPendingKey(printerId, jobId))
  if (!entry) return

  pendingDispatchedPrintSources.delete(buildPendingKey(printerId, jobId))
  dispatchedPrintSources.set(buildKey(printerId, taskId), {
    printerId,
    taskId,
    localPath: entry.localPath,
    sourceKind: entry.sourceKind,
    expiresAt: entry.expiresAt
  })
  await persistSoon()
}

export async function reassignDispatchedPrintSourceTask(
  printerId: string,
  fromTaskId: string | null,
  toTaskId: string | null
): Promise<void> {
  await ensureHydrated()
  await pruneExpiredEntries()
  if (!fromTaskId || !toTaskId || fromTaskId === toTaskId) return

  const entry = dispatchedPrintSources.get(buildKey(printerId, fromTaskId))
  if (!entry) return

  dispatchedPrintSources.delete(buildKey(printerId, fromTaskId))
  dispatchedPrintSources.set(buildKey(printerId, toTaskId), {
    ...entry,
    taskId: toTaskId
  })
  await persistSoon()
}

async function ensureHydrated(): Promise<void> {
  hydrationPromise ??= hydrateFromDisk()
  await hydrationPromise
}

async function hydrateFromDisk(): Promise<void> {
  let raw = ''
  try {
    raw = await readFile(CACHE_FILE, 'utf8')
  } catch {
    return
  }

  try {
    const parsed = JSON.parse(raw) as {
      entries?: DispatchedPrintSourceEntry[]
      pendingEntries?: PendingDispatchedPrintSourceEntry[]
    }
    const entries = Array.isArray(parsed.entries) ? parsed.entries : []
    const pendingEntries = Array.isArray(parsed.pendingEntries) ? parsed.pendingEntries : []
    const now = Date.now()
    for (const entry of entries) {
      if (!isPersistableEntry(entry)) continue
      if (entry.expiresAt <= now) continue
      dispatchedPrintSources.set(buildKey(entry.printerId, entry.taskId), entry)
    }
    for (const entry of pendingEntries) {
      if (!isPendingPersistableEntry(entry)) continue
      if (entry.expiresAt <= now) continue
      pendingDispatchedPrintSources.set(buildPendingKey(entry.printerId, entry.jobId), entry)
    }
  } catch {
    await rm(CACHE_FILE, { force: true }).catch(() => undefined)
  }
}

async function pruneExpiredEntries(): Promise<void> {
  const now = Date.now()
  let changed = false
  for (const [key, entry] of dispatchedPrintSources.entries()) {
    if (entry.expiresAt > now) continue
    dispatchedPrintSources.delete(key)
    changed = true
  }
  for (const [key, entry] of pendingDispatchedPrintSources.entries()) {
    if (entry.expiresAt > now) continue
    pendingDispatchedPrintSources.delete(key)
    changed = true
  }
  if (changed) await persistSoon()
}

function buildKey(printerId: string, taskId: string): string {
  return `${printerId}\u0000${taskId}`
}

function buildPendingKey(printerId: string, jobId: string): string {
  return `${printerId}\u0000${jobId}`
}

function isPersistableEntry(value: unknown): value is DispatchedPrintSourceEntry {
  if (!value || typeof value !== 'object') return false

  const candidate = value as Partial<DispatchedPrintSourceEntry>
  return typeof candidate.printerId === 'string'
    && typeof candidate.taskId === 'string'
    && typeof candidate.localPath === 'string'
    && candidate.sourceKind === '3mf'
    && typeof candidate.expiresAt === 'number'
}

function isPendingPersistableEntry(value: unknown): value is PendingDispatchedPrintSourceEntry {
  if (!value || typeof value !== 'object') return false

  const candidate = value as Partial<PendingDispatchedPrintSourceEntry>
  return typeof candidate.printerId === 'string'
    && typeof candidate.jobId === 'string'
    && typeof candidate.localPath === 'string'
    && candidate.sourceKind === '3mf'
    && typeof candidate.expiresAt === 'number'
}

function persistSoon(): Promise<void> {
  persistPromise = persistPromise
    .then(() => persistToDisk())
    .catch(() => undefined)
  return persistPromise
}

async function persistToDisk(): Promise<void> {
  await mkdir(path.dirname(CACHE_FILE), { recursive: true })
  const payload = JSON.stringify({
    entries: Array.from(dispatchedPrintSources.values()),
    pendingEntries: Array.from(pendingDispatchedPrintSources.values())
  })
  const tempPath = `${CACHE_FILE}.tmp`
  await writeFile(tempPath, payload, 'utf8')
  await rename(tempPath, CACHE_FILE)
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}