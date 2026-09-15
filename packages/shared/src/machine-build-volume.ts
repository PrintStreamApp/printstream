/**
 * Rectangular custom-printer build-volume parsing and serialization.
 *
 * BambuStudio's current Create Printer flow exposes a rectangular bed only. It stores the bed as
 * four `printable_area` points, with the G-code origin expressed by translating those points away
 * from the front-left corner. This module keeps that wire shape out of the web form and reports
 * whether an existing polygon was exactly rectangular, so opening the form never silently
 * simplifies a custom polygon.
 */
import type { ProcessConfig, ProcessConfigValue } from './process-settings.js'

export const MAX_CUSTOM_PRINTER_HEIGHT_MM = 1000

export interface RectangularMachineBuildVolume {
  /** Printable bed size along X, in millimetres. */
  width: number
  /** Printable bed size along Y, in millimetres. */
  depth: number
  /** Distance from the bed's front-left corner to G-code X=0, in millimetres. */
  originX: number
  /** Distance from the bed's front-left corner to G-code Y=0, in millimetres. */
  originY: number
  /** Maximum printable Z height, in millimetres. */
  height: number
}

export interface ReadMachineBuildVolumeResult {
  volume: RectangularMachineBuildVolume
  /** False when `printable_area` was absent, malformed, or a non-rectangular polygon. */
  exactRectangle: boolean
}

const DEFAULT_BUILD_VOLUME: RectangularMachineBuildVolume = {
  width: 200,
  depth: 200,
  originX: 0,
  originY: 0,
  height: 100
}

interface Point { x: number; y: number }

/** Bed-coordinate polygons whose physical position must survive a G-code origin change. */
const BED_COORDINATE_AREA_KEYS = [
  'bed_exclude_area',
  'bed_heat_soak_area',
  'wrapping_exclude_area'
] as const

/**
 * Whether this profile describes independent per-extruder reach limits.
 *
 * A single rectangle cannot safely replace those limits: the two toolheads can have overlapping
 * but different reachable areas and heights. Callers must withhold rectangular editing until the
 * UI can author the whole constraint set together.
 */
export function hasPerExtruderMachineBuildVolume(config: ProcessConfig): boolean {
  return hasConfiguredValue(config.extruder_printable_area)
    || hasConfiguredValue(config.extruder_printable_height)
}

/**
 * Reads the bounding rectangle and origin from a resolved machine preset.
 *
 * A non-rectangular polygon is represented by its bounds but flagged with `exactRectangle: false`.
 * Callers can therefore show useful initial values while warning before an edit replaces the
 * polygon. Invalid or absent values fall back to BambuStudio's create-printer defaults.
 */
export function readRectangularMachineBuildVolume(config: ProcessConfig): ReadMachineBuildVolumeResult {
  const rawArea = config.printable_area
  const points = parsePoints(rawArea)
  const first = points[0]
  const last = points[points.length - 1]
  if (points.length > 1 && first && last && first.x === last.x && first.y === last.y) points.pop()
  const height = positiveNumber(firstValue(config.printable_height)) ?? DEFAULT_BUILD_VOLUME.height

  if (points.length < 3) {
    return { volume: { ...DEFAULT_BUILD_VOLUME, height }, exactRectangle: false }
  }

  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const width = maxX - minX
  const depth = maxY - minY

  if (!(width > 0) || !(depth > 0)) {
    return { volume: { ...DEFAULT_BUILD_VOLUME, height }, exactRectangle: false }
  }

  const corners = new Set([
    pointKey(minX, minY),
    pointKey(maxX, minY),
    pointKey(maxX, maxY),
    pointKey(minX, maxY)
  ])
  const exactRectangle = points.length === 4
    && new Set(points.map((point) => pointKey(point.x, point.y))).size === 4
    && points.every((point) => corners.has(pointKey(point.x, point.y)))
    // Four correct corners in a bow-tie order are a self-intersecting polygon, not a rectangle.
    && Math.abs(polygonArea(points) - width * depth) < 0.000001

  return {
    volume: {
      width,
      depth,
      originX: normalizeZero(-minX),
      originY: normalizeZero(-minY),
      height
    },
    exactRectangle
  }
}

/** Returns a user-facing validation problem, or null when the build volume is serializable. */
export function validateRectangularMachineBuildVolume(volume: RectangularMachineBuildVolume): string | null {
  const measurements: Array<[label: string, value: number]> = [
    ['Bed width', volume.width],
    ['Bed depth', volume.depth],
    ['Printable height', volume.height],
    ['X origin', volume.originX],
    ['Y origin', volume.originY]
  ]
  const invalid = measurements.find(([, value]) => !Number.isFinite(value))
  if (invalid) return `${invalid[0]} must be a number.`
  if (volume.width <= 0 || volume.depth <= 0) return 'Bed width and depth must be greater than zero.'
  if (volume.height <= 0) return 'Printable height must be greater than zero.'
  if (volume.height > MAX_CUSTOM_PRINTER_HEIGHT_MM) {
    return `Printable height cannot exceed ${MAX_CUSTOM_PRINTER_HEIGHT_MM} mm.`
  }
  if (volume.originX >= volume.width || volume.originY >= volume.depth) {
    return 'The G-code origin must be before the bed\'s far-right and rear edges.'
  }
  const serializedCoordinates = [
    -volume.originX,
    -volume.originY,
    volume.width - volume.originX,
    volume.depth - volume.originY
  ]
  if (serializedCoordinates.some((coordinate) => !Number.isFinite(coordinate))) {
    return 'The bed size and origin are too large to serialize safely.'
  }
  return null
}

