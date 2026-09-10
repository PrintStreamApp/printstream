#!/usr/bin/env node
/**
 * Generates BambuStudio's filament blacklist: the rules deciding that a given material must not, or
 * should not, be printed from a given slot on a given machine.
 *
 * Why generated rather than vendored verbatim, or hand-written:
 *
 * - The rules are DATA in BambuStudio (`resources/printers/filaments_blacklist.json`), so a vendor
 *   bump retunes them. Hand-copying is how a mirror ends up quietly a release behind, and these
 *   rules are the difference between refusing a print that would clog a nozzle and allowing it.
 * - The rules key on Bambu's INTERNAL model codes (`C11`, `O1E`, `N7`), which are not our
 *   `PrinterModel` keys. Resolving them here, at generation time, against BambuStudio's own
 *   `resources/printers/<code>.json` display names is what keeps the mapping honest: an unknown
 *   code fails the generator instead of silently matching no printer, which would read as "this
 *   material is fine on your machine".
 * - Two of the rule fields (`nozzle_flows`, the `%s` substitution) need translating into our own
 *   vocabulary. Doing it once here beats re-deriving it at every call site.
 *
 * The message substitution deserves its own note. BambuStudio picks which value fills a `%s` by
 * comparing the raw English `description` byte-for-byte against a hardcoded if/else chain
 * (`DevFilaBlackList.cpp:263-280`). A description carrying `%s` that the chain does not know renders
 * with a literal `%s` in Studio's own UI. We resolve that to a named substitution at generation
 * time and HARD FAIL on an unrecognised `%s` description, so a vendor bump that adds one sends
 * whoever bumped the source here rather than shipping "%s may fail to load" to a user.
 *
 * Sources:
 *   resources/printers/filaments_blacklist.json - the rules themselves
 *   resources/printers/<model_code>.json        - `display_name`, for the code -> PrinterModel map
 *   src/slic3r/GUI/DeviceCore/DevFilaBlackList.cpp - the matcher, mirrored by filament-blacklist.ts
 *   src/slic3r/GUI/DeviceCore/DevNozzleSystem.cpp  - the nozzle-flow display strings
 *
 * Usage:
 *   node scripts/dev/generate-filament-blacklist.mjs [--src <bambustudio-src>]
 *
 * Output: packages/shared/src/generated/filament-blacklist.generated.ts
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..')

function parseArgs(argv) {
  let src = path.join(repoRoot, 'tmp', 'bambustudio-src')
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--src') src = path.resolve(argv[++i])
  }
  return { src }
}

/**
 * BambuStudio `display_name` -> our `PrinterModel` key.
 *
 * Keyed on the display name rather than the model code deliberately: the code is the thing we do
 * not already know, and BambuStudio's own resource file is the only authority that maps one to the
 * other. `bambu-model-keys.ts` carries the same mapping for the app's own use and the two are
 * cross-checked in `filament-blacklist.test.ts`; deriving it here anyway is what keeps this
 * generator honest when a vendor bump adds a model, since an unknown display name fails the run
 * instead of quietly emitting a rule that targets no printer.
 */
const MODEL_KEY_BY_DISPLAY_NAME = Object.freeze({
  'Bambu Lab X1': 'X1',
  'Bambu Lab X1 Carbon': 'X1C',
  'Bambu Lab X1E': 'X1E',
  'Bambu Lab X2D': 'X2D',
  'Bambu Lab P1P': 'P1P',
  'Bambu Lab P1S': 'P1S',
  'Bambu Lab P2S': 'P2S',
  'Bambu Lab A1': 'A1',
  'Bambu Lab A1 mini': 'A1mini',
  'Bambu Lab A2L': 'A2L',
  'Bambu Lab H2C': 'H2C',
  'Bambu Lab H2D': 'H2D',
  'Bambu Lab H2D Pro': 'H2DPRO',
  'Bambu Lab H2S': 'H2S'
})

