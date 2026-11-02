/**
 * Projects store the process columns they use; installed presets can contain more nozzle/flow
 * variants. Compare them in one layout by matching BOTH extruder id and variant name. A repeated
 * name alone is ambiguous on dual-nozzle printers. Unknown or malformed layouts stay untouched,
 * so a comparison cannot hide an unproven difference. This does not choose a new machine layout.
 */
import { isPrintVariantOption } from './variant-options.js'

const ID_KEY = 'print_extruder_id'
const VARIANT_KEY = 'print_extruder_variant'

/** Read a complete, unambiguous layout; missing identity is not permission to infer from width. */
function layoutKeys(config: Record<string, unknown>): string[] | null {
  const ids = config[ID_KEY]
  const variants = config[VARIANT_KEY]
  if (!Array.isArray(ids) || !Array.isArray(variants) || ids.length === 0 || ids.length !== variants.length) {
    return null
  }
  const completeIds = ids.every((value) => typeof value === 'string' && value.length > 0)
  const completeVariants = variants.every((value) => typeof value === 'string' && value.length > 0)
  if (!completeIds || !completeVariants) {
    return null
  }
  const keys = ids.map((id, index) => JSON.stringify([id, variants[index]]))
  return new Set(keys).size === keys.length ? keys : null
}

/**
 * Locate destination columns by exact nozzle/variant identity. Null means the layout is invalid;
 * a -1 entry means a valid destination column is absent in the source. Comparisons reject either
 * uncertainty, while a machine retarget can apply its explicit new-variant fallback policy.
 */
export function processVariantColumnIndices(config: Record<string, unknown>, reference: Record<string, unknown>): number[] | null {
  const source = layoutKeys(config)
  const target = layoutKeys(reference)
  if (!source || !target) return null
  return target.map((key) => source.indexOf(key))
}

/**
 * Project `config` onto `reference`'s declared process columns without mutating either input.
 * Only native process-variant options move. Scalar values retain their broadcast semantics, and
 * unrelated vectors retain their order and width. Every destination column must have an exact
 * source match; otherwise return the original config, leaving uncertainty visible to callers.
 */
export function alignProcessConfigToLayout<T extends Record<string, unknown>>(config: T, reference: Record<string, unknown>): T {
  const columns = processVariantColumnIndices(config, reference)
  if (!columns || columns.some((column) => column < 0)) return config
  const sourceLength = (config[ID_KEY] as string[]).length
  if (sourceLength === columns.length && columns.every((column, index) => column === index)) return config

  const aligned: Record<string, unknown> = { ...config }
  for (const [key, value] of Object.entries(config)) {
    if (key === ID_KEY || key === VARIANT_KEY || !isPrintVariantOption(key) || !Array.isArray(value)) {
      continue
    }
    if (value.length === sourceLength) {
      aligned[key] = columns.map((column) => value[column])
    } else if (value.length === 1) {
      aligned[key] = columns.map(() => value[0])
    }
  }
  aligned[ID_KEY] = [...reference[ID_KEY] as string[]]
  aligned[VARIANT_KEY] = [...reference[VARIANT_KEY] as string[]]
  return aligned as T
}
