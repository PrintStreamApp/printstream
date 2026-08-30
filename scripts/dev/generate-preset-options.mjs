#!/usr/bin/env node
/**
 * Generates the list of options each PRESET KIND carries — filament (with defaults), printer, print.
 *
 * WHY THIS EXISTS SEPARATELY from `generate-filament-settings.mjs`: that one transcribes the tune
 * DIALOG (`TabFilament::build()`), which is what the user can edit — 112 options. A filament preset,
 * and therefore a saved project's filament block, carries BambuStudio's `s_Preset_filament_options`
 * — 143. Authoring a project from the dialog list is structurally incomplete, and BambuStudio reads
 * every absent key as a deviation from the preset, so it declines to bind the slot and mints a
 * `(<project>.3mf)` copy instead. MEASURED on a real project: 24 keys short.
 *
 * The DEFAULTS matter as much as the list. A key no resolved preset mentions still has to be written
 * (BambuStudio writes `pressure_advance: ["0.02",…]`, `filament_extruder_compatibility: ["0",…]`),
 * and writing an empty string in its place is just as much a deviation as omitting it.
 *
 * THE PRINTER LIST IS NOT ONE VECTOR. `Preset::printer_options()` concatenates three: the literal
 * `s_Preset_printer_options`, `s_Preset_machine_limits_options`, and the EXTRUDER options
 * (`PrintConfigDef::init_extruder_option_keys`), which is where `nozzle_diameter`, `extruder_offset`
 * and `extruder_colour` live. Reading only the first vector produces a list that silently omits the
 * single most load-bearing machine key there is.
 *
 * Usage:
 *   node scripts/dev/generate-preset-options.mjs [--src <bambustudio-src>]
 *
 * Output: packages/shared/src/generated/preset-options.generated.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { indexOptionBlocks, parseBlock, resolveEnums } from './lib/bambu-config-parse.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..')

/** Metadata BambuStudio keeps in the same vector but which are not per-filament settings. */
const NON_SETTING_KEYS = new Set([
  'inherits',
  'compatible_printers',
  'compatible_printers_condition',
  'compatible_prints',
  'compatible_prints_condition'
])

function parseArgs(argv) {
  let src = path.join(repoRoot, 'tmp', 'bambustudio-src')
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--src') src = path.resolve(argv[++i])
  }
  return { src }
}

/**
 * The identifiers in a brace-delimited C++ list, e.g.
 * `static std::vector<std::string> s_Preset_filament_options {...};` or `m_extruder_option_keys = {...};`.
 */
export function extractCppIdentifierList(source, declaration) {
  const start = source.indexOf(declaration)
  if (start === -1) throw new Error(`${declaration} not found — the vendored source changed shape`)
  const open = source.indexOf('{', start)
  const end = source.indexOf('};', open)
  if (open === -1 || end === -1) throw new Error(`${declaration} is not brace-delimited as expected`)
  // Commented-out entries (BambuStudio disables `filament_colour` with `/*…*/`) must not be picked
  // up — a key it deliberately excludes is not one we should author. The identifier pattern is
  // case-SENSITIVE on purpose: a lowercase-only match silently skipped `required_nozzle_HRC`.
  const body = source.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, '')
  return [...new Set([...body.matchAll(/"([A-Za-z_0-9]+)"/g)].map((m) => m[1]))]
}

/**
 * `filament_extruder_override_keys` — the filament-side overrides of the printer's extruder options.
 * BambuStudio declares them in a loop with `add_nullable`, so they never appear as individual option
 * blocks and carry no ordinary default; unset serializes as `nil`.
 */
export function extractFilamentOverrideKeys(printConfigCpp) {
  const decl = 'filament_extruder_override_keys = {'
  const start = printConfigCpp.indexOf(decl)
  if (start === -1) throw new Error('filament_extruder_override_keys not found — PrintConfig.cpp changed shape')
  const end = printConfigCpp.indexOf('};', start)
  const body = printConfigCpp.slice(start + decl.length, end).replace(/\/\/[^\n]*/g, '')
  return new Set([...body.matchAll(/"([A-Za-z_0-9]+)"/g)].map((m) => m[1]))
}

const { src } = parseArgs(process.argv.slice(2))
const printConfig = readFileSync(path.join(src, 'src/libslic3r/PrintConfig.cpp'), 'utf8')
const preset = readFileSync(path.join(src, 'src/libslic3r/Preset.cpp'), 'utf8')

