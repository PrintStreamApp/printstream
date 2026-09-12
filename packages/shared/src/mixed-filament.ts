/**
 * Bambu mixed-filament project metadata and gradient-curve math.
 *
 * A mixed slot is virtual: its 1-based component ids name physical project
 * filament slots. The parser follows BambuStudio's tolerant read semantics so
 * existing projects remain inspectable, while `issues` records every condition
 * an authoring surface must fix before saving a newly edited mix.
 */
import { z } from 'zod'

export const MIXED_GRADIENT_MIN_RATIO = 0.1
export const MIXED_GRADIENT_MAX_RATIO = 0.9

export const mixedFilamentIssueSchema = z.enum([
  'array-size',
  'component-count',
  'component-index',
  'component-reference',
  'component-is-mixed',
  'component-type-mismatch',
  'ratio-count',
  'ratio-value',
  'gradient-component-count',
  'gradient-range',
  'gradient-curve'
])
export type MixedFilamentIssue = z.infer<typeof mixedFilamentIssueSchema>

export const mixedFilamentGradientAnchorSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(MIXED_GRADIENT_MIN_RATIO).max(MIXED_GRADIENT_MAX_RATIO),
  /** Null means use the shared Fritsch-Carlson default tangent. */
  mIn: z.number().finite().nullable(),
  /** Null means use the shared Fritsch-Carlson default tangent. */
  mOut: z.number().finite().nullable()
})
export type MixedFilamentGradientAnchor = z.infer<typeof mixedFilamentGradientAnchorSchema>

export const mixedFilamentConfigSchema = z.object({
  /** Physical project filament ids, using Bambu's 1-based slot space. */
  componentIds: z.array(z.number().int().positive()),
  /** Normalized component shares. Invalid source values produce an empty array plus an issue. */
  ratios: z.array(z.number().positive()),
  gradient: z.boolean(),
  gradientRange: z.tuple([z.number(), z.number()]),
  gradientCurve: z.array(mixedFilamentGradientAnchorSchema).nullable(),
  gradientPerPart: z.boolean(),
  issues: z.array(mixedFilamentIssueSchema)
})
export type MixedFilamentConfig = z.infer<typeof mixedFilamentConfigSchema>

export interface MixedFilamentProjectSlot {
  id: number
  mixedFilament?: MixedFilamentConfig | null
}

/**
 * Expand used virtual slot ids to the physical component ids that the slicer writes into G-code.
 * Invalid nested mixes are traversed defensively with cycle protection; only physical slots reach
 * the result, so no caller can accidentally ask a user to map a virtual recipe to one tray.
 */
export function expandMixedFilamentIds(
  filaments: readonly MixedFilamentProjectSlot[],
  usedIds: ReadonlySet<number>
): Set<number> {
  const byId = new Map(filaments.map((filament) => [filament.id, filament] as const))
  const physicalIds = new Set<number>()
  const visiting = new Set<number>()

  /** Recursively replace a virtual slot with its physical leaf components. */
  const visit = (id: number) => {
    if (visiting.has(id)) {
      return
    }

    const filament = byId.get(id)
    if (!filament) {
      return
    }

    if (!filament.mixedFilament) {
      physicalIds.add(id)
      return
    }

    visiting.add(id)
    for (const componentId of filament.mixedFilament.componentIds) {
      visit(componentId)
    }
    visiting.delete(id)
  }

  for (const id of usedIds) {
    visit(id)
  }

  return physicalIds
}

/** Read Bambu's scalar boolean encodings from a project config array. */
function configFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true'
}

/** Convert a config vector to strings without treating a scalar as a one-entry vector. */
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.map((entry) => {
    return typeof entry === 'string' ? entry : String(entry ?? '')
  })
}

/** Parse a comma-separated list of positive, 1-based project filament ids. */
function parseComponentIds(value: string): number[] | null {
  if (!value) {
    return null
  }

  const tokens = value.split(',')
  const ids = tokens.map((token) => Number(token))

  const invalid = ids.some((id, index) => {
    return tokens[index]?.trim() === '' || !Number.isInteger(id) || id < 1
  })
  if (invalid) {
    return null
  }

  return ids
}

/**
 * Move the component ids inside one mixed slot through a filament-list permutation.
 * Missing physical sources become BambuStudio's zero sentinel, which makes the mix visibly broken
 * instead of silently pointing at whichever material inherited the deleted slot number.
 */
export function remapMixedFilamentComponentIds(
  value: string,
  newSlotForOldSlot: ReadonlyMap<number, number>
): string {
  const componentIds = parseComponentIds(value)
  if (!componentIds) {
    return value
  }

  return componentIds.map((componentId) => newSlotForOldSlot.get(componentId) ?? 0).join(',')
}

