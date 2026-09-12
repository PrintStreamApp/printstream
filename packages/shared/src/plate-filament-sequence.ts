/**
 * Bambu per-plate filament-order metadata.
 *
 * First-layer order is a whitespace-separated list of 1-based physical filament ids. Other-layer
 * order is a flat list split into equal chunks by `other_layers_print_sequence_nums`; each chunk
 * is `[start layer, end layer, ...filament ids]`. The engine's open-ended range uses INT_MAX-1.
 */
import { z } from 'zod'

export const plateLayerFilamentSequenceSchema = z.object({
  startLayer: z.number().int().min(2),
  /** Null is Bambu's "End" sentinel. */
  endLayer: z.number().int().min(2).nullable(),
  filamentIds: z.array(z.number().int().positive()).min(1).max(64)
}).refine((range) => range.endLayer == null || range.endLayer >= range.startLayer, {
  message: 'endLayer must be at or after startLayer'
})
export type PlateLayerFilamentSequence = z.infer<typeof plateLayerFilamentSequenceSchema>

export const BAMBU_SEQUENCE_END_LAYER = 2_147_483_646

/**
 * Keep a custom order valid after the project material list changes.
 *
 * Surviving materials retain their relative order, removed ids disappear, and newly-added ids are
 * appended in project order. Bambu seeds a new custom order from that same project order. This is
 * intentionally id-based so a drag-reorder of the material rows does not change which material the
 * user put first before the save renumbers the session ids.
 */
export function reconcilePlateFilamentSequence(
  order: readonly number[],
  physicalFilamentIds: readonly number[]
): number[] {
  const available = new Set(physicalFilamentIds)
  const seen = new Set<number>()
  const reconciled: number[] = []

  // Preserve the user's relative ordering for every physical material that still exists.
  for (const id of order) {
    if (!available.has(id) || seen.has(id)) {
      continue
    }

    seen.add(id)
    reconciled.push(id)
  }

  // New materials have no user-authored position, so append them in project order.
  for (const id of physicalFilamentIds) {
    if (!seen.has(id)) {
      seen.add(id)
      reconciled.push(id)
    }
  }

  return reconciled
}

/** Parse the optional first-layer order, rejecting Auto's zero sentinel and malformed ids. */
export function parseFirstLayerFilamentSequence(value: string | undefined): number[] | null {
  const ids = integerTokens(value)
  if (!ids) {
    return null
  }

  const invalid = ids.length === 0
    || ids[0] === 0
    || ids.some((id) => id < 1)
  if (invalid) {
    return null
  }

  return ids
}

/**
 * Parse Bambu's flattened, equal-width later-layer ranges.
 *
 * `countValue` is the number of ranges, not the number of integers in each range. Any malformed
 * range invalidates the complete value because unequal chunks cannot be associated safely.
 */
export function parseOtherLayerFilamentSequences(
  value: string | undefined,
  countValue: string | undefined
): PlateLayerFilamentSequence[] | null {
  const flat = integerTokens(value)
  const count = Number(countValue)

  if (!flat) {
    return null
  }

  const invalidHeader = !Number.isInteger(count)
    || count <= 0
    || flat.length % count !== 0
  if (invalidHeader) {
    return null
  }

  const chunkSize = flat.length / count

  if (chunkSize < 3) {
    return null
  }

  const ranges: PlateLayerFilamentSequence[] = []

  for (let index = 0; index < count; index += 1) {
    const chunk = flat.slice(index * chunkSize, (index + 1) * chunkSize)
    const parsed = plateLayerFilamentSequenceSchema.safeParse({
      startLayer: chunk[0],
      endLayer: (chunk[1] ?? 0) >= BAMBU_SEQUENCE_END_LAYER ? null : chunk[1],
      filamentIds: chunk.slice(2)
    })
    if (!parsed.success) {
      return null
    }

    ranges.push(parsed.data)
  }

  return ranges
}

/** Encode equal-width chunks for Bambu's plate metadata writer. */
export function serializeOtherLayerFilamentSequences(ranges: readonly PlateLayerFilamentSequence[]): {
  value: string
  count: string
} | null {
  if (ranges.length === 0) {
    return null
  }

  const width = ranges[0]?.filamentIds.length
  const hasInvalidRange = ranges.some((range) => {
    return range.filamentIds.length !== width
      || !plateLayerFilamentSequenceSchema.safeParse(range).success
  })
  if (!width || hasInvalidRange) {
    return null
  }

  const values = ranges.flatMap((range) => [
    range.startLayer,
    range.endLayer ?? BAMBU_SEQUENCE_END_LAYER,
    ...range.filamentIds
  ])

  return {
    value: values.join(' '),
    count: String(ranges.length)
  }
}

/** Parse a whitespace-separated integer vector without accepting partial numeric tokens. */
function integerTokens(value: string | undefined): number[] | null {
  if (!value?.trim()) {
    return null
  }

  const tokens = value.trim().split(/\s+/)
  const values = tokens.map((token) => Number(token))

  return values.every((entry) => Number.isInteger(entry)) ? values : null
}