const { blocks, varToKey } = indexOptionBlocks(printConfig)
const parsed = {}
for (const [key, { coType, block }] of blocks) parsed[key] = parseBlock(coType, block)
resolveEnums(parsed, varToKey, printConfig)

const overrideKeys = extractFilamentOverrideKeys(printConfig)
const keys = extractCppIdentifierList(preset, 's_Preset_filament_options').filter((key) => !NON_SETTING_KEYS.has(key))
// Mirrors `Preset::printer_options()`, which is a CONCATENATION — see the header.
const printerKeys = [...new Set([
  ...extractCppIdentifierList(preset, 's_Preset_printer_options'),
  ...extractCppIdentifierList(preset, 's_Preset_machine_limits_options'),
  ...extractCppIdentifierList(printConfig, 'm_extruder_option_keys =')
])].filter((key) => !NON_SETTING_KEYS.has(key))
const printKeys = extractCppIdentifierList(preset, 's_Preset_print_options').filter((key) => !NON_SETTING_KEYS.has(key))
const defaults = {}
const withoutDefault = []
for (const key of keys) {
  const value = parsed[key]?.default
  if (value !== undefined) {
    defaults[key] = value
    continue
  }
  // A NULLABLE override has no ordinary default — its unset state IS a value, serialized `nil`.
  // BambuStudio's own saves carry `filament_z_hop: ["nil","nil",…]`, so an empty string there would
  // be a deviation from the preset rather than the absence of one.
  //
  // These keys have no `this->add("…")` block to inspect: BambuStudio generates them in a loop over
  // `filament_extruder_override_keys` (`def = this->add_nullable(opt_key, …)`), each one shadowing
  // the printer's extruder option of the same name minus the `filament_` prefix. So the list has to
  // come from that vector, not from the per-option blocks.
  if (overrideKeys.has(key)) {
    defaults[key] = 'nil'
    continue
  }
  withoutDefault.push(key)
}

const out = `/**
 * GENERATED by scripts/dev/generate-preset-options.mjs: do not edit.
 *
 * The options each preset KIND carries, mirrored from BambuStudio's \`Preset.cpp\`. A saved project's
 * corresponding block must contain these and nothing else: a key BambuStudio does not recognise as
 * belonging to the preset is drift it never wrote, and a key we omit reads as a deviation from the
 * preset; either way it declines to bind the slot and mints a \`(<project>.3mf)\` copy instead.
 *
 * \`FILAMENT_PRESET_DEFAULTS\` is the PrintConfig default per filament option, needed because a key
 * that no resolved preset mentions still has to be written with a real value: an empty string is as
 * much a deviation as an absence.
 *
 * Re-run the generator after vendoring a newer BambuStudio; \`variant-options.test.ts\` fails if this
 * drifts from the vendored source.
 */

/** Options a filament preset carries (settings only; \`inherits\`/\`compatible_*\` excluded). */
export const FILAMENT_PRESET_OPTIONS: ReadonlySet<string> = new Set(${JSON.stringify(keys, null, 2)})

/** PrintConfig default per filament option. Absent for options BambuStudio itself leaves undefaulted. */
export const FILAMENT_PRESET_DEFAULTS: Readonly<Record<string, string>> = ${JSON.stringify(defaults, null, 2)}

/**
 * Options a PRINTER preset carries: \`Preset::printer_options()\`, which concatenates three vectors.
 * The extruder options are the third, and they hold \`nozzle_diameter\`, \`extruder_offset\` and
 * \`extruder_colour\`: mirroring only the literal \`s_Preset_printer_options\` omits them.
 */
export const PRINTER_PRESET_OPTIONS: ReadonlySet<string> = new Set(${JSON.stringify(printerKeys, null, 2)})

/** Options a PROCESS (print) preset carries: \`s_Preset_print_options\`. */
export const PRINT_PRESET_OPTIONS: ReadonlySet<string> = new Set(${JSON.stringify(printKeys, null, 2)})
`

const outPath = path.join(repoRoot, 'packages/shared/src/generated/preset-options.generated.ts')
mkdirSync(path.dirname(outPath), { recursive: true })
writeFileSync(outPath, out)
console.log(`Wrote ${outPath}`)
console.log(`Filament: ${keys.length} (defaults ${Object.keys(defaults).length}), printer: ${printerKeys.length}, print: ${printKeys.length}`)
if (withoutDefault.length > 0) console.log(`  no filament default: ${withoutDefault.join(', ')}`)