/** Parse and normalize component ratios, supplying equal shares when Bambu stores no value. */
function parseRatios(value: string, count: number): number[] | null {
  if (!value) {
    return count > 0 ? Array.from({ length: count }, () => 1 / count) : []
  }

  const tokens = value.split(',')
  const values = tokens.map((token) => Number(token))

  const invalidValue = values.some((ratio, index) => {
    return tokens[index]?.trim() === '' || !Number.isFinite(ratio) || ratio <= 0
  })
  if (values.length !== count || invalidValue) {
    return null
  }

  const sum = values.reduce((total, ratio) => total + ratio, 0)
  return sum > 0 ? values.map((ratio) => ratio / sum) : null
}

/** Parse the lower and upper component-share limits used by a gradient. */
function parseGradientRange(value: string): [number, number] | null {
  if (!value) {
    return [MIXED_GRADIENT_MIN_RATIO, MIXED_GRADIENT_MAX_RATIO]
  }

  const values = value.split(',').map((token) => Number(token))
  const invalid = values.some((ratio) => {
    return !Number.isFinite(ratio) || ratio <= 0 || ratio >= 1
  })
  if (values.length !== 2 || invalid) {
    return null
  }

  return [values[0]!, values[1]!]
}

/** Parse an optional tangent, where blank and NaN both mean "use the PCHIP default". */
function parseTangent(value: string): number | null {
  if (!value || value.toLowerCase() === 'nan') {
    return null
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Parse Bambu's pipe-separated 2-field or 4-field gradient anchors. */
export function parseMixedFilamentGradientCurve(
  value: string
): MixedFilamentGradientAnchor[] | null {
  if (!value) {
    return null
  }

  const anchors: MixedFilamentGradientAnchor[] = []

  for (const segment of value.split('|')) {
    if (!segment) {
      continue
    }

    const fields = segment.split(',')
    if (fields.length !== 2 && fields.length !== 4) {
      continue
    }

    const x = Number(fields[0])
    const y = Number(fields[1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue
    }

    anchors.push({
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(MIXED_GRADIENT_MIN_RATIO, Math.min(MIXED_GRADIENT_MAX_RATIO, y)),
      mIn: fields.length === 4 ? parseTangent(fields[2]!) : null,
      mOut: fields.length === 4 ? parseTangent(fields[3]!) : null
    })
  }

  if (anchors.length < 2) {
    return null
  }

  return anchors.sort((left, right) => left.x - right.x)
}

/** Serialize anchors in BambuStudio's stable four-decimal representation. */
export function serializeMixedFilamentGradientCurve(
  anchors: MixedFilamentGradientAnchor[]
): string {
  return anchors.map((anchor) => {
    const base = `${anchor.x.toFixed(4)},${anchor.y.toFixed(4)}`
    if (anchor.mIn == null && anchor.mOut == null) {
      return base
    }

    return `${base},${anchor.mIn?.toFixed(4) ?? ''},${anchor.mOut?.toFixed(4) ?? ''}`
  }).join('|')
}

/** Fritsch-Carlson default tangents used by both the preview and the slicer. */
export function mixedFilamentGradientTangents(
  anchors: MixedFilamentGradientAnchor[]
): number[] {
  const tangents = Array.from({ length: anchors.length }, () => 0)
  if (anchors.length < 2) {
    return tangents
  }

  const slopes = anchors.slice(0, -1).map((anchor, index) => {
    const width = Math.max(1e-12, anchors[index + 1]!.x - anchor.x)
    return (anchors[index + 1]!.y - anchor.y) / width
  })

  tangents[0] = slopes[0]!
  tangents[tangents.length - 1] = slopes[slopes.length - 1]!

  for (let index = 1; index + 1 < anchors.length; index++) {
    tangents[index] = (slopes[index - 1]! + slopes[index]!) / 2
  }

  for (let index = 0; index < slopes.length; index++) {
    const slope = slopes[index]!

    if (slope === 0) {
      tangents[index] = 0
      tangents[index + 1] = 0
      continue
    }
    const left = tangents[index]! / slope
    const right = tangents[index + 1]! / slope
    const magnitude = left * left + right * right

    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude)
      tangents[index] = scale * left * slope
      tangents[index + 1] = scale * right * slope
    }
  }

  return tangents
}

/** Sample the exact Hermite curve semantics used by BambuStudio's slicer. */
export function sampleMixedFilamentGradientCurve(
  anchors: MixedFilamentGradientAnchor[],
  progress: number
): number {
  if (anchors.length < 2) {
    return 0.5
  }

  if (progress <= anchors[0]!.x) {
    return anchors[0]!.y
  }

  if (progress >= anchors[anchors.length - 1]!.x) {
    return anchors[anchors.length - 1]!.y
  }

  const defaults = mixedFilamentGradientTangents(anchors)

  for (let index = 1; index < anchors.length; index++) {
    const right = anchors[index]!
    if (progress > right.x) {
      continue
    }

    const left = anchors[index - 1]!
    const width = Math.max(1e-12, right.x - left.x)
    const u = (progress - left.x) / width
    const u2 = u * u
    const u3 = u2 * u
    const value = (2 * u3 - 3 * u2 + 1) * left.y
      + (u3 - 2 * u2 + u) * width * (left.mOut ?? defaults[index - 1]!)
      + (-2 * u3 + 3 * u2) * right.y
      + (u3 - u2) * width * (right.mIn ?? defaults[index]!)

    return Math.max(MIXED_GRADIENT_MIN_RATIO, Math.min(MIXED_GRADIENT_MAX_RATIO, value))
  }

  return anchors[anchors.length - 1]!.y
}

/** Decode every virtual mixed slot from a parsed `project_settings.config` record. */
export function parseProjectMixedFilaments(
  record: Record<string, unknown>
): Array<MixedFilamentConfig | null> {
  // Decode every parallel vector first. Their relative positions are the slot identity.
  const mixedFlags = Array.isArray(record.filament_is_mixed)
    ? record.filament_is_mixed.map(configFlag)
    : []
  const components = stringArray(record.filament_mixed_components)
  const ratioStrings = stringArray(record.filament_mixed_sublayer_ratios)
  const gradientFlags = Array.isArray(record.filament_mixed_gradient)
    ? record.filament_mixed_gradient.map(configFlag)
    : []
  const ranges = stringArray(record.filament_mixed_gradient_range)
  const curves = stringArray(record.filament_mixed_gradient_curve)
  const perPartFlags = Array.isArray(record.filament_mixed_gradient_per_part)
    ? record.filament_mixed_gradient_per_part.map(configFlag)
    : []
  const types = stringArray(record.filament_type)

  const slotCount = mixedFlags.length
  const physicalCount = mixedFlags.filter((flag) => !flag).length
  const gradientArraysMismatch = gradientFlags.some(Boolean)
    && (gradientFlags.length !== slotCount || ranges.length !== slotCount)
  const curveArrayMismatch = curves.some(Boolean) && curves.length !== slotCount

  return mixedFlags.map((isMixed, index) => {
    if (!isMixed) {
      return null
    }

    const issues = new Set<MixedFilamentIssue>()
    const parallelArraysMismatch = components.length !== slotCount
      || ratioStrings.length !== slotCount
      || gradientArraysMismatch
      || curveArrayMismatch
    if (parallelArraysMismatch) {
      issues.add('array-size')
    }

    // Validate the recipe before reading any settings whose width depends on its component count.
    const componentIds = parseComponentIds(components[index] ?? '')
    if (!componentIds) {
      issues.add('component-index')
    } else {
      const invalidComponentCount = componentIds.length < 2
        || componentIds.length > 3
        || new Set(componentIds).size !== componentIds.length
      if (invalidComponentCount) {
        issues.add('component-count')
      }

      const hasInvalidReference = componentIds.some((id) => {
        return id > physicalCount || id > slotCount || id === index + 1
      })
      if (hasInvalidReference) {
        issues.add('component-reference')
      }

      if (componentIds.some((id) => mixedFlags[id - 1] === true)) {
        issues.add('component-is-mixed')
      }

      const componentTypes = componentIds
        .map((id) => types[id - 1])
        .filter((type): type is string => Boolean(type))
      if (new Set(componentTypes).size > 1) {
        issues.add('component-type-mismatch')
      }
    }

    // Ratio and gradient errors remain separate so an editor can explain the exact repair needed.
    const parsedRatios = parseRatios(ratioStrings[index] ?? '', componentIds?.length ?? 0)
    if (parsedRatios == null) {
      const ratioCount = (ratioStrings[index] ?? '').split(',').length
      if (ratioCount !== (componentIds?.length ?? 0)) {
        issues.add('ratio-count')
      } else {
        issues.add('ratio-value')
      }
    }

    const gradient = gradientFlags[index] ?? false
    if (gradient && componentIds?.length !== 2) {
      issues.add('gradient-component-count')
    }

    const gradientRange = parseGradientRange(ranges[index] ?? '')
    if (gradient && gradientRange == null) {
      issues.add('gradient-range')
    }

    const curveSource = curves[index] ?? ''
    const gradientCurve = parseMixedFilamentGradientCurve(curveSource)
    if (gradient && curveSource && gradientCurve == null) {
      issues.add('gradient-curve')
    }

    return {
      componentIds: componentIds ?? [],
      ratios: parsedRatios ?? [],
      gradient,
      gradientRange: gradientRange ?? [MIXED_GRADIENT_MIN_RATIO, MIXED_GRADIENT_MAX_RATIO],
      gradientCurve,
      gradientPerPart: perPartFlags[index] ?? false,
      issues: [...issues]
    }
  })
}
