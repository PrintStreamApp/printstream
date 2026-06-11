/**
 * Reconciles real database-backed library and jobs data for the public demo.
 *
 * The demo reuses actual library files on disk and normal `PrintJob` rows so
 * the web app can keep its standard data-loading flows.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PUBLIC_DEMO_TENANT_SLUG,
  classifyLibraryFileKind,
  DEMO_LIBRARY_TARGETS,
  findDemoPlaylistJob as findCuratedDemoPlaylistJob,
  findDemoPrintDefinitionByFileName,
  getDemoPrinterActiveJob,
  getDemoPrinterRecentFinishedJob,
  getNextDemoPlaylistJob as getCuratedNextDemoPlaylistJob,
  isPrinterModelCompatible,
  printerModelSchema,
  type DemoPlaylistJob,
  type PrinterModel
} from '@printstream/shared'
import { env } from '../env.js'
import { rootPrisma } from '../prisma.js'
import { resolveLibraryFileToLocalPath } from '../bridge-library-files.js'
import { deletePrintJobThumbnail, savePrintJobThumbnail } from '../print-job-thumbnails.js'
import { deletePrintJobSnapshot, savePrintJobSnapshot } from '../print-job-snapshots.js'
import { readEntry, readPlateIndex } from '../three-mf.js'
import { DEMO_PRINTER_SEEDS } from './demo-printers.js'

interface DemoFinishedJobSeed {
  printerSerial: string
  fileName: string
  jobName: string
  plate: number
  useAms: boolean
  bedLevel: boolean
  amsMapping: number[] | null
  result: 'success' | 'failed'
  startedAt: Date
  finishedAt: Date
  progressPercent: number
  durationSeconds: number
  filamentUsedGrams: number
  filamentUsedMeters: number
}

interface DemoStatsRollup {
  totalPrints: number
  successfulPrints: number
  failedPrints: number
  cancelledPrints: number
  successfulPrintDurationSeconds: number
  failedPrintDurationSeconds: number
  cancelledPrintDurationSeconds: number
  wastedPrintDurationSeconds: number
  trackedFilamentPrints: number
  filamentUsedGrams: number
  successfulFilamentUsedGrams: number
  failedFilamentUsedGrams: number
  cancelledFilamentUsedGrams: number
  wastedFilamentUsedGrams: number
  filamentUsedMeters: number
  successfulFilamentUsedMeters: number
  failedFilamentUsedMeters: number
  cancelledFilamentUsedMeters: number
  wastedFilamentUsedMeters: number
}

export interface DemoLibraryFileMatch {
  id: string
  name: string
  sizeBytes: number
  storedPath: string
  ownerBridgeId?: string | null
}

interface DemoLibraryReconcileFileMatch extends DemoLibraryFileMatch {
  hidden: boolean
}

interface DemoSeededActiveJob {
  printerId: string
  printerSerial: string
  taskId: string
  jobName: string
  fileId: string
  fileName: string
  fileStoredPath: string
  fileSizeBytes: number
  plate: number
  useAms: boolean
  bedLevel: boolean
  amsMapping: number[] | null
  startedAt: Date
}

interface DemoSeedablePrinter {
  id: string
  serial: string
  model: PrinterModel
  position: number | null
}

const demoLibraryDir = resolveDemoLibraryDir(env.PUBLIC_DEMO_BRIDGE_LIBRARY_DIR)
const demoFinishedSnapshotDir = resolveDemoLibraryDir('./data/demo-camera-snapshots')
const demoCaptureDir = resolveDemoLibraryDir('./data/demo-captures')
const DEMO_FINISHED_JOB_SNAPSHOT_FILES = [
  'chamber-blue-bin.jpg',
  'chamber-green-bin.jpg',
  'chamber-purple-part.jpg',
  'home-h2d-start.jpg',
  'home-h2d-mid-build.jpg',
  'home-h2d-near-finished.jpg',
  'home-h2d-late-progress.jpg',
  'home-h2d-early-progress.jpg'
]


export function findDemoLibraryEntryName(fileNames: string[], displayName: string): string | null {
  return fileNames.find((fileName) => normalizeDemoLibraryDisplayName(fileName) === displayName) ?? null
}

export function findDemoLibraryFile<T extends DemoLibraryFileMatch>(
  files: readonly T[],
  displayName: string
): T | null {
  return files.find((file) => (
    normalizeDemoLibraryDisplayName(file.name) === displayName
    || normalizeDemoLibraryDisplayName(path.basename(file.storedPath)) === displayName
  )) ?? null
}

export function findDemoLibraryReconcileFile<T extends DemoLibraryReconcileFileMatch>(
  files: readonly T[],
  fileName: string
): T | null {
  const exactMatches = files.filter((file) => path.basename(file.storedPath) === fileName)
  if (exactMatches.length > 0) {
    return exactMatches.find((file) => file.hidden) ?? exactMatches[0] ?? null
  }

  return files.find((file) => !file.hidden && (
    normalizeDemoLibraryDisplayName(file.name) === fileName
    || normalizeDemoLibraryDisplayName(path.basename(file.storedPath)) === fileName
  )) ?? null
}

export function buildDemoFinishedJobSeeds(nowMs = Date.now(), demoFileNames: readonly string[] = DEMO_LIBRARY_TARGETS): DemoFinishedJobSeed[] {
  const fileAt = (index: number) => demoFileNames[index % demoFileNames.length] ?? DEMO_LIBRARY_TARGETS[index % DEMO_LIBRARY_TARGETS.length] ?? 'Demo_Print.gcode.3mf'
  const jobNameAt = (index: number) => formatDemoJobName(fileAt(index))
  return DEMO_PRINTER_SEEDS.map((seed, index) => {
    const recentFinishedJob = getDemoPrinterRecentFinishedJob(seed.serial)
    const fileName = recentFinishedJob?.fileName ?? fileAt(index)
    const usage = buildDemoFilamentUsage(seed.serial, fileName, index)
    return {
      printerSerial: seed.serial,
      fileName,
      jobName: recentFinishedJob?.jobName ?? jobNameAt(index),
      plate: recentFinishedJob?.plate ?? 1,
      useAms: recentFinishedJob?.useAms ?? true,
      bedLevel: recentFinishedJob?.bedLevel ?? true,
      amsMapping: recentFinishedJob?.amsMapping ?? [0],
      result: seed.serial === 'DEMO-P1S-001' ? 'failed' : 'success',
      startedAt: new Date(nowMs - 1000 * 60 * 60 * (20 + (index * 4))),
      finishedAt: new Date(nowMs - 1000 * 60 * 60 * (19 + (index * 4))),
      progressPercent: seed.serial === 'DEMO-P1S-001' ? 64 : 100,
      durationSeconds: (34 + index * 3) * 60,
      filamentUsedGrams: usage.grams,
      filamentUsedMeters: usage.meters
    }
  })
}

export function getNextDemoPlaylistJob(printerSerial: string, lastJobName: string | null | undefined): DemoPlaylistJob | null {
  return getCuratedNextDemoPlaylistJob(printerSerial, lastJobName)
}

export function findDemoPlaylistJob(printerSerial: string, jobName: string): DemoPlaylistJob | null {
  return findCuratedDemoPlaylistJob(printerSerial, jobName)
}

export function getDemoAutoStartDelayMs(printerSerial: string, reason: 'initial' | 'repeat'): number {
  const seed = DEMO_PRINTER_SEEDS.find((entry) => entry.serial === printerSerial)
  const position = seed?.position ?? 0
  const staggerMs = position * 7_000
  return reason === 'initial'
    ? 15_000 + staggerMs
    : 35_000 + staggerMs
}

export async function reconcileDemoLibrary(input: { tenantId?: string | null; bridgeId?: string | null } = {}): Promise<void> {
  const tenantId = input.tenantId ?? await resolveDemoTenantId()
  if (!tenantId) return
  const bridgeId = input.bridgeId ?? await resolveDemoBridgeId(tenantId)
  if (!bridgeId) return

  const selected = (await readdir(demoLibraryDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile())
    .filter((entry) => classifyLibraryFileKind(entry.name) !== 'other')
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))

  const existing = await rootPrisma.libraryFile.findMany({
    where: { tenantId },
    select: { id: true, name: true, sizeBytes: true, storedPath: true, ownerBridgeId: true, hidden: true }
  })
  const retainedIds = new Set<string>()

  for (const entry of selected) {
    const fullPath = path.join(demoLibraryDir, entry.name)
    const fileStat = await stat(fullPath)
    const matched = findDemoLibraryReconcileFile(existing, entry.name)
    const data = {
      ownerBridgeId: bridgeId,
      name: matched?.hidden ? matched.name : normalizeDemoLibraryDisplayName(entry.name),
      storedPath: entry.name,
      sizeBytes: fileStat.size,
      kind: classifyLibraryFileKind(entry.name),
      hidden: matched?.hidden ?? false
    }
    if (matched) {
      retainedIds.add(matched.id)
      await rootPrisma.libraryFile.update({
        where: { id: matched.id },
        data
      })
      continue
    }

    const created = await rootPrisma.libraryFile.create({
      data: {
        tenantId,
        ...data
      }
    })
    retainedIds.add(created.id)
  }

  const staleIds = existing
    .filter((row) => !row.hidden && !retainedIds.has(row.id))
    .map((row) => row.id)
  if (staleIds.length > 0) {
    await rootPrisma.libraryFile.updateMany({
      where: { id: { in: staleIds } },
      data: { hidden: true }
    })
  }
}

export async function seedDemoJobs(input: { tenantId?: string | null } = {}): Promise<void> {
  const tenantId = input.tenantId ?? await resolveDemoTenantId()
  if (!tenantId) return

  const printers = await rootPrisma.printer.findMany({
    where: { tenantId, serial: { in: DEMO_PRINTER_SEEDS.map((seed) => seed.serial) } },
    orderBy: { position: 'asc' }
  })
  if (printers.length === 0) return

  const seedablePrinters: DemoSeedablePrinter[] = printers.map((printer) => {
    const parsedModel = printerModelSchema.safeParse(printer.model)
    return {
      id: printer.id,
      serial: printer.serial,
      model: parsedModel.success ? parsedModel.data : 'unknown',
      position: printer.position
    }
  })

  const files = await rootPrisma.libraryFile.findMany({
    where: { tenantId, hidden: false },
    orderBy: { uploadedAt: 'asc' }
  })
  if (files.length === 0) return
  const demoFileNames = files.map((file) => normalizeDemoLibraryDisplayName(path.basename(file.storedPath)))

  const fileByName = new Map(files.map((file) => [normalizeDemoLibraryDisplayName(file.name), file] as const))
  const printersBySerial = new Map(printers.map((printer) => [printer.serial, printer] as const))
  const printersById = new Map(printers.map((printer) => [printer.id, printer] as const))

  const existingJobs = await rootPrisma.printJob.findMany({
    where: {
      tenantId,
      printerId: { in: printers.map((printer) => printer.id) },
      finishedAt: { not: null }
    },
    select: {
      id: true,
      printerId: true,
      jobName: true,
      fileId: true,
      fileName: true,
      fileSizeBytes: true,
      plate: true,
      useAms: true,
      bedLevel: true,
      amsMapping: true,
      sourceType: true,
      thumbnailPath: true,
      snapshotPath: true
    }
  })
  const existingJobByPrinterAndName = new Map(
    existingJobs.map((job) => [`${job.printerId}\u0000${job.jobName}`, job] as const)
  )

  for (const job of buildDemoFinishedJobSeeds(Date.now(), demoFileNames)) {
    const printer = printersBySerial.get(job.printerSerial)
    const file = fileByName.get(job.fileName) ?? findDemoLibraryFile(files, job.fileName)
    if (!printer) continue

    const data = {
      tenantId,
      printerId: printer.id,
      jobName: job.jobName,
      fileId: file?.id ?? null,
      fileName: file?.name ?? job.fileName,
      fileSizeBytes: file?.sizeBytes ?? null,
      plate: job.plate,
      useAms: job.useAms,
      bedLevel: job.bedLevel,
      amsMapping: job.amsMapping ? JSON.stringify(job.amsMapping) : null,
      progressPercent: job.progressPercent,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      durationSeconds: job.durationSeconds,
      result: job.result,
      filamentUsedGrams: job.filamentUsedGrams,
      filamentUsedMeters: job.filamentUsedMeters
    }
    const existing = existingJobByPrinterAndName.get(`${printer.id}\u0000${job.jobName}`)
    if (existing) {
      await rootPrisma.printJob.update({
        where: { id: existing.id },
        data
      })
      if (!existing.thumbnailPath && file) {
        await persistDemoLibraryThumbnail(existing.id, file.storedPath, job.plate)
      }
      if (!existing.snapshotPath) {
        await persistDemoFinishedSnapshot(existing.id, printer.serial, job.fileName)
      }
      continue
    }

    const created = await rootPrisma.printJob.create({ data })
    if (file) {
      await persistDemoLibraryThumbnail(created.id, file.storedPath, job.plate)
    }
    await persistDemoFinishedSnapshot(created.id, printer.serial, job.fileName)
  }

  for (const job of existingJobs) {
    if (job.sourceType !== 'library') continue
    if (job.fileId && job.fileName && job.fileSizeBytes != null && job.plate != null && job.thumbnailPath) continue

    const printer = printersById.get(job.printerId)
    if (!printer) continue

    const playlistJob = findDemoPlaylistJob(printer.serial, job.jobName)
    if (!playlistJob) continue

    const file = fileByName.get(playlistJob.fileName) ?? findDemoLibraryFile(files, playlistJob.fileName)
    if (!file) continue

    await rootPrisma.printJob.update({
      where: { id: job.id },
      data: {
        fileId: job.fileId ?? file.id,
        fileName: job.fileName ?? file.name,
        fileSizeBytes: job.fileSizeBytes ?? file.sizeBytes,
        plate: job.plate ?? playlistJob.plate,
        useAms: job.useAms ?? playlistJob.useAms,
        bedLevel: job.bedLevel ?? true,
        amsMapping: job.amsMapping ?? (playlistJob.amsMapping ? JSON.stringify(playlistJob.amsMapping) : null)
      }
    })

    if (!job.thumbnailPath) {
      await persistDemoLibraryThumbnail(job.id, file.storedPath, job.plate ?? playlistJob.plate)
    }
    if (!job.snapshotPath) {
      await persistDemoFinishedSnapshot(job.id, printer.serial, file.storedPath)
    }
  }

  await syncSeededActiveDemoJobs({
    tenantId,
    printers: seedablePrinters,
    files
  })
  await pruneStaleSeededDemoJobRemnants({
    tenantId,
    printerIds: printers.map((printer) => printer.id)
  })
  await rebuildSeededDemoStats({
    tenantId,
    printerIds: printers.map((printer) => printer.id)
  })
}

async function rebuildSeededDemoStats(input: { tenantId: string; printerIds: string[] }): Promise<void> {
  if (input.printerIds.length === 0) return

  const jobs = await rootPrisma.printJob.findMany({
    where: {
      tenantId: input.tenantId,
      printerId: { in: input.printerIds },
      finishedAt: { not: null },
      result: { in: ['success', 'failed', 'cancelled'] }
    },
    select: {
      result: true,
      durationSeconds: true,
      filamentUsedGrams: true,
      filamentUsedMeters: true,
      printer: { select: { serial: true } }
    }
  })

  const tenantRollup = createEmptyDemoStatsRollup()
  const printerRollups = new Map<string, DemoStatsRollup>()

  for (const job of jobs) {
    const printerSerial = job.printer?.serial
    if (!printerSerial) continue

    addDemoStatsJob(tenantRollup, job)
    const printerRollup = printerRollups.get(printerSerial) ?? createEmptyDemoStatsRollup()
    addDemoStatsJob(printerRollup, job)
    printerRollups.set(printerSerial, printerRollup)
  }

  await rootPrisma.tenantStats.upsert({
    where: { tenantId: input.tenantId },
    create: { tenantId: input.tenantId, ...tenantRollup },
    update: tenantRollup
  })

  for (const seed of DEMO_PRINTER_SEEDS) {
    const rollup = printerRollups.get(seed.serial) ?? createEmptyDemoStatsRollup()
    await rootPrisma.printerStats.upsert({
      where: {
        tenantId_printerSerial: {
          tenantId: input.tenantId,
          printerSerial: seed.serial
        }
      },
      create: {
        tenantId: input.tenantId,
        printerSerial: seed.serial,
        ...rollup
      },
      update: rollup
    })
  }
}

function createEmptyDemoStatsRollup(): DemoStatsRollup {
  return {
    totalPrints: 0,
    successfulPrints: 0,
    failedPrints: 0,
    cancelledPrints: 0,
    successfulPrintDurationSeconds: 0,
    failedPrintDurationSeconds: 0,
    cancelledPrintDurationSeconds: 0,
    wastedPrintDurationSeconds: 0,
    trackedFilamentPrints: 0,
    filamentUsedGrams: 0,
    successfulFilamentUsedGrams: 0,
    failedFilamentUsedGrams: 0,
    cancelledFilamentUsedGrams: 0,
    wastedFilamentUsedGrams: 0,
    filamentUsedMeters: 0,
    successfulFilamentUsedMeters: 0,
    failedFilamentUsedMeters: 0,
    cancelledFilamentUsedMeters: 0,
    wastedFilamentUsedMeters: 0
  }
}

function addDemoStatsJob(
  rollup: DemoStatsRollup,
  job: { result: string; durationSeconds: number | null; filamentUsedGrams: unknown; filamentUsedMeters: unknown }
): void {
  const durationSeconds = job.durationSeconds ?? 0
  const filamentUsedGrams = toDemoStatsNumber(job.filamentUsedGrams)
  const filamentUsedMeters = toDemoStatsNumber(job.filamentUsedMeters)
  const trackedFilament = filamentUsedGrams != null || filamentUsedMeters != null

  rollup.totalPrints += 1
  if (trackedFilament) rollup.trackedFilamentPrints += 1
  rollup.filamentUsedGrams += filamentUsedGrams ?? 0
  rollup.filamentUsedMeters += filamentUsedMeters ?? 0

  if (job.result === 'success') {
    rollup.successfulPrints += 1
    rollup.successfulPrintDurationSeconds += durationSeconds
    rollup.successfulFilamentUsedGrams += filamentUsedGrams ?? 0
    rollup.successfulFilamentUsedMeters += filamentUsedMeters ?? 0
    return
  }

  if (job.result === 'failed') {
    rollup.failedPrints += 1
    rollup.failedPrintDurationSeconds += durationSeconds
    rollup.wastedPrintDurationSeconds += durationSeconds
    rollup.failedFilamentUsedGrams += filamentUsedGrams ?? 0
    rollup.wastedFilamentUsedGrams += filamentUsedGrams ?? 0
    rollup.failedFilamentUsedMeters += filamentUsedMeters ?? 0
    rollup.wastedFilamentUsedMeters += filamentUsedMeters ?? 0
    return
  }

  if (job.result === 'cancelled') {
    rollup.cancelledPrints += 1
    rollup.cancelledPrintDurationSeconds += durationSeconds
    rollup.wastedPrintDurationSeconds += durationSeconds
    rollup.cancelledFilamentUsedGrams += filamentUsedGrams ?? 0
    rollup.wastedFilamentUsedGrams += filamentUsedGrams ?? 0
    rollup.cancelledFilamentUsedMeters += filamentUsedMeters ?? 0
    rollup.wastedFilamentUsedMeters += filamentUsedMeters ?? 0
  }
}

function toDemoStatsNumber(value: unknown): number | null {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function buildDemoFilamentUsage(printerSerial: string, fileName: string, index: number): { grams: number; meters: number } {
  const normalizedName = normalizeDemoLibraryDisplayName(path.basename(fileName)).toLowerCase()
  const base = normalizedName.includes('rail mount')
    ? { grams: 64.5, meters: 21.4 }
    : normalizedName.includes('card holder')
      ? { grams: 41.8, meters: 13.7 }
      : normalizedName.includes('tire rotation')
        ? { grams: 22.2, meters: 7.2 }
        : normalizedName.includes('number plates')
          ? { grams: 18.4, meters: 6.1 }
          : { grams: 32.5, meters: 10.6 }
  const serialOffset = (Math.abs(hashSeededDemoValue(printerSerial)) % 9) / 10
  const indexOffset = index * 0.35

  return {
    grams: Number((base.grams + serialOffset + indexOffset).toFixed(3)),
    meters: Number((base.meters + (serialOffset / 3) + (indexOffset / 4)).toFixed(3))
  }
}

async function resolveDemoTenantId(): Promise<string | null> {
  const demoTenant = await rootPrisma.tenant.findUnique({
    where: { slug: PUBLIC_DEMO_TENANT_SLUG },
    select: { id: true }
  })
  if (demoTenant) return demoTenant.id

  const tenant = await rootPrisma.tenant.findFirst({
    orderBy: { createdAt: 'asc' },
    select: { id: true }
  })
  return tenant?.id ?? null
}

async function resolveDemoBridgeId(tenantId: string): Promise<string | null> {
  const bridge = await rootPrisma.bridge.findFirst({
    where: {
      tenantId,
      OR: [
        { id: 'demo-simulator-bridge' },
        { name: 'PrintStream Demo Bridge' }
      ]
    },
    select: { id: true }
  })
  return bridge?.id ?? null
}

export async function pruneSeededDemoData(): Promise<{ printersRemoved: number; thumbnailsRemoved: number }> {
  const tenantId = await resolveDemoTenantId()
  if (!tenantId) {
    return { printersRemoved: 0, thumbnailsRemoved: 0 }
  }

  const demoSerials = DEMO_PRINTER_SEEDS.map((seed) => seed.serial)
  if (demoSerials.length === 0) {
    return { printersRemoved: 0, thumbnailsRemoved: 0 }
  }

  const jobs = await rootPrisma.printJob.findMany({
    where: {
      tenantId,
      printer: { serial: { in: demoSerials } },
      OR: [
        { thumbnailPath: { not: null } },
        { snapshotPath: { not: null } }
      ]
    },
    select: { thumbnailPath: true, snapshotPath: true }
  })

  let thumbnailsRemoved = 0
  for (const job of jobs) {
    if (!job.thumbnailPath) continue
    await deletePrintJobThumbnail(job.thumbnailPath)
    thumbnailsRemoved += 1
  }
  for (const job of jobs) {
    if (!job.snapshotPath) continue
    await deletePrintJobSnapshot(job.snapshotPath)
  }

  const result = await rootPrisma.printer.deleteMany({
    where: {
      tenantId,
      serial: { in: demoSerials }
    }
  })

  return {
    printersRemoved: result.count,
    thumbnailsRemoved
  }
}

export async function resolveDemoLibraryFile(displayName: string): Promise<(DemoLibraryFileMatch & { localPath: string }) | null> {
  const tenantId = await resolveDemoTenantId()
  if (!tenantId) return null

  const files = await rootPrisma.libraryFile.findMany({
    where: { tenantId, hidden: false },
    select: {
      id: true,
      name: true,
      sizeBytes: true,
      storedPath: true,
      ownerBridgeId: true
    }
  })
  const file = findDemoLibraryFile(files, displayName)
  if (!file) return null

  try {
    const localPath = await resolveLibraryFileToLocalPath(file)
    return { ...file, localPath }
  } catch {
    return null
  }
}

export async function findDemoLibraryLocalPath(displayName: string): Promise<string | null> {
  const entries = await readdir(demoLibraryDir, { withFileTypes: true }).catch(() => [])
  const fileNames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
  const matched = findDemoLibraryEntryName(fileNames, displayName)
  return matched ? path.join(demoLibraryDir, matched) : null
}

export function normalizeDemoLibraryDisplayName(fileName: string): string {
  return fileName.replace(/^[^-]+-/, '')
}

export function resolveDemoLibraryDir(inputPath: string): string {
  if (path.isAbsolute(inputPath)) return inputPath
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const workspaceRoot = path.resolve(moduleDir, '../../../../../')
  return path.resolve(workspaceRoot, inputPath)
}

function formatDemoJobName(fileName: string): string {
  return normalizeDemoLibraryDisplayName(fileName)
    .replace(/\.(gcode(?:\.3mf)?|3mf)$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function syncSeededActiveDemoJobs(input: {
  tenantId: string
  printers: DemoSeedablePrinter[]
  files: Array<{
    id: string
    name: string
    storedPath: string
    sizeBytes: number
  }>
}): Promise<void> {
  const seededJobs = await buildSeededActiveDemoJobs(input.printers, input.files)
  const activePrinters = input.printers.map((printer) => printer.id)
  if (activePrinters.length === 0) return

  const existingActiveJobs = await rootPrisma.printJob.findMany({
    where: {
      tenantId: input.tenantId,
      printerId: { in: activePrinters },
      finishedAt: null
    },
    select: {
      id: true,
      printerId: true,
      taskId: true,
      thumbnailPath: true
    }
  })

  const existingByPrinterTask = new Map<string, { id: string; printerId: string; taskId: string | null; thumbnailPath: string | null }>(
    existingActiveJobs.map((job) => [`${job.printerId}\u0000${job.taskId ?? ''}`, job] as const)
  )
  const retainedIds = new Set<string>()

  for (const job of seededJobs) {
    const key = `${job.printerId}\u0000${job.taskId}`
    const data = {
      tenantId: input.tenantId,
      printerId: job.printerId,
      taskId: job.taskId,
      jobName: job.jobName,
      fileId: job.fileId,
      fileName: job.fileName,
      fileSizeBytes: job.fileSizeBytes,
      plate: job.plate,
      useAms: job.useAms,
      bedLevel: job.bedLevel,
      amsMapping: job.amsMapping ? JSON.stringify(job.amsMapping) : null,
      startedAt: job.startedAt,
      finishedAt: null,
      progressPercent: null,
      durationSeconds: null,
      sourceType: 'library' as const,
      result: 'unknown' as const
    }
    const existing = existingByPrinterTask.get(key)
    if (existing) {
      retainedIds.add(existing.id)
      await rootPrisma.printJob.update({
        where: { id: existing.id },
        data
      })
      if (!existing.thumbnailPath) {
        await persistDemoLibraryThumbnail(existing.id, job.fileStoredPath, job.plate)
      }
      continue
    }

    const created = await rootPrisma.printJob.create({ data })
    retainedIds.add(created.id)
    await persistDemoLibraryThumbnail(created.id, job.fileStoredPath, job.plate)
  }

  const staleIds = existingActiveJobs
    .filter((job) => !retainedIds.has(job.id))
    .map((job) => job.id)
  if (staleIds.length > 0) {
    await rootPrisma.printJob.deleteMany({
      where: { id: { in: staleIds } }
    })
  }
}

async function pruneStaleSeededDemoJobRemnants(input: {
  tenantId: string
  printerIds: string[]
}): Promise<void> {
  if (input.printerIds.length === 0) return

  await rootPrisma.printJob.deleteMany({
    where: {
      tenantId: input.tenantId,
      printerId: { in: input.printerIds },
      taskId: { startsWith: 'demo-task-' },
      finishedAt: { not: null },
      result: 'unknown',
      progressPercent: null,
      durationSeconds: null
    }
  })
}

async function buildSeededActiveDemoJobs(
  printers: DemoSeedablePrinter[],
  files: Array<{
    id: string
    name: string
    storedPath: string
    sizeBytes: number
  }>
): Promise<DemoSeededActiveJob[]> {
  const compatibilityByStoredPath = new Map<string, readonly PrinterModel[] | null | undefined>()
  const platesByStoredPath = new Map<string, readonly number[]>()

  for (const file of files) {
    const onDisk = path.join(demoLibraryDir, path.basename(file.storedPath))
    const index = await readPlateIndex(onDisk).catch(() => null)
    compatibilityByStoredPath.set(file.storedPath, index?.compatiblePrinterModels)
    platesByStoredPath.set(
      file.storedPath,
      Array.from(new Set(index?.plates.map((plate) => plate.index).filter((plate) => plate > 0) ?? []))
    )
  }

  const seededJobs: DemoSeededActiveJob[] = []
  for (const printer of printers) {
    const seed = DEMO_PRINTER_SEEDS.find((entry) => entry.serial === printer.serial)
    if (!seed || (seed.scenario !== 'printing' && seed.scenario !== 'paused')) {
      continue
    }

    const activeJob = getDemoPrinterActiveJob(printer.serial)
    const file = chooseSeededDemoLibraryFileForPrinter(printer, files, compatibilityByStoredPath)
    if (!file) continue

    const preferredPlate = activeJob?.fileName === path.basename(file.storedPath)
      ? activeJob.plate
      : null
    const plate = chooseSeededDemoPrintPlate(file.storedPath, platesByStoredPath.get(file.storedPath) ?? [], preferredPlate)
    const taskId = buildSeededDemoTaskId(printer.serial, path.basename(file.storedPath), plate)
    const position = printer.position ?? 0
    seededJobs.push({
      printerId: printer.id,
      printerSerial: printer.serial,
      taskId,
      jobName: formatDemoJobName(file.storedPath),
      fileId: file.id,
      fileName: file.name,
      fileStoredPath: file.storedPath,
      fileSizeBytes: file.sizeBytes,
      plate,
      useAms: activeJob?.useAms ?? true,
      bedLevel: activeJob?.bedLevel ?? true,
      amsMapping: activeJob?.amsMapping ?? [0],
      startedAt: new Date(Date.now() - ((position + 1) * 11 * 60_000))
    })
  }

  return seededJobs
}

function chooseSeededDemoLibraryFileForPrinter(
  printer: Pick<DemoSeedablePrinter, 'serial' | 'model'>,
  files: Array<{ id: string; name: string; storedPath: string; sizeBytes: number }>,
  compatibilityByStoredPath: ReadonlyMap<string, readonly PrinterModel[] | null | undefined>
): { id: string; name: string; storedPath: string; sizeBytes: number } | null {
  const activeJob = getDemoPrinterActiveJob(printer.serial)
  if (activeJob) {
    const preferredFile = files.find((file) => path.basename(file.storedPath) === activeJob.fileName)
    if (preferredFile) {
      return preferredFile
    }
  }

  const compatibleFiles = files.filter((file) => isPrinterModelCompatible(compatibilityByStoredPath.get(file.storedPath), printer.model))
  const candidates = compatibleFiles.length > 0 ? compatibleFiles : files
  if (candidates.length === 0) return null

  const index = Math.abs(hashSeededDemoValue(printer.serial)) % candidates.length
  return candidates[index] ?? candidates[0] ?? null
}

function chooseSeededDemoPrintPlate(fileName: string, availablePlates: readonly number[], preferredPlate: number | null = null): number {
  if (preferredPlate != null && availablePlates.includes(preferredPlate)) {
    return preferredPlate
  }

  if (availablePlates.length <= 1) {
    return availablePlates[0] ?? 1
  }

  if (shouldPreferSecondSeededDemoPlate(fileName) && availablePlates.includes(2)) {
    return 2
  }

  const index = Math.abs(hashSeededDemoValue(path.basename(fileName))) % availablePlates.length
  return availablePlates[index] ?? availablePlates[0] ?? 1
}

function shouldPreferSecondSeededDemoPlate(fileName: string): boolean {
  const normalizedName = normalizeDemoLibraryDisplayName(path.basename(fileName)).toLowerCase()
  return normalizedName.includes('card_holder') || normalizedName.includes('card holder')
}

function buildSeededDemoTaskId(printerSerial: string, fileName: string, selectedPlate: number | null): string {
  return `demo-task-${printerSerial}-${fileName}${selectedPlate ? `-plate-${selectedPlate}` : ''}`
}

function hashSeededDemoValue(value: string): number {
  let hash = 0
  for (const char of value) {
    hash = ((hash << 5) - hash) + char.charCodeAt(0)
    hash |= 0
  }
  return hash
}

async function persistDemoLibraryThumbnail(jobId: string, storedPath: string, plate: number): Promise<void> {
  try {
    const onDisk = path.join(demoLibraryDir, path.basename(storedPath))
    const index = await readPlateIndex(onDisk).catch(() => null)
    const entryPath = index?.plates.find((entry) => entry.index === plate)?.thumbnailFile
      ?? index?.plates[0]?.thumbnailFile
      ?? `Metadata/plate_${plate}.png`
    const png = await readEntry(onDisk, entryPath).catch(() => null)
    if (!png) return

    const thumbnailPath = await savePrintJobThumbnail(jobId, png)
    await rootPrisma.printJob.update({
      where: { id: jobId },
      data: { thumbnailPath }
    })
  } catch {
    // Demo history can still fall back to the library thumbnail route when available.
  }
}

async function persistDemoFinishedSnapshot(jobId: string, printerSerial: string, fileName?: string): Promise<void> {
  try {
    const sourcePath = await resolveDemoFinishedSnapshotSourcePath(printerSerial, fileName)
    if (!sourcePath) return
    const image = await readFile(sourcePath)
    const snapshotPath = await savePrintJobSnapshot(jobId, image)
    await rootPrisma.printJob.update({
      where: { id: jobId },
      data: { snapshotPath }
    })
  } catch {
    // Demo history can omit a final snapshot when bundled demo media is unavailable.
  }
}

async function resolveDemoFinishedSnapshotSourcePath(printerSerial: string, fileName?: string): Promise<string | null> {
  const definition = findDemoPrintDefinitionByFileName(fileName)
  const captureDirectoryName = definition?.media?.captureDirectoryName
  if (captureDirectoryName) {
    const captureEntries = await readdir(path.join(demoCaptureDir, captureDirectoryName), { withFileTypes: true }).catch(() => [])
    const firstSnapshot = captureEntries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((entry) => entry.toLowerCase().endsWith('.jpg') || entry.toLowerCase().endsWith('.jpeg'))
      .sort((left, right) => left.localeCompare(right))[0]
    if (firstSnapshot) {
      return path.join(demoCaptureDir, captureDirectoryName, firstSnapshot)
    }
  }

  return path.join(demoFinishedSnapshotDir, selectDemoFinishedSnapshotName(printerSerial))
}

export function selectDemoFinishedSnapshotName(printerSerial: string): string {
  if (printerSerial.includes('X1C')) {
    return 'chamber-blue-bin.jpg'
  }
  if (printerSerial.includes('H2D')) {
    return 'chamber-green-bin.jpg'
  }
  if (printerSerial.includes('P1S')) {
    return 'chamber-purple-part.jpg'
  }

  const seedIndex = DEMO_PRINTER_SEEDS.findIndex((seed) => seed.serial === printerSerial)
  const normalizedIndex = seedIndex >= 0 ? seedIndex : 0
  return DEMO_FINISHED_JOB_SNAPSHOT_FILES[normalizedIndex % DEMO_FINISHED_JOB_SNAPSHOT_FILES.length]
    ?? DEMO_FINISHED_JOB_SNAPSHOT_FILES[0]
    ?? 'chamber-blue-bin.jpg'
}
