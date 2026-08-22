/**
 * Translation between the two shapes BambuStudio stores one preset in.
 *
 * A preset on disk (and in every `.json` export a user uploads here) holds vector
 * options as ARRAYS of strings and scalars as strings:
 *
 *     { "filament_type": ["PLA"], "layer_height": "0.2" }
 *
 * The same preset in Bambu's cloud holds every option as ONE `ConfigOption::serialize()`
 * string, because that is what `PresetCollection::get_differed_values_to_update` uploads:
 *
 *     { "filament_type": "\"PLA\"", "layer_height": "0.2" }
 *
 * Studio converts on both legs of its sync and so must we — a preset stored in the wrong
 * shape does not merely look wrong in the manager (a material named `"PLA"`, quotes
 * included); the fields our own code reads by name, like `filament_type` and
 * `compatible_printers`, stop matching anything.
 *
 * The rules are ported from `Config.hpp` / `Config.cpp` in the vendored source:
 * string vectors use c-style escaping joined on `;` (`escape_strings_cstyle`), numeric
 * and boolean vectors join on `,`, and scalars serialize to themselves. Which options
 * are vectors comes from `BAMBU_PRESET_OPTION_SHAPES`, not from guessing at the value's
 * shape: a single-element vector and a scalar are indistinguishable once serialized, so
 * that table is the only thing that can tell `["PLA"]` from `"PLA"`.
 *
 * Unknown keys (an option newer than the generated table) are passed through untouched
 * rather than guessed at, so a preset never loses a setting it arrived with.
 */
import { BAMBU_PRESET_OPTION_SHAPES } from './generated/bambu-preset-option-shapes.generated.js'

/** Option shape as far as this codec cares: is it a vector, and are its elements strings? */
interface OptionShape {
  vector: boolean
  stringLike: boolean
}

/**
 * Keys the codec needs that are NOT `PrintConfig` options, so `BAMBU_PRESET_OPTION_SHAPES`
 * (generated from `this->add(...)` calls) cannot see them: `filament_id` in particular is
 * read via a runtime `dynamic_cast` in the vendored source rather than declared with
 * `this->add()`. Kept manual and short deliberately — everything that IS a real
 * `PrintConfig` option (including identity/compatibility keys like `compatible_printers`,
 * `inherits`, `filament_settings_id`) comes from the generated table, so this list cannot
 * silently go stale the way a full hand-maintained exception list did.
 */
const NON_PRINT_CONFIG_OPTION_SHAPES: Record<string, OptionShape> = {
  filament_id: { vector: true, stringLike: true },
  name: { vector: false, stringLike: true },
  version: { vector: false, stringLike: true },
  from: { vector: false, stringLike: true }
}

function optionShape(key: string): OptionShape | null {
  return BAMBU_PRESET_OPTION_SHAPES[key] ?? NON_PRINT_CONFIG_OPTION_SHAPES[key] ?? null
}

/**
 * Serializes a string vector the way Bambu's cloud stores one: every element quoted.
 *
 * BambuStudio's own `escape_strings_cstyle` quotes only when it must (whitespace, a
 * quote, a backslash), but the payloads actually observed on this endpoint are quoted
 * regardless — `"filament_type": "\"PLA\""`, where `PLA` needs no quoting — and Studio
 * writes the same doubled form into `filament_settings_id`. Quoting unconditionally is
 * what makes a pulled preset re-encode to the bytes it arrived as, so a round-trip
 * through PrintStream does not rewrite every string option in the user's cloud library.
 * The parser accepts both forms, so a bare element still reads correctly.
 */
function escapeStringsCStyle(values: string[]): string {
  return values
    .map((value) => {
      const escaped = value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
      return `"${escaped}"`
    })
    .join(';')
}

/**
 * `unescape_strings_cstyle`: split on `;` at the top level only — a separator inside a
 * quoted element is part of that element, which is why this cannot be a plain `split`.
 * Returns null when the input is malformed (an unterminated quote), so the caller can
 * pass the raw value through rather than store a mangled one.
 */
