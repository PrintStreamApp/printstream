/**
 * Guards the vendored mirror in `variant-options.ts` against drift.
 *
 * Those two sets are copied out of BambuStudio's `PrintConfig.cpp`, and being a COPY is the whole
 * risk: nothing about our build notices when a vendor bump changes them, and a wrong width silently
 * corrupts saved projects rather than failing loudly (a per-slot key written at variant width made a
 * 3-material project reopen with 6). So when the vendored source is present, re-derive both sets
 * from it and require an exact match.
 *
 * SKIPS when `tmp/bambustudio-src` is absent, it is a developer convenience, not a checked-in
 * dependency, so this must not fail a machine or a CI job that never vendored it. That makes the
 * test a ratchet for whoever DOES have the source (i.e. whoever is bumping it), which is exactly
 * when drift is introduced.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { FILAMENT_OPTIONS_WITH_VARIANT, PRINT_OPTIONS_WITH_VARIANT } from './variant-options.js'
import { FILAMENT_PRESET_OPTIONS, PRINTER_PRESET_OPTIONS, PRINT_PRESET_OPTIONS } from './generated/preset-options.generated.js'

/** Walk up from this file to the workspace root (the directory holding `packages/`). */
function findWorkspaceRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'packages')) && existsSync(join(dir, 'apps'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * The identifiers inside `std::set<std::string> <name> = { … };`.
 *
 * Deliberately literal about the declaration it matches: a loose search would happily read a
 * DIFFERENT set and then "pass" against the wrong vendor data, which is worse than not running.
 */
function extractCppSet(source: string, name: string): string[] {
  const declaration = `std::set<std::string> ${name} = {`
  const start = source.indexOf(declaration)
  assert.notEqual(start, -1, `${name} not found in PrintConfig.cpp: the vendored source changed shape`)
  const end = source.indexOf('\n};', start)
  assert.notEqual(end, -1, `${name} has no closing brace`)
  return [...source.slice(start + declaration.length, end).matchAll(/"([A-Za-z_0-9]+)"/g)].map((match) => match[1]!)
}

const root = findWorkspaceRoot()
const printConfig = root ? join(root, 'tmp/bambustudio-src/src/libslic3r/PrintConfig.cpp') : null
const vendored = printConfig !== null && existsSync(printConfig)

test('the vendored variant-option sets still match BambuStudio', { skip: vendored ? false : 'tmp/bambustudio-src not vendored' }, () => {
  const source = readFileSync(printConfig!, 'utf8')

  for (const [name, ours] of [
    ['filament_options_with_variant', FILAMENT_OPTIONS_WITH_VARIANT],
    ['print_options_with_variant', PRINT_OPTIONS_WITH_VARIANT]
  ] as const) {
    const theirs = new Set(extractCppSet(source, name))
    const missing = [...theirs].filter((key) => !ours.has(key))
    const extra = [...ours].filter((key) => !theirs.has(key))

    // Reported separately because the two failure modes have opposite consequences: a MISSING key
    // means we write a variant-scoped option at one column (BambuStudio then reads past the end),
    // an EXTRA one means we widen a per-slot option (which is what inflated the material list).
    assert.deepEqual(missing, [], `${name}: keys BambuStudio has that our mirror is missing`)
    assert.deepEqual(extra, [], `${name}: keys in our mirror that BambuStudio does not have`)
  }
})

/** The identifiers in a brace-delimited C++ list, with commented-out entries excluded. */
function extractCppList(source: string, declaration: string): Set<string> {
  const start = source.indexOf(declaration)
  assert.notEqual(start, -1, `${declaration} not found: the vendored source changed shape`)
  const open = source.indexOf('{', start)
  const end = source.indexOf('};', open)
  const body = source.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, '')
  return new Set([...body.matchAll(/"([A-Za-z_0-9]+)"/g)].map((m) => m[1]!))
}

/** Metadata BambuStudio keeps in the same vectors; the generated lists are settings only. */
const NON_SETTING = ['inherits', 'compatible_printers', 'compatible_printers_condition', 'compatible_prints', 'compatible_prints_condition']

/**
 * `Preset::printer_options()` is a CONCATENATION of three vectors, and the third, the extruder
 * options, is where `nozzle_diameter`, `extruder_offset` and `extruder_colour` live. This test
 * exists mostly to pin that: mirroring only the literal `s_Preset_printer_options` yields a list
 * missing the single most load-bearing machine key, and the retarget filters its copy by this list,
 * so the omission would silently stop writing the target machine's nozzle diameter.
 */
test('the vendored printer and process option lists still match BambuStudio', { skip: vendored ? false : 'tmp/bambustudio-src not vendored' }, () => {
  const preset = readFileSync(join(root!, 'tmp/bambustudio-src/src/libslic3r/Preset.cpp'), 'utf8')
  const printConfig = readFileSync(join(root!, 'tmp/bambustudio-src/src/libslic3r/PrintConfig.cpp'), 'utf8')

  const printer = new Set([
    ...extractCppList(preset, 's_Preset_printer_options'),
    ...extractCppList(preset, 's_Preset_machine_limits_options'),
    ...extractCppList(printConfig, 'm_extruder_option_keys =')
  ])
  for (const key of NON_SETTING) printer.delete(key)
  assert.deepEqual([...printer].filter((key) => !PRINTER_PRESET_OPTIONS.has(key)), [], 'printer options BambuStudio carries that our list is missing')
  assert.deepEqual([...PRINTER_PRESET_OPTIONS].filter((key) => !printer.has(key)), [], 'printer options in our list that BambuStudio does not carry')
  // The concatenation, named. If these ever come from one vector the test above passes vacuously.
  for (const key of ['nozzle_diameter', 'extruder_offset', 'extruder_colour']) {
    assert.ok(PRINTER_PRESET_OPTIONS.has(key), `${key} comes from the extruder vector and must survive the merge`)
  }

  const print = extractCppList(preset, 's_Preset_print_options')
  for (const key of NON_SETTING) print.delete(key)
  assert.deepEqual([...print].filter((key) => !PRINT_PRESET_OPTIONS.has(key)), [], 'process options BambuStudio carries that our list is missing')
  assert.deepEqual([...PRINT_PRESET_OPTIONS].filter((key) => !print.has(key)), [], 'process options in our list that BambuStudio does not carry')
})

/**
 * The same ratchet for `s_Preset_filament_options` (Preset.cpp), which decides WHICH keys a saved
 * project's filament block must carry. Drift here is silent and expensive: a key BambuStudio adds
 * and we do not write reads to it as a deviation from the preset, so it stops binding the slot to
 * the user's preset and mints a `(<project>.3mf)` copy instead.
 */
test('the vendored filament preset option list still matches BambuStudio', { skip: vendored ? false : 'tmp/bambustudio-src not vendored' }, () => {
  const preset = readFileSync(join(root!, 'tmp/bambustudio-src/src/libslic3r/Preset.cpp'), 'utf8')
  const start = preset.indexOf('s_Preset_filament_options')
  assert.notEqual(start, -1, 's_Preset_filament_options not found: Preset.cpp changed shape')
  const open = preset.indexOf('{', start)
  const end = preset.indexOf('};', open)
  // Commented-out entries are deliberately excluded by BambuStudio, so they must not count.
  const body = preset.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, '')
  const theirs = new Set([...body.matchAll(/"([A-Za-z_0-9]+)"/g)].map((m) => m[1]!))

  // Metadata BambuStudio keeps in the same vector; the generated list is settings only.
  for (const meta of ['inherits', 'compatible_printers', 'compatible_printers_condition', 'compatible_prints', 'compatible_prints_condition']) {
    theirs.delete(meta)
  }

  const missing = [...theirs].filter((key) => !FILAMENT_PRESET_OPTIONS.has(key))
  const extra = [...FILAMENT_PRESET_OPTIONS].filter((key) => !theirs.has(key))
  assert.deepEqual(missing, [], 'options BambuStudio carries that our generated list is missing')
  assert.deepEqual(extra, [], 'options in our generated list that BambuStudio does not carry')
})