/**
 * BambuStudio's nozzle-flow display strings (`DevNozzle::GetNozzleFlowTypeString`) -> our
 * `PrinterNozzleFlow`.
 *
 * "E3D High Flow" folds onto `high` because our status parser already folds it there: the nozzle
 * type code's flow token `E` and `H` both decode to `high` (`bambu-report-parser.ts`,
 * `parseNozzleTypeInfo`). No shipped rule uses the E3D string today, and the rules that DO target
 * an E3D hotend say `High Flow` plus a P1/X1 model, which is exactly how that upgrade reports.
 */
const NOZZLE_FLOW_BY_STUDIO_LABEL = Object.freeze({
  Standard: 'standard',
  'High Flow': 'high',
  'TPU High Flow': 'tpu-high',
  'E3D High Flow': 'high'
})

/**
 * Which value fills a rule description's `%s`, mirroring `DevFilaBlackList.cpp:263-280`.
 *
 * `nameSuffixOrFilamentName` is Studio's one two-branch case: it prefers the rule's own
 * `name_suffix`, UPPERCASED, and falls back to the filament's name when the rule has no suffix.
 */
const SUBSTITUTION_BY_DESCRIPTION = Object.freeze({
  'When using %s on the right extruder, it can only be used as support material.': 'nameSuffixOrFilamentName',
  '%s has a risk of nozzle clogging when using 0.4mm high-flow nozzles. Use with caution.': 'filamentName',
  '%s filaments are hard and brittle and could break in AMS, and there is also a risk of nozzle clogging when using 0.4mm high-flow nozzles. Use with caution.': 'filamentType',
  '%s has a risk of nozzle clogging when using 0.4, 0.6, 0.8mm high-flow nozzles. Use with caution.': 'filamentName',
  '%s may fail to load or unload due to the Filament Track Switch. If you wish to continue.': 'filamentName'
})

/**
 * The firmware version under which a printer config file keeps its base facts.
 *
 * These files are keyed by firmware version, each later key overlaying only the `print` block it
 * changes; `display_name` and `model_id` live solely in the base. BambuStudio reads them the same
 * way (`DevPrinterConfigUtil::get_json_from_config` starts from this key).
 */
const BASE_CONFIG_VERSION = '00.00.00.00'

/** Read every `resources/printers/<code>.json`, returning the model code -> PrinterModel map. */
export function extractModelCodeMap(src) {
  const dir = path.join(src, 'resources', 'printers')
  const map = {}
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.json') || file === 'filaments_blacklist.json') continue
    const parsed = JSON.parse(readFileSync(path.join(dir, file), 'utf8'))
    const base = parsed[BASE_CONFIG_VERSION]
    if (!base) throw new Error(`resources/printers/${file} has no "${BASE_CONFIG_VERSION}" block; the vendored source changed shape`)
    const displayName = base.display_name
    if (typeof displayName !== 'string') {
      throw new Error(`resources/printers/${file} has no display_name under "${BASE_CONFIG_VERSION}"`)
    }
    const key = MODEL_KEY_BY_DISPLAY_NAME[displayName]
    if (!key) {
      throw new Error(
        `resources/printers/${file} has display_name ${JSON.stringify(displayName)}, which maps to no PrinterModel. `
        + 'Add it to MODEL_KEY_BY_DISPLAY_NAME (and to printerModelSchema) before regenerating.'
      )
    }
    map[path.basename(file, '.json')] = key
  }
  return map
}

