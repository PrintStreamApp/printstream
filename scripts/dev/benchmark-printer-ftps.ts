/// <reference types="node" />

/**
 * Benchmark FTPS upload profiles against real printers.
 *
 * Generates a local test artifact, uploads it to each named printer with
 * several transport profiles, deletes the remote test file after each run,
 * and writes a JSON report under `tmp/ftps-benchmarks/` by default.
 */
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { tmpdir } from 'node:os'
import { PrismaClient } from '@prisma/client'
import type { Printer } from '@printstream/shared'
import {
  benchmarkUploadFileToPrinterPath,
  deletePrinterFile,
  type PrinterFtpTransportSettings,
} from '../../packages/bridge-runtime/src/printer-ftp.ts'

interface PrismaPrinterRecord {
  id: string
  name: string
  host: string
  accessCode: string
  serial: string | null
  model: string
  position: number
  createdAt: Date
  updatedAt: Date
}

interface CliOptions {
  printerNames: string[]
  fileSizeMb: number
  iterations: number
  profileNames: string[] | null
  outputPath: string
}

interface BenchmarkProfile {
  name: string
  description: string
  transport: PrinterFtpTransportSettings
}

interface UploadRunResult {
  printerName: string
  printerModel: string
  profileName: string
  iteration: number
  fileSizeBytes: number
  elapsedMs: number
  connectMs: number | null
  uploadMs: number | null
  throughputMiBps: number
  uploadThroughputMiBps: number
  bytesReported: number
  error: string | null
}

interface PrinterSummary {
  printerName: string
  printerModel: string
  bestProfileName: string
  bestAverageMiBps: number
  bestAverageUploadMiBps: number
  successCount: number
  failureCount: number
}

const DEFAULT_OUTPUT_DIR = path.resolve('tmp', 'ftps-benchmarks')

const BENCHMARK_PROFILES: readonly BenchmarkProfile[] = [
  {
    name: 'baseline',
    description: 'Current production FTPS settings.',
    transport: {}
  },
  {
    name: 'nodelay-256k',
    description: 'Enable TCP_NODELAY and raise the upload read buffer to 256 KiB.',
    transport: {
      socketNoDelay: true,
      uploadReadHighWaterMarkBytes: 256 * 1024
    }
  },
  {
    name: 'nodelay-1m',
    description: 'Enable TCP_NODELAY and raise the upload read buffer to 1 MiB.',
    transport: {
      socketNoDelay: true,
      uploadReadHighWaterMarkBytes: 1024 * 1024
    }
  },
  {
    name: 'nodelay-1m-keepalive',
    description: 'Enable TCP_NODELAY, 1 MiB upload buffering, and socket keepalive.',
    transport: {
      socketNoDelay: true,
      socketKeepAlive: true,
      socketKeepAliveInitialDelayMs: 1_000,
      uploadReadHighWaterMarkBytes: 1024 * 1024
    }
  }
] as const

function parseArgs(argv: string[]): CliOptions {
  const values = new Map<string, string[]>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg?.startsWith('--')) continue
    const key = arg.slice(2)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`)
    }
    const existing = values.get(key) ?? []
    existing.push(value)
    values.set(key, existing)
    index += 1
  }

  const printerNames = values.get('printer')?.map((value) => value.trim()).filter(Boolean) ?? []
  if (printerNames.length === 0) {
    throw new Error('Missing required --printer <name> argument. Repeat --printer for multiple printers.')
  }

  const fileSizeMb = parsePositiveInteger(values.get('file-size-mb')?.at(-1) ?? '32', 'file-size-mb')
  const iterations = parsePositiveInteger(values.get('iterations')?.at(-1) ?? '2', 'iterations')
  const profileNames = values.get('profile')?.map((value) => value.trim()).filter(Boolean) ?? null
  const outputPath = path.resolve(values.get('output')?.at(-1) ?? defaultOutputPath())

  return {
    printerNames,
    fileSizeMb,
    iterations,
    profileNames,
    outputPath
  }
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${label} must be a positive integer`)
  }
  return parsed
}

function defaultOutputPath(): string {
  return path.join(DEFAULT_OUTPUT_DIR, `ftps-benchmark-${formatTimestamp(new Date())}.json`)
}

function formatTimestamp(value: Date): string {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  const hours = String(value.getHours()).padStart(2, '0')
  const minutes = String(value.getMinutes()).padStart(2, '0')
  const seconds = String(value.getSeconds()).padStart(2, '0')
  return `${year}${month}${day}-${hours}${minutes}${seconds}`
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'printer'
}

