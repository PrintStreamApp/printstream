/**
 * Resolve the printer-side 3MF archive backing a print cover image.
 */
import { extractObservedPrintPlateIndex, type Printer } from '@printstream/shared'
import path from 'node:path'
import { listPrinterDirectory, listPrinterDirectoryRecursive } from './printer-ftp.js'

const COVER_RECURSIVE_SKIP_DIRS: ReadonlySet<string> = new Set([
  'cam',
  'corelogger',
  'image',
  'upcam',
  'language',
  'logger',
  'recorder',
  'timelapse',
  'thumbnail'
])

export async function resolvePrinterCoverPath(
  printer: Printer,
  jobName: string,
  gcodeFile: string | null,
  options: { allowLatestFallback?: boolean } = {}
): Promise<string | null> {
  const requested = buildCoverCandidates(jobName, gcodeFile).map(toAbsolutePrinterPath)
  const available = new Set<string>()
  const needsNestedLookup = requested.some(requiresNestedCoverLookup)

  for (const dir of ['/', '/cache']) {
    const entries = await listPrinterDirectory(printer, dir).catch(() => [])
    for (const entry of entries) {
      if (entry.type !== 'file' || !/\.3mf$/i.test(entry.name)) continue
      available.add(dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`)
    }
  }

  if (needsNestedLookup) {
    const entries = await listPrinterDirectoryRecursive(printer, '/', 4, COVER_RECURSIVE_SKIP_DIRS).catch(() => [])
    for (const entry of entries) {
      if (entry.type !== 'file' || !entry.path || !/\.3mf$/i.test(entry.name)) continue
      available.add(entry.path)
    }
  }

  for (const candidate of requested) {
    if (available.has(candidate)) return candidate
  }

  const fuzzyMatch = findBestCoverPathMatch(available, jobName, gcodeFile)
  if (fuzzyMatch) return fuzzyMatch

  if (!options.allowLatestFallback) return null

  const latest = await findLatestPrinterThreeMf(printer)
  return latest
}

export function findBestCoverPathMatch(
  availablePaths: Iterable<string>,
  jobName: string,
  gcodeFile: string | null
): string | null {
  const available = Array.from(new Set(Array.from(availablePaths, (value) => toAbsolutePrinterPath(value))))
  const requested = buildCoverCandidates(jobName, gcodeFile).map(toAbsolutePrinterPath)
  for (const candidate of requested) {
    if (available.includes(candidate)) return candidate
  }

  const desiredPlate = extractObservedPrintPlateIndex(gcodeFile) ?? extractObservedPrintPlateIndex(jobName)
  const desiredBase = normalizeCoverMatchBase(jobName) || normalizeCoverMatchBase(gcodeFile)
  if (desiredPlate == null || !desiredBase) return null

  let bestPath: string | null = null
  let bestScore = 0
  for (const candidate of available) {
    if (extractObservedPrintPlateIndex(candidate) !== desiredPlate) continue
    const candidateBase = normalizeCoverMatchBase(candidate)
    const score = scoreCoverNameMatch(desiredBase, candidateBase)
    if (score <= bestScore) continue
    bestScore = score
    bestPath = candidate
  }

  return bestScore >= 80 ? bestPath : null
}

function buildCoverCandidates(jobName: string, gcodeFile: string | null): string[] {
  const names = new Set<string>()
  const addNameVariants = (value: string | null) => {
    if (!value) return
    const trimmed = value.trim().replace(/^file:\/\//, '').replace(/^\/+sdcard\//, '').replace(/^\/+/, '')
    if (!trimmed) return
    const archivePath = trimmed.replace(/\/Metadata\/[^/]+$/i, '')
    if (archivePath !== trimmed && /\.3mf$/i.test(archivePath)) {
      names.add(archivePath)
    }
    if (/(^|\/)metadata\//i.test(trimmed)) return
    names.add(trimmed)
    if (!/\.3mf$/i.test(trimmed)) names.add(`${trimmed}.3mf`)
    if (!/\.gcode\.3mf$/i.test(trimmed)) names.add(`${trimmed.replace(/\.gcode$/i, '')}.gcode.3mf`)
  }

  const addDerivedPrintArchiveVariants = () => {
    const plateIndex = extractObservedPrintPlateIndex(gcodeFile)
    if (plateIndex == null) return
    const plateMarker = ` - ${plateIndex} - `
    const splitIndex = jobName.lastIndexOf(plateMarker)
    if (splitIndex <= 0) return

    const base = jobName.slice(0, splitIndex).trim()
    const plateLabel = jobName.slice(splitIndex + 3).trim()
    if (!base || !plateLabel) return

    names.add(`${sanitizeLegacyRemoteName(base)}_${sanitizeLegacyRemoteName(plateLabel)}.gcode.3mf`)
    names.add(`${sanitizeCurrentRemoteArchiveName(base, plateLabel)}.gcode.3mf`)
  }

  addNameVariants(jobName)
  addNameVariants(gcodeFile)
  addDerivedPrintArchiveVariants()

  const candidates = new Set<string>()
  for (const name of names) {
    candidates.add(name)
    candidates.add(`/${name}`)
    if (!name.startsWith('cache/')) {
      candidates.add(`cache/${name}`)
      candidates.add(`/cache/${name}`)
    }
  }
  return Array.from(candidates)
}

async function findLatestPrinterThreeMf(printer: Printer): Promise<string | null> {
  const candidates = (await listPrinterDirectoryRecursive(printer, '/', 4, COVER_RECURSIVE_SKIP_DIRS).catch(() => []))
    .filter((entry) => entry.type === 'file' && entry.path && /\.3mf$/i.test(entry.name))
    .map((entry) => ({
      path: entry.path as string,
      modifiedAt: entry.modifiedAt
    }))
  candidates.sort((a, b) => (Date.parse(b.modifiedAt ?? '') || 0) - (Date.parse(a.modifiedAt ?? '') || 0))
  return candidates[0]?.path ?? null
}

function toAbsolutePrinterPath(rawPath: string): string {
  const trimmed = rawPath.trim().replace(/^\/+/, '')
  return trimmed.length === 0 ? '/' : `/${trimmed}`
}

function normalizeCoverMatchBase(value: string | null): string {
  if (!value) return ''
  const trimmed = value.trim()
    .replace(/^file:\/\//i, '')
    .replace(/^\/+sdcard\//i, '')
    .replace(/^\/+/, '')
    .replace(/\/Metadata\/[^/]+$/i, '')
  const baseName = path.posix.basename(trimmed)
    .replace(/\.(gcode\.3mf|3mf|gcode)$/i, '')
    .replace(/(?:^|[ _-])plate[_ -]?\d+(?:$|[ _.-])/gi, ' ')
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9. ]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
  return baseName
}

function scoreCoverNameMatch(desiredBase: string, candidateBase: string): number {
  if (!desiredBase || !candidateBase) return 0
  if (candidateBase === desiredBase) return 100
  if (candidateBase.startsWith(desiredBase) || desiredBase.startsWith(candidateBase)) return 90

  const desiredTokens = desiredBase.split(' ').filter(Boolean)
  const candidateTokens = candidateBase.split(' ').filter(Boolean)
  if (desiredTokens.length === 0 || candidateTokens.length === 0) return 0
  if (desiredTokens.every((token) => candidateTokens.includes(token))) return 85

  const sharedTokens = desiredTokens.filter((token) => candidateTokens.includes(token))
  return sharedTokens.length >= Math.max(2, desiredTokens.length - 1) ? 80 : 0
}

function requiresNestedCoverLookup(candidate: string): boolean {
  const normalized = candidate.replace(/^\/+/, '').replace(/^cache\//, '')
  return normalized.includes('/')
}

function sanitizeLegacyRemoteName(value: string): string {
  return value.trim().replace(/[^\w.-]+/g, '_')
}

function sanitizeCurrentRemoteName(value: string): string {
  return value.trim().replace(/[^\w. -]+/g, '_')
}

function sanitizeCurrentRemoteArchiveName(base: string, plateLabel: string): string {
  return sanitizeCurrentRemoteName(`${base} - ${plateLabel}`)
}