/** The blacklist rules, translated into our vocabulary. */
export function extractFilamentBlacklist(src) {
  const modelCodes = extractModelCodeMap(src)
  const raw = JSON.parse(readFileSync(path.join(src, 'resources', 'printers', 'filaments_blacklist.json'), 'utf8'))
  const rules = []

  for (const [index, item] of (raw.blacklist ?? []).entries()) {
    const action = item.action ?? ''
    const description = item.description ?? ''
    if (action !== 'prohibition' && action !== 'warning') {
      throw new Error(`blacklist[${index}] has action ${JSON.stringify(action)}; expected "prohibition" or "warning"`)
    }
    if (!description) throw new Error(`blacklist[${index}] has no description`)

    let substitution = null
    if (description.includes('%s')) {
      substitution = SUBSTITUTION_BY_DESCRIPTION[description]
      if (!substitution) {
        throw new Error(
          `blacklist[${index}] description ${JSON.stringify(description)} carries "%s" but has no substitution rule. `
          + 'Add it to SUBSTITUTION_BY_DESCRIPTION, mirroring DevFilaBlackList.cpp, before regenerating.'
        )
      }
    }

    const modelKeys = (item.model_id ?? []).map((code) => {
      const key = modelCodes[code]
      if (!key) {
        throw new Error(
          `blacklist[${index}] targets model_id ${JSON.stringify(code)}, which has no resources/printers/${code}.json. `
          + 'A rule matching no printer would silently pass every material, so this is fatal.'
        )
      }
      return key
    })

    const nozzleFlows = (item.nozzle_flows ?? []).map((label) => {
      const flow = NOZZLE_FLOW_BY_STUDIO_LABEL[label]
      if (!flow) {
        throw new Error(
          `blacklist[${index}] targets nozzle flow ${JSON.stringify(label)}, which maps to no PrinterNozzleFlow. `
          + 'Add it to NOZZLE_FLOW_BY_STUDIO_LABEL before regenerating.'
        )
      }
      return flow
    })

    if (item.slot !== undefined && item.slot !== 'ams' && item.slot !== 'ext') {
      throw new Error(`blacklist[${index}] has slot ${JSON.stringify(item.slot)}; expected "ams" or "ext"`)
    }
    if (item.vendor !== undefined) {
      const vendor = item.vendor.toLowerCase()
      if (vendor !== 'bambu lab' && vendor !== 'third party') {
        throw new Error(
          `blacklist[${index}] has vendor ${JSON.stringify(item.vendor)}. BambuStudio only gives meaning to `
          + '"Bambu Lab" and "third party"; any other value makes the rule unmatchable.'
        )
      }
    }

    // Only emit the keys a rule actually constrains. An absent key means "matches anything", and
    // spelling that out as an empty array per rule would triple the file for no added meaning.
    rules.push({
      action,
      description,
      ...(substitution ? { substitution } : {}),
      ...(item.wiki ? { wiki: item.wiki } : {}),
      ...(modelKeys.length ? { modelKeys } : {}),
      ...(nozzleFlows.length ? { nozzleFlows } : {}),
      ...(item.nozzle_diameters?.length ? { nozzleDiameters: item.nozzle_diameters } : {}),
      ...(item.vendor ? { vendor: item.vendor.toLowerCase() } : {}),
      ...(item.calib_mode ? { calibMode: item.calib_mode.toLowerCase() } : {}),
      ...(item.type ? { type: item.type.toLowerCase() } : {}),
      ...(item.types?.length ? { types: item.types.map((value) => value.toLowerCase()) } : {}),
      ...(item.type_suffix ? { typeSuffix: item.type_suffix.toLowerCase() } : {}),
      ...(item.name ? { name: item.name.toLowerCase() } : {}),
      ...(item.name_suffix ? { nameSuffix: item.name_suffix.toLowerCase() } : {}),
      ...(item.used_for_print_support !== undefined ? { usedForSupport: item.used_for_print_support } : {}),
      ...(item.used_for_print_object !== undefined ? { usedForObject: item.used_for_print_object } : {}),
      ...(item.has_filament_switch !== undefined ? { hasFilamentSwitch: item.has_filament_switch } : {}),
      ...(item.slot ? { slot: item.slot } : {}),
      ...(item.extruder_id?.length ? { extruderIds: item.extruder_id } : {}),
      ...(item.white_names?.length ? { whiteNames: item.white_names.map((value) => value.toLowerCase()) } : {}),
      ...(item.white_fila_ids?.length ? { whiteFilamentIds: item.white_fila_ids } : {})
    })
  }

  if (rules.length === 0) throw new Error('filaments_blacklist.json produced no rules; the vendored source changed shape')
  return { rules, modelCodes }
}

