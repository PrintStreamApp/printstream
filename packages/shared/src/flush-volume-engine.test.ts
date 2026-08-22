/**
 * End-to-end check of the flush suggestion against BambuStudio's OWN computed answer.
 *
 * WHY THIS EXISTS SEPARATELY. `flush-volume-calc.test.ts` pins the calculator against Studio's
 * compiled code, but it feeds that calculator inputs WE derived. This suite starts one step
 * earlier — from a real `project_settings.config` — so it covers the derivation too, and that is
 * exactly where the bug was: the calculator was perfect while `readProjectFlushContext` read a
 * variant-wide machine array positionally, mis-pricing every purge on a dual-nozzle machine's
 * SECOND extruder while the first stayed correct. No amount of calculator testing could see it.
 *
 * WHERE THE EXPECTATIONS COME FROM. BambuStudio's CLI computes this matrix itself when handed
 * `--filament-colour`, and `--export-settings` runs that path without slicing (fast, no model
 * needed). Each fixture below is a real export: the machine/filament keys it produced, and the
 * `flush_volumes_matrix` it computed from them. Reproduce with:
 *
 *   bambu-studio --load-settings "<machine>.json;<process>.json" \
 *                --load-filaments "<f1>.json;<f2>.json" \
 *                --filament-colour "#RRGGBBAA;..." --export-settings out.config
 *
 * SKIPS without the vendored BambuStudio resources, since the measured tables live there — same
 * developer-convenience rule as the other vendored-source tests.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { calcFlushVolumesMatrix, parseFlushVolumeDataset, type FlushVolumeDataset } from './flush-volume-calc.js'
import { evaluateFlushCalibration, readProjectFlushContext } from './flush-volume-project.js'
import { FLUSH_VOLUME_MODEL } from './generated/flush-volume-model.generated.js'

/** `[label, the settings the engine exported, the matrix the engine computed from them]`. */
const ENGINE_FIXTURES: Array<[string, Record<string, unknown>, string[]]> = [
  ['H2D white -> black', {
    filament_colour: ['#FFFFFFFF', '#000000FF'], filament_is_support: ['0', '0'],
    nozzle_diameter: ['0.4', '0.4'], nozzle_volume: ['130', '133', '145', '148', '148'],
    nozzle_flush_dataset: ['1', '2', '1', '2', '2'], nozzle_volume_type: ['Standard', 'Standard'],
    extruder_type: ['Direct Drive', 'Direct Drive'],
    printer_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive TPU High Flow'],
    printer_extruder_id: ['1', '1', '2', '2', '2'], enable_long_retraction_when_cut: '2',
    long_retractions_when_cut: ['0', '0', '0', '0', '0'], retraction_distances_when_cut: ['10', '10', '10', '10', '10'],
    filament_long_retractions_when_cut: ['nil', 'nil', 'nil', 'nil'],
    filament_retraction_distances_when_cut: ['nil', 'nil', 'nil', 'nil'], prime_volume_mode: 'Default'
  }, ['0', '90', '900', '0', '0', '90', '900', '0']],

  ['H2D red -> green', {
    filament_colour: ['#FF0000FF', '#00FF00FF'], filament_is_support: ['0', '0'],
    nozzle_diameter: ['0.4', '0.4'], nozzle_volume: ['130', '133', '145', '148', '148'],
    nozzle_flush_dataset: ['1', '2', '1', '2', '2'], nozzle_volume_type: ['Standard', 'Standard'],
    extruder_type: ['Direct Drive', 'Direct Drive'],
    printer_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive TPU High Flow'],
    printer_extruder_id: ['1', '1', '2', '2', '2'], enable_long_retraction_when_cut: '2',
    long_retractions_when_cut: ['0', '0', '0', '0', '0'], retraction_distances_when_cut: ['10', '10', '10', '10', '10'],
    filament_long_retractions_when_cut: ['nil', 'nil', 'nil', 'nil'],
    filament_retraction_distances_when_cut: ['nil', 'nil', 'nil', 'nil'], prime_volume_mode: 'Default'
  }, ['0', '573', '372', '0', '0', '573', '372', '0']],

  ['H2D yellow -> grey', {
    filament_colour: ['#F4EE2AFF', '#5B6579FF'], filament_is_support: ['0', '0'],
    nozzle_diameter: ['0.4', '0.4'], nozzle_volume: ['130', '133', '145', '148', '148'],
    nozzle_flush_dataset: ['1', '2', '1', '2', '2'], nozzle_volume_type: ['Standard', 'Standard'],
    extruder_type: ['Direct Drive', 'Direct Drive'],
    printer_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive TPU High Flow'],
    printer_extruder_id: ['1', '1', '2', '2', '2'], enable_long_retraction_when_cut: '2',
    long_retractions_when_cut: ['0', '0', '0', '0', '0'], retraction_distances_when_cut: ['10', '10', '10', '10', '10'],
    filament_long_retractions_when_cut: ['nil', 'nil', 'nil', 'nil'],
    filament_retraction_distances_when_cut: ['nil', 'nil', 'nil', 'nil'], prime_volume_mode: 'Default'
  }, ['0', '297', '596', '0', '0', '297', '596', '0']],

  // Single-nozzle, three materials, and dataset 0 — the branch where a measured hit picks up the
  // extruder dead volume (black -> yellow is a measured 450, quoted as 513 against a 107 nozzle).
  ['X1C black -> yellow -> green', {
    filament_colour: ['#000000FF', '#F4EE2AFF', '#00AE42FF'], filament_is_support: ['0', '0', '0'],
    nozzle_diameter: ['0.4'], nozzle_volume: ['107', '107'], nozzle_flush_dataset: ['0', '0'],
    nozzle_volume_type: ['Standard'], extruder_type: ['Direct Drive'],
    printer_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow'],
    printer_extruder_id: ['1', '1'], enable_long_retraction_when_cut: '2',
    long_retractions_when_cut: ['0', '0'], retraction_distances_when_cut: ['18', '18'],
    filament_long_retractions_when_cut: ['1', '1', '1', 'nil', '1', '1'],
    filament_retraction_distances_when_cut: ['18', '18', '18', 'nil', '18', '18'], prime_volume_mode: 'Default'
  }, ['0', '513', '475', '183', '0', '213', '138', '303', '0']],

  ['X1C grey -> white -> red', {
    filament_colour: ['#5B6579FF', '#FFFFFFFF', '#C12E1FFF'], filament_is_support: ['0', '0', '0'],
    nozzle_diameter: ['0.4'], nozzle_volume: ['107', '107'], nozzle_flush_dataset: ['0', '0'],
    nozzle_volume_type: ['Standard'], extruder_type: ['Direct Drive'],
    printer_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow'],
    printer_extruder_id: ['1', '1'], enable_long_retraction_when_cut: '2',
    long_retractions_when_cut: ['0', '0'], retraction_distances_when_cut: ['18', '18'],
    filament_long_retractions_when_cut: ['1', '1', '1', 'nil', '1', '1'],
    filament_retraction_distances_when_cut: ['18', '18', '18', 'nil', '18', '18'], prime_volume_mode: 'Default'
  }, ['0', '472', '183', '129', '0', '241', '272', '567', '0']]
]

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