function normalizeLookup(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function toMiBPerSecond(bytes: number, elapsedMs: number): number {
  if (elapsedMs <= 0) return 0
  return bytes / 1024 / 1024 / (elapsedMs / 1000)
}

function pickProfiles(profileNames: string[] | null): BenchmarkProfile[] {
  if (!profileNames || profileNames.length === 0) {
    return [...BENCHMARK_PROFILES]
  }
  const requested = new Set(profileNames)
  const selected = BENCHMARK_PROFILES.filter((profile) => requested.has(profile.name))
  if (selected.length !== requested.size) {
    const missing = [...requested].filter((name) => !selected.some((profile) => profile.name === name))
    throw new Error(`Unknown --profile value(s): ${missing.join(', ')}`)
  }
  return selected
}

async function ensureBenchmarkArtifact(filePath: string, sizeBytes: number): Promise<void> {
  const existing = await stat(filePath).catch(() => null)
  if (existing && existing.size === sizeBytes) return

  await mkdir(path.dirname(filePath), { recursive: true })
  const stream = createWriteStream(filePath)
  const chunk = Buffer.alloc(1024 * 1024, 0x5a)
  let remaining = sizeBytes

  await new Promise<void>((resolve, reject) => {
    stream.on('error', reject)
    stream.on('finish', resolve)

    const writeNext = (): void => {
      while (remaining > 0) {
        const size = Math.min(chunk.byteLength, remaining)
        const buffer = size === chunk.byteLength ? chunk : chunk.subarray(0, size)
        remaining -= size
        if (!stream.write(buffer)) {
          stream.once('drain', writeNext)
          return
        }
      }
      stream.end()
    }

    writeNext()
  })
}

function toSharedPrinter(record: PrismaPrinterRecord): Printer {
  return {
    id: record.id,
    name: record.name,
    host: record.host,
    serial: record.serial ?? '',
    accessCode: record.accessCode,
    model: record.model as Printer['model'],
    currentPlateType: null,
    currentNozzleDiameters: [],
    position: record.position,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString()
  }
}

function resolveRequestedPrinters(
  requestedNames: string[],
  printerRecords: PrismaPrinterRecord[]
): PrismaPrinterRecord[] {
  const resolved: PrismaPrinterRecord[] = []
  const failures: string[] = []

  for (const requestedName of requestedNames) {
    const exact = printerRecords.find((printer) => printer.name === requestedName)
    if (exact) {
      resolved.push(exact)
      continue
    }

    const normalizedRequested = normalizeLookup(requestedName)
    const matches = printerRecords.filter((printer) => {
      const normalizedPrinterName = normalizeLookup(printer.name)
      return normalizedPrinterName === normalizedRequested
        || normalizedPrinterName.includes(normalizedRequested)
        || normalizedRequested.includes(normalizedPrinterName)
    })

    if (matches.length === 1) {
      resolved.push(matches[0])
      continue
    }

    if (matches.length > 1) {
      failures.push(`${requestedName} (ambiguous: ${matches.map((printer) => printer.name).join(', ')})`)
      continue
    }

    failures.push(requestedName)
  }

  if (failures.length > 0) {
    throw new Error(`Printer(s) not found: ${failures.join('; ')}`)
  }

  return resolved
}

async function runUploadBenchmark(
  printer: Printer,
  profile: BenchmarkProfile,
  iteration: number,
  filePath: string,
  fileSizeBytes: number
): Promise<UploadRunResult> {
  const remotePath = `/.printstream-ftps-benchmark-${slugify(printer.name)}-${profile.name}-${iteration}-${Date.now()}.bin`
  let bytesReported = 0
  try {
    const result = await benchmarkUploadFileToPrinterPath(
      printer,
      filePath,
      remotePath,
      (bytesSent) => {
        bytesReported = bytesSent
      },
      {
        cooldownMs: 0,
        transport: profile.transport
      }
    )

    const finalBytesReported = Math.max(bytesReported, result.bytesSent)
    return {
      printerName: printer.name,
      printerModel: printer.model,
      profileName: profile.name,
      iteration,
      fileSizeBytes,
      elapsedMs: result.totalMs,
      connectMs: result.connectMs,
      uploadMs: result.uploadMs,
      throughputMiBps: toMiBPerSecond(fileSizeBytes, result.totalMs),
      uploadThroughputMiBps: toMiBPerSecond(fileSizeBytes, result.uploadMs),
      bytesReported: finalBytesReported,
      error: null
    }
  } finally {
    await deletePrinterFile(printer, remotePath).catch(() => undefined)
  }
}

function summarizeRuns(runs: UploadRunResult[]): PrinterSummary[] {
  const byPrinter = new Map<string, UploadRunResult[]>()
  for (const run of runs) {
    const key = `${run.printerName}\u0000${run.printerModel}`
    const existing = byPrinter.get(key) ?? []
    existing.push(run)
    byPrinter.set(key, existing)
  }

  const summaries: PrinterSummary[] = []
  for (const [key, printerRuns] of byPrinter) {
    const [printerName, printerModel] = key.split('\u0000')
    const profileStats = new Map<string, {
      successCount: number
      failureCount: number
      totalThroughput: number
      uploadThroughput: number
    }>()

    for (const run of printerRuns) {
      const stats = profileStats.get(run.profileName) ?? {
        successCount: 0,
        failureCount: 0,
        totalThroughput: 0,
        uploadThroughput: 0
      }

      if (run.error == null) {
        stats.successCount += 1
        stats.totalThroughput += run.throughputMiBps
        stats.uploadThroughput += run.uploadThroughputMiBps
      } else {
        stats.failureCount += 1
      }

      profileStats.set(run.profileName, stats)
    }

    const best = [...profileStats.entries()]
      .map(([profileName, stats]) => ({
        profileName,
        successCount: stats.successCount,
        failureCount: stats.failureCount,
        averageMiBps: stats.successCount > 0 ? stats.totalThroughput / stats.successCount : 0,
        averageUploadMiBps: stats.successCount > 0 ? stats.uploadThroughput / stats.successCount : 0
      }))
      .sort((left, right) => {
        if (right.successCount !== left.successCount) return right.successCount - left.successCount
        if (left.failureCount !== right.failureCount) return left.failureCount - right.failureCount
        return right.averageMiBps - left.averageMiBps
      })[0]

    if (!best) continue
    summaries.push({
      printerName: printerName ?? 'Unknown printer',
      printerModel: printerModel ?? 'Unknown model',
      bestProfileName: best.profileName,
      bestAverageMiBps: best.averageMiBps,
      bestAverageUploadMiBps: best.averageUploadMiBps,
      successCount: best.successCount,
      failureCount: best.failureCount
    })
  }
  return summaries
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const profiles = pickProfiles(options.profileNames)
  await mkdir(path.dirname(options.outputPath), { recursive: true })

  const tempDir = await mkdtemp(path.join(tmpdir(), 'printstream-ftps-benchmark-'))
  const artifactPath = path.join(tempDir, `upload-${options.fileSizeMb}mb.bin`)
  const artifactBytes = options.fileSizeMb * 1024 * 1024
  await ensureBenchmarkArtifact(artifactPath, artifactBytes)

  const prisma = new PrismaClient()
  try {
    const printerRecords = await prisma.printer.findMany({
      select: {
        id: true,
        name: true,
        host: true,
        accessCode: true,
        serial: true,
        model: true,
        position: true,
        createdAt: true,
        updatedAt: true
      }
    })

    const resolvedPrinters = resolveRequestedPrinters(options.printerNames, printerRecords)
    const printers = resolvedPrinters.map(toSharedPrinter)

    console.log(`Benchmarking ${profiles.length} FTPS profile(s) against ${printers.length} printer(s) with a ${options.fileSizeMb} MiB artifact.`)

    const runs: UploadRunResult[] = []
    for (const printer of printers) {
      console.log(`\n${printer.name} (${printer.model})`)
      for (const profile of profiles) {
        console.log(`  ${profile.name}: ${profile.description}`)
        for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
          try {
            const result = await runUploadBenchmark(printer, profile, iteration, artifactPath, artifactBytes)
            runs.push(result)
            console.log(
              `    iteration ${iteration}: total ${result.elapsedMs.toFixed(0)} ms ` +
              `(connect ${result.connectMs?.toFixed(0) ?? 'n/a'} ms, upload ${result.uploadMs?.toFixed(0) ?? 'n/a'} ms), ` +
              `${result.throughputMiBps.toFixed(2)} MiB/s total, ${result.uploadThroughputMiBps.toFixed(2)} MiB/s upload, ` +
              `${result.bytesReported} bytes reported`
            )
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            runs.push({
              printerName: printer.name,
              printerModel: printer.model,
              profileName: profile.name,
              iteration,
              fileSizeBytes: artifactBytes,
              elapsedMs: 0,
              connectMs: null,
              uploadMs: null,
              throughputMiBps: 0,
              uploadThroughputMiBps: 0,
              bytesReported: 0,
              error: message
            })
            console.log(`    iteration ${iteration}: failed (${message})`)
          }
        }
      }
    }

    const summaries = summarizeRuns(runs)
    const report = {
      generatedAt: new Date().toISOString(),
      fileSizeBytes: artifactBytes,
      iterations: options.iterations,
      profiles,
      runs,
      summaries
    }

    await mkdir(path.dirname(options.outputPath), { recursive: true })
    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(options.outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
    )

    console.log(`\nBest profile by printer:`)
    for (const summary of summaries) {
      console.log(
        `  ${summary.printerName}: ${summary.bestProfileName} ` +
        `(${summary.successCount} success, ${summary.failureCount} failure) ` +
        `at ${summary.bestAverageMiBps.toFixed(2)} MiB/s total average ` +
        `and ${summary.bestAverageUploadMiBps.toFixed(2)} MiB/s upload average`
      )
    }
    console.log(`\nWrote benchmark report to ${options.outputPath}`)
  } finally {
    await prisma.$disconnect()
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})