#!/usr/bin/env node
/**
 * Generates the numeric model behind BambuStudio's flush-volume auto-calculation.
 *
 * Every constant here is a literal compiled into the slicer, so unlike the measured flush TABLES
 * (which we read from the slicer image at runtime, and which therefore track it for free) these
 * cannot be discovered at runtime — they can only be mirrored. Mirroring by hand is the risk: a
 * vendor bump that retunes, say, the 560 brightness scale would leave us confidently showing users
 * the previous release's purge volumes with nothing failing. So they are generated, and
 * `flush-volume-calc.test.ts` re-derives them from the vendored source and fails on any difference.
 *
 * Sources:
 *   src/libslic3r/FlushVolCalc.cpp        - the colour formula and the support/ceiling constants
 *   src/libslic3r/FlushVolPredictor.cpp   - which dataset code maps to which measured table
 *   src/libslic3r/FlushVolPredictor.hpp   - the DeltaE2000 threshold for "the same colour"
 *   src/slic3r/GUI/WipeTowerDialog.cpp    - the multiplier range the dialog accepts
 *
 * Usage:
 *   node scripts/dev/generate-flush-volume-model.mjs [--src <bambustudio-src>]
 *
 * Output: packages/shared/src/generated/flush-volume-model.generated.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
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
 * Read exactly one capture out of `source`, or die.
 *
 * Deliberately strict about matching once: a pattern that starts matching two places after a vendor
 * bump would silently pick whichever came first, which is how a mirror ends up quietly wrong. A
 * hard failure sends whoever bumped the source to look at what moved.
 */
export function extractOne(source, pattern, label) {
  const matches = [...source.matchAll(pattern)]
  if (matches.length === 0) throw new Error(`Could not find ${label} — the vendored BambuStudio source changed shape`)
  if (matches.length > 1) throw new Error(`Found ${matches.length} candidates for ${label} — tighten the pattern`)
  return matches[0]
}

function extractNumber(source, pattern, label) {
  const value = Number(extractOne(source, pattern, label)[1])
  if (!Number.isFinite(value)) throw new Error(`${label} did not parse as a number`)
  return value
}

/** Every constant the calculator needs, pulled out of the vendored source. */
export function extractFlushVolumeModel(src) {
  const calc = readFileSync(path.join(src, 'src/libslic3r/FlushVolCalc.cpp'), 'utf8')
  const predictorCpp = readFileSync(path.join(src, 'src/libslic3r/FlushVolPredictor.cpp'), 'utf8')
  const predictorHpp = readFileSync(path.join(src, 'src/libslic3r/FlushVolPredictor.hpp'), 'utf8')
  const dialog = readFileSync(path.join(src, 'src/slic3r/GUI/WipeTowerDialog.cpp'), 'utf8')

  const luminance = extractOne(
    calc,
    /return r \* ([\d.]+) \+ g \* ([\d.]+) \+ b \* ([\d.]+);/g,
    'the luminance weights (get_luminance)'
  )

  const darker = extractOne(
    calc,
    /float inter_hsv_v = ([\d.]+) \* to_hsv_v \+ ([\d.]+) \* from_hsv_v;/g,
    'the darker-destination hue cap weights'
  )

  const datasetFiles = {}
  for (const match of predictorCpp.matchAll(/dataset_value == (\d+)\)\s*\n\s*path \+= "\/([^"]+)";/g)) {
    datasetFiles[Number(match[1])] = match[2]
  }
  if (Object.keys(datasetFiles).length === 0) {
    throw new Error('Could not find the dataset-code -> data-file mapping (GenericFlushPredictor)')
  }

  return {
    minVolumeFromSupport: extractNumber(calc, /g_min_flush_volume_from_support = (\d+);/g, 'g_min_flush_volume_from_support'),
    volumeToSupport: extractNumber(calc, /g_flush_volume_to_support = (\d+);/g, 'g_flush_volume_to_support'),
    maxVolume: extractNumber(calc, /g_max_flush_volume = (\d+);/g, 'g_max_flush_volume'),
    minMultiplier: extractNumber(dialog, /g_min_flush_multiplier = ([\d.]+)f;/g, 'g_min_flush_multiplier'),
    maxMultiplier: extractNumber(dialog, /g_max_flush_multiplier = ([\d.]+)f;/g, 'g_max_flush_multiplier'),
    luminanceWeights: { r: Number(luminance[1]), g: Number(luminance[2]), b: Number(luminance[3]) },
    hueSaturationCap: extractNumber(calc, /return std::min\(([\d.]+)f, dxy\);/g, 'the hue/saturation distance cap'),
    hueSaturationScale: extractNumber(calc, /float hs_flush = ([\d.]+)f \* hs_dist;/g, 'the hue/saturation scale'),
    brighterExponent: extractNumber(calc, /std::pow\(to_lumi - from_lumi, ([\d.]+)f\)/g, 'the brighter-destination exponent'),
    brighterScale: extractNumber(calc, /std::pow\(to_lumi - from_lumi, [\d.]+f\) \* ([\d.]+)f;/g, 'the brighter-destination scale'),
    darkerScale: extractNumber(calc, /lumi_flush = \(from_lumi - to_lumi\) \* ([\d.]+)f;/g, 'the darker-destination scale'),
    darkerHueCapWeights: { to: Number(darker[1]), from: Number(darker[2]) },
    combineAngleDegrees: extractNumber(calc, /calc_triangle_3rd_edge\(hs_flush, lumi_flush, ([\d.]+)f\);/g, 'the term-combining angle'),
    volumeFloor: extractNumber(calc, /flush_volume = std::max\(flush_volume, ([\d.]+)f\);/g, 'the computed-volume floor'),
    darkColorThresholdNumerator: extractNumber(calc, /dark_color_thres = ([\d.]+)f\/255\.f;/g, 'dark_color_thres'),
    lightColorThresholdNumerator: extractNumber(calc, /light_color_thres = ([\d.]+)f\/255\.f;/g, 'light_color_thres'),
    darkToLightBoost: extractNumber(calc, /flush_volume \*= ([\d.]+);/g, 'the dark-to-light boost'),
    similarColorThreshold: extractNumber(predictorHpp, /float distance_threshold = ([\d.]+)\)/g, 'the is_similar_color threshold'),
    datasetFiles
  }
}