/** The measured tables, from the vendored resources; null when they are not present. */
function loadDatasets(): Record<string, FlushVolumeDataset> | null {
  const root = findWorkspaceRoot()
  if (!root) return null
  const out: Record<string, FlushVolumeDataset> = {}
  for (const [code, relative] of Object.entries(FLUSH_VOLUME_MODEL.datasetFiles)) {
    const file = join(root, 'tmp/bambustudio-src/resources', relative)
    if (!existsSync(file)) return null
    const dataset = parseFlushVolumeDataset(readFileSync(file, 'utf8'))
    if (!dataset) return null
    out[code] = dataset
  }
  return out
}

const hex = (value: string) => ({
  r: Number.parseInt(value.slice(1, 3), 16),
  g: Number.parseInt(value.slice(3, 5), 16),
  b: Number.parseInt(value.slice(5, 7), 16)
})
const alpha = (value: string) => value.length >= 9 ? Number.parseInt(value.slice(7, 9), 16) : 255

test('the suggested matrix equals what BambuStudio computes for the same project', (t) => {
  const datasets = loadDatasets()
  if (!datasets) {
    t.skip('vendored BambuStudio flush resources not present')
    return
  }
  for (const [label, settings, expected] of ENGINE_FIXTURES) {
    const context = readProjectFlushContext(JSON.stringify(settings))
    assert.ok(context, `${label}: settings should be readable`)
    const actual: string[] = []
    for (let extruder = 0; extruder < context.extruderCount; extruder += 1) {
      const block = calcFlushVolumesMatrix({
        filaments: context.filamentColors.map((color, index) => ({
          colors: [hex(color)],
          alphas: [alpha(color)],
          isSupport: context.filamentIsSupport[index] ?? false
        })),
        minFlushVolumes: context.minFlushVolumes[extruder] ?? [],
        datasetCode: context.datasetCodes[extruder] ?? 0,
        dataset: datasets[String(context.datasetCodes[extruder] ?? 0)] ?? null
      })
      for (const row of block) for (const cell of row) actual.push(String(cell))
    }
    assert.deepEqual(actual, expected, label)
  }
})

test('the calibration verdict agrees with the engine, and notices when it does not', (t) => {
  const datasets = loadDatasets()
  if (!datasets) {
    t.skip('vendored BambuStudio flush resources not present')
    return
  }
  const [, settings, engineMatrix] = ENGINE_FIXTURES[0]!
  const settingsJson = JSON.stringify(settings)

  const agreeing = evaluateFlushCalibration({ settingsJson, engineMatrix, datasets })
  assert.equal(agreeing?.agrees, true)

  // A retuned engine: one cell moves and the verdict must say so rather than rounding it away.
  const drifted = [...engineMatrix]
  drifted[1] = String(Number(drifted[1]) + 5)
  assert.equal(evaluateFlushCalibration({ settingsJson, engineMatrix: drifted, datasets })?.agrees, false)

  // Numeric equality, not string equality: the engine serialises `90`, `90.0` and `090` alike and
  // none of those is drift.
  const reformatted = engineMatrix.map((entry) => `${Number(entry).toFixed(1)}`)
  assert.equal(evaluateFlushCalibration({ settingsJson, engineMatrix: reformatted, datasets })?.agrees, true)

  // Unreadable settings are UNKNOWN, never "agrees" — a probe we cannot interpret must not be
  // reported to the user as a verified match.
  assert.equal(evaluateFlushCalibration({ settingsJson: '{}', engineMatrix, datasets }), null)
})
