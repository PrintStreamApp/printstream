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

/** The pair that names a record's process columns: `print_extruder_variant` + `print_extruder_id`. */
export interface ProcessVariantLayout {
  print_extruder_variant: string[]
  print_extruder_id: string[]
}

/** A record's process column layout, or null when it declares none or a malformed one. */
export function readProcessVariantLayout(record: Record<string, unknown>): ProcessVariantLayout | null {
  if (!layoutKeys(record)) return null
  return {
    print_extruder_variant: [...record[VARIANT_KEY] as string[]],
    print_extruder_id: [...record[ID_KEY] as string[]]
  }
}

/**
 * Lay a process OVERRIDE onto `target`'s columns, given the layout it was authored against.
 *
 * Why: an override is carried from the project's old process onto a new machine's preset, and
 * written verbatim it kept the OLD machine's width. An X1C wall speed `["150","350"]` (DD Standard,
 * DD High Flow) over an X2D's six columns left the Bowden nozzle's columns out of range, and the
 * engine's `get_at` read 150 there instead of the preset's 50. Bambu Studio transfers a variant edit
 * by (extruder id, variant name) (`Tab.cpp` `handle_transfer_action`), and a column it cannot match
 * keeps the new preset's value; this does the same.
 *
 * @param value the override vector
 * @param authoredLayout the layout `value` was written against; null when unknown
 * @param target the record being written, already carrying the FINAL layout and the preset's values
 * @param key the option, to read the preset's value for an unmatched column
 * @returns the vector to write, or `value` unchanged when it already fits or nothing can be decided
 */
export function layProcessOverrideOnto(
  value: string[],
  authoredLayout: ProcessVariantLayout | null,
  target: Record<string, unknown>,
  key: string
): string[] {
  const targetLayout = layoutKeys(target)
  if (!isPrintVariantOption(key) || !targetLayout || value.length === targetLayout.length) return value
  const presetValue = target[key]
  const presetColumn = (row: number): string | undefined => {
    if (Array.isArray(presetValue)) {
      const entry = presetValue[row] ?? presetValue[0]
      return typeof entry === 'string' ? entry : undefined
    }
    return typeof presetValue === 'string' ? presetValue : undefined
  }

  // Known authoring layout of the same width: transfer by identity, as Studio does.
  if (authoredLayout && authoredLayout.print_extruder_id.length === value.length) {
    const columns = processVariantColumnIndices(authoredLayout as unknown as Record<string, unknown>, target)
    if (columns) {
      return columns.map((column, row) => (column >= 0 ? value[column] : presetColumn(row)) ?? value[0] ?? '')
    }
  }
  // A single value from an unknown layout is the engine's own broadcast form: keep it.
  if (value.length === 1) return value
  // Unknown layout, wrong width: keep the columns it does have positionally and let the preset
  // supply the rest, rather than leave the tail for the engine to read out of range.
  return targetLayout.map((_key, row) => (row < value.length ? value[row] : presetColumn(row)) ?? value[0] ?? '')
}