function render(model) {
  return `/**
 * GENERATED by scripts/dev/generate-flush-volume-model.mjs: do not edit.
 *
 * The compiled-in half of BambuStudio's flush-volume calculation, mirrored from the vendored
 * source. The other half (the measured tables under \`resources/flush/\`) is NOT here: it is read
 * from the slicer image at runtime, so it follows whichever BambuStudio actually slices. These
 * constants cannot be, which is why they are generated rather than typed: re-run the generator
 * after vendoring a newer BambuStudio, and \`flush-volume-calc.test.ts\` fails if this drifts.
 *
 * Consumed by \`flush-volume-calc.ts\`; see that module for what each term does.
 */

export interface FlushVolumeModel {
  /** \`g_min_flush_volume_from_support\`: floor when swapping AWAY from support material (mm3). */
  minVolumeFromSupport: number
  /** \`g_flush_volume_to_support\`: flat cost when swapping TO support material (mm3). */
  volumeToSupport: number
  /** \`g_max_flush_volume\`: ceiling every calculated volume is clamped to (mm3). */
  maxVolume: number
  /** Multiplier range the flushing dialog accepts. */
  minMultiplier: number
  maxMultiplier: number
  /** Perceptual luminance weights (\`get_luminance\`). */
  luminanceWeights: { r: number; g: number; b: number }
  /** Cap on the HSV-disc distance, so opposite hues cannot run away. */
  hueSaturationCap: number
  /** mm3 per unit of hue/saturation distance. */
  hueSaturationScale: number
  /** Exponent and scale for a destination BRIGHTER than the source. */
  brighterExponent: number
  brighterScale: number
  /** mm3 per unit of luminance drop when the destination is DARKER. */
  darkerScale: number
  /** Weights blending destination/source value into the hue cap on a darker destination. */
  darkerHueCapWeights: { to: number; from: number }
  /** Angle the hue and luminance terms are combined at (law of cosines), in degrees. */
  combineAngleDegrees: number
  /** Floor applied to the computed volume before the dead-volume term (mm3). */
  volumeFloor: number
  /**
   * Numerators of \`dark_color_thres\` / \`light_color_thres\`, both divided by 255 in the source and
   * then compared against a 0-255 luminance; see the fidelity note in \`flush-volume-calc.ts\`.
   */
  darkColorThresholdNumerator: number
  lightColorThresholdNumerator: number
  /** Multiplier applied to a dark -> light swap on the dual-nozzle datasets. */
  darkToLightBoost: number
  /** DeltaE2000 within which a colour counts as a measured table entry. */
  similarColorThreshold: number
  /** \`nozzle_flush_dataset\` code -> path of its table under the BambuStudio resources directory. */
  datasetFiles: Readonly<Record<string, string>>
}

export const FLUSH_VOLUME_MODEL: FlushVolumeModel = ${JSON.stringify(model, null, 2)}
`
}

// Only when RUN, not when imported: `flush-volume-calc.test.ts` imports `extractFlushVolumeModel`
// to re-derive the constants and compare, so importing this file must not rewrite the output.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { src } = parseArgs(process.argv.slice(2))
  const model = extractFlushVolumeModel(src)
  const outPath = path.join(repoRoot, 'packages/shared/src/generated/flush-volume-model.generated.ts')
  mkdirSync(path.dirname(outPath), { recursive: true })
  writeFileSync(outPath, render(model))
  console.log(`Wrote ${outPath}`)
  console.log(`  datasets: ${Object.entries(model.datasetFiles).map(([code, file]) => `${code} -> ${file}`).join(', ')}`)
}
