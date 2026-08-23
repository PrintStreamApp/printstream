/**
 * The rules for a value that reaches the engine and makes things WORSE than not writing it at all.
 *
 * OWNS the check every writer of `project_settings.config` runs before it lays overrides over a
 * config. Clearing a numeric field in a settings dialog produces `""`, which is emitted as a change
 * (it differs from the old value) and written verbatim, and BambuStudio's scalar deserialisers fail
 * on it: `ConfigOptionFloat::deserialize` reads through an `istringstream` and returns false on the
 * failbit (`Config.hpp:842-848`, and identically for `ConfigOptionInt` at `:1013-1019`), which
 * `set_deserialize` turns into a thrown `BadOptionValueException` (`Config.cpp:573-577`). The
 * substitution rescue that saves enums and bools (`Config.cpp:642-655`) deliberately does not cover
 * numerics, so there is no fallback.
 *
 * WHY IT IS WORSE THAN ONE BAD KEY. The throw unwinds the whole key loop in `load_from_json` into a
 * generic catch that logs and returns -1 (`Config.cpp:1135-1139`), so every key not yet applied is
 * dropped. nlohmann's object type iterates in key order, which makes the damage arbitrary and
 * alphabetical: clearing `bottom_shell_layers` loses most of the file, clearing `wall_loops` loses
 * almost nothing. For an EMBEDDED preset it is total, the whole entry is skipped
 * (`bbs_3mf.cpp:2732-2737`). None of it is reported to the user: `add_error` only appends to a list
 * that is written to the boost log and never consulted, and the file still opens.
 *
 * WHY DROPPING IS THE RIGHT ANSWER, not throwing and not writing. An empty numeric carries no
 * information: it means the user cleared the box, so the only available reading is "leave this
 * setting as it was", which is exactly what omitting the override does. There is nothing to lose by
 * dropping it, and nothing to guess. Contrast {@link assertPlacedObjectsExist} and the plate-density
 * guard, which throw because their inputs assert something false rather than nothing.
 *
 * SCOPE. Numeric types only, scalars AND vector elements. An empty STRING option is legitimate (a
 * custom gcode field the user deliberately cleared), and `ConfigOptionString` accepts it, so
 * blanket-dropping every empty would silently refuse a real edit.
 */
import { processSettingsCatalog, type ProcessSettingOption, type ProcessSettingsCatalog } from './process-settings.js'

/**
 * Keys BambuStudio's `handle_legacy` ERASES on sight of a `%` (`PrintConfig.cpp:6945-6955`).
 *
 * These were percentages in an old profile format and are absolute values now, so rather than
 * convert, the engine drops the key to avoid a parse error. Copied verbatim from that list,
 * including the two scalars: our settings dialog renders vector options as FREE TEXT (a vector packs
 * several values into one string), which is how a `%` reaches them at all.
 *
 * The consequence is a silent revert to `FullPrintConfig::defaults()`, not to the printer's preset:
 * a 3MF's project config is flat, so an erased key does not fall back to the vendor system value.
 * On a fast machine whose preset says 200+ mm/s, `outer_wall_speed` lands on 60. The user is told
 * nothing (the `unrecogized_keys` list only surfaces in develop mode behind a version check), and
 * OUR dialog keeps displaying the typed value, so both sides disagree with the engine silently.
 */
const PERCENT_ERASES_KEY: ReadonlySet<string> = new Set([
  'initial_layer_print_height',
  'initial_layer_speed',
  'internal_solid_infill_speed',
  'top_surface_speed',
  'support_interface_speed',
  'outer_wall_speed',
  'support_object_xy_distance'
])

/** Types BambuStudio parses with a numeric `istringstream`, which an empty string fails. */
const NUMERIC_SETTING_TYPES = new Set(['int', 'float', 'percent', 'floatOrPercent'])

/**
 * Whether writing `value` for `key` would produce a config entry the engine throws on, or silently
 * erases.
 *
 * An option the catalog does not know is treated as safe: refusing a value we cannot classify would
 * drop overrides for every key the catalog is scoped away from (the tune dialogs cover a subset),
 * and an unknown key is one `handle_legacy` discards anyway.
 */
export function isEngineHostileValue(
  key: string,
  value: string | string[] | undefined,
  catalog: ProcessSettingsCatalog = processSettingsCatalog
): boolean {
  // A `%` in one of the legacy-percent keys makes the engine erase the key outright, which is
  // strictly worse than not writing the override: the setting falls back to the engine's own
  // default instead of keeping the value it had. Checked before the empty test because it applies
  // to VECTOR options too, which is where a `%` can actually be typed.
  if (PERCENT_ERASES_KEY.has(key) && containsPercent(value)) return true
  const option: ProcessSettingOption | undefined = catalog.options[key]
  if (!option || !NUMERIC_SETTING_TYPES.has(option.type)) return false
  // A VECTOR is checked element-wise, not exempted. The exemption assumed an empty vector arrives as
  // `[]`, but the settings dialog writes into element 0 of the resolved config, so clearing the box
  // sends `["", "200"]` on a multi-extruder machine and a bare `""` on a single-extruder one. Neither
  // is refused by the engine, which is the problem: `ConfigOptionFloatsTempl::deserialize` returns
  // true regardless (`Config.hpp:917-937`), turning the first into a silent 0 and the second into a
  // ZERO-LENGTH per-extruder vector whose `get_at` then reads out of bounds in release builds.
  if (Array.isArray(value)) return value.some((entry) => typeof entry === 'string' && entry.trim() === '')
  return typeof value === 'string' && value.trim() === ''
}

/** True when any element of a scalar or vector value carries a percent sign. */
function containsPercent(value: string | string[] | undefined): boolean {
  if (typeof value === 'string') return value.includes('%')
  return Array.isArray(value) && value.some((entry) => typeof entry === 'string' && entry.includes('%'))
}

/**
 * The overrides worth writing: everything the engine will not throw on or silently erase.
 *
 * Returns the SAME object when nothing was dropped, so the common path allocates nothing and a
 * caller can cheaply tell whether anything was refused.
 */
export function dropEngineHostileOverrides<T extends Record<string, string | string[]>>(
  overrides: T,
  catalog: ProcessSettingsCatalog = processSettingsCatalog
): T {
  const hostile = Object.keys(overrides).filter((key) => isEngineHostileValue(key, overrides[key], catalog))
  if (hostile.length === 0) return overrides
  const kept = { ...overrides }
  for (const key of hostile) delete kept[key]
  return kept
}