function unescapeStringsCStyle(serialized: string): string[] | null {
  const values: string[] = []
  let index = 0

  while (index <= serialized.length) {
    // Leading whitespace between elements is not part of the value.
    while (index < serialized.length && (serialized[index] === ' ' || serialized[index] === '\t')) index += 1

    if (serialized[index] === '"') {
      index += 1
      let current = ''
      for (;;) {
        if (index >= serialized.length) return null
        const char = serialized[index]
        if (char === '\\') {
          const next = serialized[index + 1]
          if (next === undefined) return null
          current += next === 'r' ? '\r' : next === 'n' ? '\n' : next
          index += 2
          continue
        }
        if (char === '"') {
          index += 1
          break
        }
        current += char
        index += 1
      }
      values.push(current)
    } else {
      const separator = serialized.indexOf(';', index)
      const end = separator < 0 ? serialized.length : separator
      values.push(serialized.slice(index, end))
      index = end
    }

    if (index >= serialized.length) break
    if (serialized[index] !== ';') return null
    index += 1
    // A trailing separator means one final empty element.
    if (index === serialized.length) {
      values.push('')
      break
    }
  }

  return values
}

/**
 * One cloud value in local (`.json` preset) form.
 *
 * Bambu sends some numeric options as JSON numbers rather than strings, so a scalar is
 * coerced to a string here — the local form is strings throughout.
 */
function decodeValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map((entry) => String(entry))
  if (typeof value === 'object') return value

  const raw = typeof value === 'string' ? value : String(value)
  const shape = optionShape(key)
  if (!shape) return raw
  if (!shape.vector) return raw
  if (!shape.stringLike) return raw.split(',').map((entry) => entry.trim())

  const parsed = unescapeStringsCStyle(raw)
  return parsed ?? raw
}

/** One local value in cloud (`ConfigOption::serialize()`) form. */
function encodeValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (!Array.isArray(value)) return typeof value === 'string' ? value : String(value)

  const elements = value.map((entry) => String(entry))
  const shape = optionShape(key)
  // An unknown key that arrived as an array is still a vector — join it the safe way
  // (c-style escaping round-trips a numeric element unchanged, a `;` in a string is
  // only preserved by quoting).
  if (!shape || shape.stringLike) return escapeStringsCStyle(elements)
  return elements.join(',')
}

/** Keys that live in the cloud ENVELOPE, not among a preset's settings. */
const ENVELOPE_KEYS = new Set(['setting_id', 'base_id', 'user_id', 'update_time', 'updated_time', 'public', 'nickname', 'code', 'message', 'error'])

/**
 * A cloud preset's `setting` map as a local preset record.
 *
 * `name` and `type` are taken from the envelope (the caller passes them) because the
 * `setting` map's own copies are unreliable: Bambu's `filament_settings_id` carries the
 * name quoted, and a preset's `type` there is Bambu's spelling (`print`), not ours.
 */
export function decodeCloudPresetSetting(setting: Record<string, unknown>): Record<string, unknown> {
  const decoded: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(setting)) {
    if (ENVELOPE_KEYS.has(key)) continue
    decoded[key] = decodeValue(key, value)
  }
  return decoded
}

/**
 * A local preset record as a cloud `setting` map.
 *
 * Drops the envelope keys and our own bookkeeping so the payload carries settings only —
 * Bambu rejects a payload whose `setting` contains its envelope fields, and `type`/`name`
 * are sent alongside it, not inside it.
 */
export function encodeCloudPresetSetting(record: Record<string, unknown>): Record<string, unknown> {
  const encoded: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (ENVELOPE_KEYS.has(key) || key === 'type' || key === 'from') continue
    encoded[key] = encodeValue(key, value)
  }
  return encoded
}

/** Exported for the round-trip tests; not part of the sync surface. */
export const bambuPresetCodecInternals = { escapeStringsCStyle, unescapeStringsCStyle }