function render({ rules, modelCodes }) {
  const prohibitions = rules.filter((rule) => rule.action === 'prohibition').length
  return `/**
 * GENERATED FILE - DO NOT EDIT.
 *
 * Regenerate with: node scripts/dev/generate-filament-blacklist.mjs
 * Source: BambuStudio \`resources/printers/filaments_blacklist.json\` (vendored at tmp/bambustudio-src)
 *
 * ${rules.length} rules (${prohibitions} prohibition, ${rules.length - prohibitions} warning).
 * The matcher that runs these lives in \`../filament-blacklist.ts\`; read its header first.
 */

/** A rule either forbids the combination outright, or advises against it. */
export type FilamentBlacklistAction = 'prohibition' | 'warning'

/** Which value fills the description's \`%s\`. See the generator header for BambuStudio's rule. */
export type FilamentBlacklistSubstitution = 'filamentName' | 'filamentType' | 'nameSuffixOrFilamentName'

/**
 * One rule. Every predicate field is OPTIONAL and an absent field means "matches anything" -- that
 * is BambuStudio's semantics, not a shortcut, and there is no wildcard sentinel value.
 *
 * The string predicates are stored already lower-cased (the matcher lower-cases the query to suit),
 * with two exceptions that BambuStudio compares case-sensitively: \`modelKeys\` and
 * \`whiteFilamentIds\`.
 */
export interface FilamentBlacklistRule {
  action: FilamentBlacklistAction
  /** Raw English text, with \`%s\` still in it when \`substitution\` is set. */
  description: string
  substitution?: FilamentBlacklistSubstitution
  /** Bambu help-page URL, shown as a "learn more" affordance. */
  wiki?: string
  /** Printer models this rule applies to, as \`PrinterModel\` keys. */
  modelKeys?: readonly string[]
  nozzleFlows?: readonly string[]
  nozzleDiameters?: readonly number[]
  /** Either \`bambu lab\` or \`third party\`; the latter means "any vendor that is not Bambu". */
  vendor?: string
  calibMode?: string
  type?: string
  types?: readonly string[]
  typeSuffix?: string
  name?: string
  nameSuffix?: string
  usedForSupport?: boolean
  usedForObject?: boolean
  hasFilamentSwitch?: boolean
  /** \`ams\` matches a real AMS slot; \`ext\` matches an external spool (tray 254/255). */
  slot?: 'ams' | 'ext'
  extruderIds?: readonly number[]
  /** EXCLUSIONS: a filament whose name CONTAINS one of these escapes the rule. */
  whiteNames?: readonly string[]
  /** EXCLUSIONS: exact, case-sensitive filament ids that escape the rule. */
  whiteFilamentIds?: readonly string[]
}

export const FILAMENT_BLACKLIST_RULES: readonly FilamentBlacklistRule[] = ${JSON.stringify(rules, null, 2)}

/**
 * Bambu's internal model code -> our \`PrinterModel\` key, derived from BambuStudio's own
 * \`resources/printers/<code>.json\` display names.
 *
 * \`bambu-model-keys.ts\` carries the same mapping for the app's own name matching;
 * \`filament-blacklist.test.ts\` asserts the two agree, so a future edit cannot leave the rules
 * targeting one model while the rest of the app resolves the code to another.
 */
export const BAMBU_MODEL_CODE_TO_MODEL_KEY: Readonly<Record<string, string>> = ${JSON.stringify(modelCodes, null, 2)}
`
}

// Only when RUN, not when imported: `filament-blacklist.test.ts` imports `extractFilamentBlacklist`
// to re-derive the rules and compare, so importing this file must not rewrite the output.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { src } = parseArgs(process.argv.slice(2))
  const model = extractFilamentBlacklist(src)
  const outPath = path.join(repoRoot, 'packages/shared/src/generated/filament-blacklist.generated.ts')
  mkdirSync(path.dirname(outPath), { recursive: true })
  writeFileSync(outPath, render(model))
  console.log(`Wrote ${outPath}`)
  console.log(`  rules: ${model.rules.length} (${model.rules.filter((rule) => rule.action === 'prohibition').length} prohibition)`)
  console.log(`  model codes: ${Object.keys(model.modelCodes).length}`)
}
