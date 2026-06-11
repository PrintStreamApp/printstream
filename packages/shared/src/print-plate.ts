/**
 * Shared helpers for inferring and formatting plate hints from printer-facing
 * file paths and job names.
 */

function parsePositiveInteger(value: string | null | undefined): number | null {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function basename(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
  const slashIndex = normalized.lastIndexOf('/')
  return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized
}

function stripObservedPrintExtension(value: string): string {
  return basename(value.trim().replace(/^file:\/\//i, ''))
    .replace(/\.(gcode(?:\.3mf)?|3mf)$/i, '')
}

function parseExplicitObservedPrintPlateIndex(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null

  const metadataMatch = value.match(/(?:^|\/)Metadata\/plate_(\d+)\.gcode$/i)
  if (metadataMatch) return parsePositiveInteger(metadataMatch[1])

  const explicitPlateMatch = stripObservedPrintExtension(value).match(/(?:^|[ _-])plate[_ -]?(\d+)(?:$|[ _.-])/i)
  if (explicitPlateMatch) return parsePositiveInteger(explicitPlateMatch[1])

  return null
}

function parseDelimitedObservedPlateIndex(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null

  const segments = stripObservedPrintExtension(value)
    .split(' - ')
    .map((segment) => segment.trim())
    .filter(Boolean)

  if (segments.length < 3) return null

  const numericSegments = segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment, index }) => index > 0 && index < segments.length - 1 && /^\d+$/.test(segment))

  if (numericSegments.length !== 1) return null
  return parsePositiveInteger(numericSegments[0]?.segment)
}

export function buildPlateGcodeFileHint(plate: number | null | undefined): string | null {
  return plate != null && Number.isFinite(plate) && plate > 0
    ? `Metadata/plate_${Math.floor(plate)}.gcode`
    : null
}

export function extractObservedPrintPlateIndex(value: string | null | undefined): number | null {
  return parseExplicitObservedPrintPlateIndex(value) ?? parseDelimitedObservedPlateIndex(value)
}

export function inferObservedPrintPlateIndex(input: {
  jobName?: string | null
  gcodeFile?: string | null
}): number | null {
  const explicitJobPlate = parseExplicitObservedPrintPlateIndex(input.jobName)
  const explicitFilePlate = parseExplicitObservedPrintPlateIndex(input.gcodeFile)
  if (explicitFilePlate != null) return explicitFilePlate
  if (explicitJobPlate != null) return explicitJobPlate

  const delimitedJobPlate = parseDelimitedObservedPlateIndex(input.jobName)
  const delimitedFilePlate = parseDelimitedObservedPlateIndex(input.gcodeFile)
  if (delimitedJobPlate != null && delimitedFilePlate != null) {
    return delimitedJobPlate === delimitedFilePlate ? delimitedJobPlate : null
  }

  return delimitedJobPlate ?? delimitedFilePlate
}

export function normalizeFallbackPlateLabel(value: string): string {
  const match = value.match(/^plate[_ -]?(\d+)$/i)
  if (!match) return value

  const plate = parsePositiveInteger(match[1])
  return plate != null ? `Plate ${plate}` : value
}