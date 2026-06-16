/// <reference types="node" />

/**
 * Capture live printer media for demo assets.
 *
 * Pulls a stored printer record from Prisma, saves one or more camera
 * snapshots, and optionally records a short MP4 clip from the live stream.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import path from 'path'
import { once } from 'events'
import { spawn } from 'child_process'
import process from 'process'
import { tmpdir } from 'os'
import { PrismaClient } from '@prisma/client'
import { fetchSnapshot, streamFrames } from '../../packages/bridge-runtime/src/camera.ts'

interface CaptureOptions {
  printerName: string
  snapshotCount: number
  snapshotIntervalSec: number
  clipSec: number
  outputDir: string
}

function parseArgs(argv: string[]): CaptureOptions {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg?.startsWith('--')) continue
    const key = arg.slice(2)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`)
    }
    values.set(key, value)
    index += 1
  }

  const printerName = values.get('printer')?.trim()
  if (!printerName) {
    throw new Error('Missing required --printer <name> argument')
  }

  const snapshotCount = parsePositiveInteger(values.get('snapshot-count') ?? '6', 'snapshot-count')
  const snapshotIntervalSec = parsePositiveInteger(values.get('snapshot-interval-sec') ?? '120', 'snapshot-interval-sec')
  const clipSec = parseNonNegativeInteger(values.get('clip-sec') ?? '20', 'clip-sec')
  const outputDir = path.resolve(values.get('output-dir') ?? defaultOutputDir(printerName))

  return {
    printerName,
    snapshotCount,
    snapshotIntervalSec,
    clipSec,
    outputDir
  }
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${label} must be a positive integer`)
  }
  return parsed
}

function parseNonNegativeInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--${label} must be a non-negative integer`)
  }
  return parsed
}

function defaultOutputDir(printerName: string): string {
  return path.join('data', 'demo-captures', slugify(printerName), formatTimestamp(new Date()))
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'printer'
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function captureSnapshot(printer: { name: string }, filePath: string): Promise<void> {
  const buffer = await fetchSnapshot(printer as never)
  await writeFile(filePath, buffer)
  console.log(`Saved snapshot ${filePath}`)
}

async function captureClip(printer: { name: string }, clipPath: string, clipSec: number): Promise<void> {
  if (clipSec <= 0) return
  const framesDir = await mkdtemp(path.join(tmpdir(), 'printstream-camera-clip-'))
  const capturedFrames: string[] = []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), clipSec * 1000)
  try {
    let frameIndex = 0
    for await (const frame of streamFrames(printer as never, controller.signal)) {
      frameIndex += 1
      const framePath = path.join(framesDir, `frame-${String(frameIndex).padStart(6, '0')}.jpg`)
      await writeFile(framePath, frame)
      capturedFrames.push(framePath)
    }
  } catch (error) {
    if ((error as Error).name !== 'AbortError') {
      throw error
    }
  } finally {
    clearTimeout(timer)
  }

  if (capturedFrames.length === 0) {
    await rm(framesDir, { recursive: true, force: true })
    throw new Error('No stream frames were captured for the requested clip.')
  }

  const concatPath = path.join(framesDir, 'frames.txt')
  const perFrameDurationSec = Math.max(0.04, clipSec / capturedFrames.length)
  const concatLines: string[] = []
  for (const framePath of capturedFrames) {
    concatLines.push(`file '${escapeConcatPath(framePath)}'`)
    concatLines.push(`duration ${perFrameDurationSec.toFixed(6)}`)
  }
  concatLines.push(`file '${escapeConcatPath(capturedFrames[capturedFrames.length - 1] ?? '')}'`)
  await writeFile(concatPath, concatLines.join('\n') + '\n')

  try {
    await runFfmpeg([
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatPath,
      '-an',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      clipPath
    ])
  } finally {
    await rm(framesDir, { recursive: true, force: true })
  }

  console.log(`Saved clip ${clipPath}`)
}

function escapeConcatPath(filePath: string): string {
  return filePath.replace(/'/g, "'\\''")
}

async function runFfmpeg(args: string[]): Promise<void> {
  const ffmpeg = spawn('ffmpeg', args, {
    stdio: ['ignore', 'inherit', 'pipe']
  })

  let stderr = ''
  ffmpeg.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })

  const [exitCode] = await once(ffmpeg, 'close') as [number | null]
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `ffmpeg exited with code ${exitCode}`)
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  await mkdir(options.outputDir, { recursive: true })

  const prisma = new PrismaClient()
  try {
    const printer = await prisma.printer.findFirst({
      where: { name: options.printerName }
    })
    if (!printer) {
      throw new Error(`Printer not found: ${options.printerName}`)
    }

    console.log(`Capturing media for ${printer.name} (${printer.model}) into ${options.outputDir}`)

    const firstSnapshotPath = path.join(options.outputDir, `${formatTimestamp(new Date())}-snapshot-01.jpg`)
    await captureSnapshot(printer, firstSnapshotPath)

    if (options.clipSec > 0) {
      const clipPath = path.join(options.outputDir, `${formatTimestamp(new Date())}-stream.mp4`)
      await captureClip(printer, clipPath, options.clipSec)
    }

    for (let index = 1; index < options.snapshotCount; index += 1) {
      await delay(options.snapshotIntervalSec * 1000)
      const snapshotPath = path.join(options.outputDir, `${formatTimestamp(new Date())}-snapshot-${String(index + 1).padStart(2, '0')}.jpg`)
      await captureSnapshot(printer, snapshotPath)
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})