/**
 * Replaces a machine preset's printable rectangle and height. Bed-coordinate safety regions move
 * with an origin change so they remain fixed on the physical bed; all other settings are retained.
 * Throws when the values cannot be represented safely or the profile has per-extruder limits.
 */
export function applyRectangularMachineBuildVolume(
  config: ProcessConfig,
  volume: RectangularMachineBuildVolume
): ProcessConfig {
  const problem = validateRectangularMachineBuildVolume(volume)
  if (problem) throw new RangeError(problem)
  if (hasPerExtruderMachineBuildVolume(config)) {
    throw new RangeError('Build-volume editing is unavailable for printer profiles with per-extruder printable areas or heights.')
  }

  const previousVolume = readRectangularMachineBuildVolume(config).volume
  const coordinateOffset = {
    x: normalizeZero(previousVolume.originX - volume.originX),
    y: normalizeZero(previousVolume.originY - volume.originY)
  }

  const minX = normalizeZero(-volume.originX)
  const minY = normalizeZero(-volume.originY)
  const maxX = normalizeZero(volume.width - volume.originX)
  const maxY = normalizeZero(volume.depth - volume.originY)

  const updated: ProcessConfig = {
    ...config,
    printable_area: [
      serializePoint(minX, minY),
      serializePoint(maxX, minY),
      serializePoint(maxX, maxY),
      serializePoint(minX, maxY)
    ],
    printable_height: serializeNumber(volume.height)
  }

  // Keep hardware keep-outs and heat-soak regions fixed relative to the physical bed. Their wire
  // coordinates share the G-code origin with `printable_area`, so preserving them verbatim would
  // move those safety regions whenever the user moves 0,0.
  if (coordinateOffset.x !== 0 || coordinateOffset.y !== 0) {
    for (const key of BED_COORDINATE_AREA_KEYS) {
      const value = config[key]
      if (value !== undefined) {
        updated[key] = translatePointConfigValue(key, value, coordinateOffset)
      }
    }
  }

  return updated
}

function hasConfiguredValue(value: ProcessConfigValue | undefined): boolean {
  if (value === undefined) return false
  const values = Array.isArray(value) ? value : [value]
  return values.some((entry) => entry.trim() !== '')
}

/** Translate a serialized ConfigOptionPoints value without collapsing its entry grouping. */
function translatePointConfigValue(
  key: string,
  value: ProcessConfigValue,
  offset: Point
): ProcessConfigValue {
  const entries = Array.isArray(value) ? value : [value]
  const translated = entries.map((entry) => {
    if (entry.trim() === '') return entry
    return entry.split(',').map((token) => {
      const point = parsePoint(token)
      if (!point) {
        throw new RangeError(`Cannot move the G-code origin because ${key} contains an invalid point.`)
      }
      return serializePoint(point.x + offset.x, point.y + offset.y)
    }).join(',')
  })
  return Array.isArray(value) ? translated : (translated[0] ?? '')
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function positiveNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function parsePoint(value: string): Point | null {
  const match = /^\s*(-?(?:\d+(?:\.\d+)?|\.\d+))x(-?(?:\d+(?:\.\d+)?|\.\d+))\s*$/.exec(value)
  if (!match) return null
  const x = Number(match[1])
  const y = Number(match[2])
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}

/** Parse both ordinary point arrays and the comma-packed form accepted by BambuStudio. */
function parsePoints(value: string | string[] | undefined): Point[] {
  const entries = Array.isArray(value) ? value : value === undefined ? [] : [value]
  const points: Point[] = []
  for (const entry of entries) {
    for (const token of entry.split(',')) {
      const point = parsePoint(token)
      if (!point) return []
      points.push(point)
    }
  }
  return points
}

/** Absolute shoelace area of a bed polygon. */
function polygonArea(points: Point[]): number {
  let sum = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    if (current && next) sum += current.x * next.y - next.x * current.y
  }
  return Math.abs(sum) / 2
}

function pointKey(x: number, y: number): string {
  return `${normalizeZero(x)},${normalizeZero(y)}`
}

function serializePoint(x: number, y: number): string {
  return `${serializeNumber(x)}x${serializeNumber(y)}`
}

function serializeNumber(value: number): string {
  const normalized = normalizeZero(value)
  const serialized = String(normalized)
  // ConfigOptionPoint serializes ordinary decimal numbers. JavaScript switches to exponent form
  // for very small values, which BambuStudio's point parser does not accept.
  return serialized.includes('e') ? expandExponentialNumber(serialized) : serialized
}

/** Expands JavaScript's scientific notation without rounding away significant digits. */
function expandExponentialNumber(value: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/.exec(value)
  if (!match) return value

  const sign = match[1] ?? ''
  const integerDigits = match[2] ?? ''
  const fractionalDigits = match[3] ?? ''
  const exponent = Number(match[4])
  const digits = integerDigits + fractionalDigits
  const decimalIndex = integerDigits.length + exponent

  if (decimalIndex <= 0) {
    return `${sign}0.${'0'.repeat(-decimalIndex)}${digits}`
  }
  if (decimalIndex >= digits.length) {
    return `${sign}${digits}${'0'.repeat(decimalIndex - digits.length)}`
  }
  return `${sign}${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`
}

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value
}
