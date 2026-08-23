/**
 * Pins the flush-volume calculation against BambuStudio itself.
 *
 * {@link STUDIO_PINS} are not hand-computed: each row is the output of BambuStudio's OWN compiled
 * `FlushVolCalculator::calc_flush_vol`, obtained by building `FlushVolCalc.cpp` +
 * `FlushVolPredictor.cpp` + `RGB2HSV` standalone and feeding it these pairs. The full sweep behind
 * them was 69,696 cases (three dataset codes x three dead volumes x an 88-colour palette covering
 * every measured table colour, the extremes and a deterministic spread), which matched exactly; the
 * rows here are the subset checked in so CI verifies the port with no vendored source present.
 *
 * They run with NO dataset, which is both the interesting path (the colour formula, where a
 * transcription slip would hide) and the one that has to be right when a self-hosted install has no
 * slicer to read the measured tables from.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  FLUSH_MIN_VOLUME_FROM_SUPPORT,
  FLUSH_VOLUME_TO_SUPPORT,
  calcFlushVolume,
  calcFlushVolumesMatrix,
  flushColorDistance,
  isSimilarFlushColor,
  lookupMeasuredFlushVolume,
  parseFlushVolumeDataset,
  resolveMinFlushVolumes,
  type FlushVolumeDataset
} from './flush-volume-calc.js'
import { FLUSH_VOLUME_MODEL } from './generated/flush-volume-model.generated.js'

const rgb = (hex: string) => ({
  r: Number.parseInt(hex.slice(1, 3), 16),
  g: Number.parseInt(hex.slice(3, 5), 16),
  b: Number.parseInt(hex.slice(5, 7), 16)
})

/** `[from, to, minFlushVolume, datasetCode, BambuStudio's answer]`. */
const STUDIO_PINS: Array<[string, string, number, number, number]> = [
  ['#000000', '#000000', 0, 0, 60],
  ['#000000', '#FFFFFF', 0, 0, 560],
  ['#FFFFFF', '#000000', 0, 0, 80],
  // Same swap, dual-nozzle dataset: white -> black is the dark-to-light case, so 80 * 1.3.
  ['#FFFFFF', '#000000', 0, 1, 104],
  ['#000000', '#FFFFFF', 0, 1, 560],
  ['#C12E1F', '#00AE42', 0, 0, 336],
  ['#00AE42', '#C12E1F', 0, 0, 171],
  ['#F4EE2A', '#0A2989', 0, 0, 189],
  ['#0A2989', '#F4EE2A', 0, 0, 618],
  ['#D1D3D5', '#545454', 0, 0, 60],
  ['#545454', '#D1D3D5', 0, 0, 344],
  ['#FF6A13', '#8E9089', 130, 0, 347],
  ['#5E43B7', '#FFFFFF', 148, 0, 625],
  ['#010203', '#FEFDFC', 0, 1, 556],
  ['#7F7F7F', '#808080', 0, 0, 60],
  ['#FF0000', '#00FF00', 0, 0, 443],
  ['#00FF00', '#0000FF', 0, 0, 251],
  ['#0000FF', '#FF0000', 0, 0, 393],
  ['#FFFFFF', '#FFFFFE', 0, 0, 60],
  ['#123456', '#654321', 130, 0, 339],
  ['#ABCDEF', '#FEDCBA', 0, 0, 209],
  ['#000000', '#010101', 0, 1, 60],
  ['#FFFFFF', '#FFFFFF', 148, 0, 208],
  ['#F4EE2A', '#F4EE2B', 0, 0, 60]
]

test('the colour formula reproduces BambuStudio exactly', () => {
  for (const [from, to, minFlushVolume, datasetCode, expected] of STUDIO_PINS) {
    const actual = calcFlushVolume({ from: rgb(from), to: rgb(to), minFlushVolume, datasetCode, dataset: null })
    assert.equal(actual, expected, `${from} -> ${to} (min ${minFlushVolume}, dataset ${datasetCode})`)
  }
})

test('black to white lands on 560, not 559: the port keeps BambuStudio float precision', () => {
  // The regression this guards: computed in double, the luminance of white is 0.999... and the
  // result truncates one low. It is the most common two-material pairing there is, so an
  // off-by-one here is the first number a user would compare against Bambu Studio.
  assert.equal(
    calcFlushVolume({ from: rgb('#000000'), to: rgb('#FFFFFF'), minFlushVolume: 0, datasetCode: 0, dataset: null }),
    560
  )
})

test('a transparent filament counts as white on either end', () => {
  const opaqueWhiteToBlack = calcFlushVolume({ from: rgb('#FFFFFF'), to: rgb('#000000'), minFlushVolume: 0, datasetCode: 0, dataset: null })
  const transparentToBlack = calcFlushVolume({
    from: rgb('#123456'), fromAlpha: 0, to: rgb('#000000'), minFlushVolume: 0, datasetCode: 0, dataset: null
  })
  assert.equal(transparentToBlack, opaqueWhiteToBlack)
})

test('the calculated volume is clamped to the model ceiling', () => {
  const volume = calcFlushVolume({
    from: rgb('#0A2989'), to: rgb('#F4EE2A'), minFlushVolume: 5000, datasetCode: 0, dataset: null
  })
  assert.equal(volume, FLUSH_VOLUME_MODEL.maxVolume)
})

/** A two-colour stand-in for one of BambuStudio's `resources/flush/*.txt` tables. */
const SAMPLE_DATASET_TEXT = [
  'colors',
  '#000000 #F4EE2A',
  'src dst flush',
  '#000000 #F4EE2A 450',
  '#F4EE2A #000000 200',
  ''
].join('\n')

test('a measured table parses and snaps near-matching colours onto its palette', () => {
  const dataset = parseFlushVolumeDataset(SAMPLE_DATASET_TEXT)
  assert.ok(dataset)
  assert.equal(dataset.minVolume, 200)
  assert.equal(lookupMeasuredFlushVolume(dataset, rgb('#000000'), rgb('#F4EE2A')), 450)
  // A colour a shade off a measured one still hits: Studio snaps within DeltaE2000 5 so a filament
  // whose hex drifted by a digit is not silently treated as an unmeasured colour.
  assert.ok(flushColorDistance(rgb('#F4EE2A'), rgb('#F5EF2C')) < FLUSH_VOLUME_MODEL.similarColorThreshold)
  assert.equal(lookupMeasuredFlushVolume(dataset, rgb('#000000'), rgb('#F5EF2C')), 450)
  // A genuinely different colour must MISS rather than snap to the nearest entry, so the caller
  // falls back to the formula instead of quoting an unrelated measurement.
  assert.equal(lookupMeasuredFlushVolume(dataset, rgb('#000000'), rgb('#00AE42')), null)
  assert.equal(lookupMeasuredFlushVolume(null, rgb('#000000'), rgb('#F4EE2A')), null)
})

test('a malformed table is rejected whole, never half-read', () => {
  assert.equal(parseFlushVolumeDataset('colors\n#00000\nsrc dst flush\n'), null)
  assert.equal(parseFlushVolumeDataset('colors\n#000000\nsrc dst flush\n#000000 #F4EE2A notanumber\n'), null)
  assert.equal(parseFlushVolumeDataset('too short'), null)
})

test('dataset 0 adds the dead volume to a table hit; datasets 1 and 2 do not', () => {
  // BambuStudio's own asymmetry (see the fidelity note in flush-volume-calc.ts). Pinned because it
  // reads like a bug, and a future reader "fixing" it would silently change every quoted volume.
  const dataset = parseFlushVolumeDataset(SAMPLE_DATASET_TEXT)
  const shared = { from: rgb('#000000'), to: rgb('#F4EE2A'), minFlushVolume: 130, dataset }
  assert.equal(calcFlushVolume({ ...shared, datasetCode: 0 }), 580)
  assert.equal(calcFlushVolume({ ...shared, datasetCode: 1 }), 450)
})

test('the matrix zeroes the diagonal and gives support material its own volumes', () => {
  const filaments = [
    { colors: [rgb('#FFFFFF')], isSupport: false },
    { colors: [rgb('#000000')], isSupport: false },
    { colors: [rgb('#00AE42')], isSupport: true }
  ]
  const matrix = calcFlushVolumesMatrix({
    filaments, minFlushVolumes: [0, 0, 0], datasetCode: 0, dataset: null
  })
  assert.deepEqual(matrix.map((row) => row[0] === 0 && row.length === 3), [true, false, false])
  for (let index = 0; index < 3; index += 1) assert.equal(matrix[index][index], 0)
  // Swapping TO support is a flat cost regardless of colour...
  assert.equal(matrix[0][2], FLUSH_VOLUME_TO_SUPPORT)
  assert.equal(matrix[1][2], FLUSH_VOLUME_TO_SUPPORT)
  // ...and swapping AWAY from it never drops below the floor, even green -> black, which the
  // colour formula alone would price far lower.
  assert.ok(matrix[2][0] >= FLUSH_MIN_VOLUME_FROM_SUPPORT)
  assert.ok(matrix[2][1] >= FLUSH_MIN_VOLUME_FROM_SUPPORT)
})

test('a multi-colour filament is priced by its worst pairing', () => {
  const single = calcFlushVolumesMatrix({
    filaments: [{ colors: [rgb('#FFFFFF')], isSupport: false }, { colors: [rgb('#FFFFFE')], isSupport: false }],
    minFlushVolumes: [0, 0], datasetCode: 0, dataset: null
  })
  const multi = calcFlushVolumesMatrix({
    filaments: [
      { colors: [rgb('#FFFFFF')], isSupport: false },
      // Same slot, but it also carries black: the swap must be priced for the black.
      { colors: [rgb('#FFFFFE'), rgb('#000000')], isSupport: false }
    ],
    minFlushVolumes: [0, 0], datasetCode: 0, dataset: null
  })
  assert.equal(single[0][1], 60)
  assert.equal(multi[0][1], 80)
})

test('the matrix indexes the dead volume by the SOURCE slot', () => {
  const filaments = [
    { colors: [rgb('#FFFFFF')], isSupport: false },
    { colors: [rgb('#000000')], isSupport: false }
  ]
  const matrix = calcFlushVolumesMatrix({ filaments, minFlushVolumes: [100, 0], datasetCode: 0, dataset: null })
  // Row 0 (from white) picks up 100; row 1 (from black) picks up 0. Indexing by destination would
  // swap these and quietly mis-price every purge on a machine with per-filament retraction.
  assert.equal(matrix[0][1], 180)
  assert.equal(matrix[1][0], 560)
})

test('the dead volume is the nozzle volume less what a long retraction pulls back', () => {
  const base = { filamentCount: 2, extruderIndex: 0, nozzleVolume: [130, 148] }
  // Retraction disabled at the machine: the whole nozzle volume counts.
  assert.deepEqual(resolveMinFlushVolumes({ ...base }), [130, 130])
  // The second extruder reads its own nozzle volume.
  assert.deepEqual(resolveMinFlushVolumes({ ...base, extruderIndex: 1 }), [148, 148])
  // Machine level 1 with the filament opted in: the MACHINE's distance applies to both filaments.
  assert.deepEqual(resolveMinFlushVolumes({
    ...base,
    enableLongRetractionWhenCut: 1,
    longRetractionsWhenCut: [1, 1],
    retractionDistancesWhenCut: [10, 10],
    filamentLongRetractionsWhenCut: [1, 1]
  }), [105, 105])
  // Level 2 lets each filament state its own distance; a null falls back to the machine's.
  assert.deepEqual(resolveMinFlushVolumes({
    ...base,
    enableLongRetractionWhenCut: 2,
    longRetractionsWhenCut: [1, 1],
    retractionDistancesWhenCut: [10, 10],
    filamentLongRetractionsWhenCut: [1, 1],
    filamentRetractionDistancesWhenCut: [18, null]
  }), [86, 105])
  // A filament that opts OUT keeps the full nozzle volume even when the machine enables it.
  assert.deepEqual(resolveMinFlushVolumes({
    ...base,
    enableLongRetractionWhenCut: 2,
    longRetractionsWhenCut: [1, 1],
    retractionDistancesWhenCut: [10, 10],
    filamentLongRetractionsWhenCut: [0, 1]
  }), [130, 105])
})

test('similar-colour matching uses the model threshold', () => {
  assert.ok(isSimilarFlushColor(rgb('#000000'), rgb('#010101')))
  assert.ok(!isSimilarFlushColor(rgb('#000000'), rgb('#FFFFFF')))
})

/** Walk up to the workspace root (the directory holding `packages/` and `apps/`). */
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
 * Guards the generated model against vendor drift, the same way `variant-options.test.ts` guards
 * its mirrored sets: re-derive from the vendored source and require an exact match.
 *
 * SKIPS when `tmp/bambustudio-src` is absent, it is a developer convenience, not a checked-in
 * dependency, which makes this a ratchet for whoever bumps the vendored source, i.e. exactly
 * whoever would introduce the drift.
 */
test('the generated flush model still matches the vendored BambuStudio source', async (t) => {
  const root = findWorkspaceRoot()
  const src = root ? join(root, 'tmp', 'bambustudio-src') : null
  if (!src || !existsSync(join(src, 'src/libslic3r/FlushVolCalc.cpp'))) {
    t.skip('vendored BambuStudio source not present')
    return
  }
  const { extractFlushVolumeModel } = await import(
    join(root!, 'scripts/dev/generate-flush-volume-model.mjs')
  ) as { extractFlushVolumeModel: (src: string) => unknown }
  assert.deepEqual(
    JSON.parse(JSON.stringify(FLUSH_VOLUME_MODEL)),
    JSON.parse(JSON.stringify(extractFlushVolumeModel(src))),
    'Re-run scripts/dev/generate-flush-volume-model.mjs: BambuStudio retuned the flush calculation'
  )
})

test('the real measured tables parse, and the formula alone would disagree with them', async (t) => {
  const root = findWorkspaceRoot()
  const file = root ? join(root, 'tmp/bambustudio-src/resources', FLUSH_VOLUME_MODEL.datasetFiles['0']) : null
  if (!file || !existsSync(file)) {
    t.skip('vendored BambuStudio resources not present')
    return
  }
  const dataset: FlushVolumeDataset | null = parseFlushVolumeDataset(readFileSync(file, 'utf8'))
  assert.ok(dataset, 'the shipped table must parse')
  assert.ok(dataset.colors.length > 0)
  // The reason the tables are worth plumbing through at all: Studio's measurements are far below
  // what its own formula predicts, so a dataset-less calculation over-purges. If this ever stops
  // holding, the runtime plumbing has become unnecessary rather than broken.
  const measured = lookupMeasuredFlushVolume(dataset, rgb('#5B6579'), rgb('#F4EE2A'))
  assert.ok(measured !== null, 'grey -> yellow is one of the measured pairs')
  const computed = calcFlushVolume({
    from: rgb('#5B6579'), to: rgb('#F4EE2A'), minFlushVolume: 0, datasetCode: 0, dataset: null
  })
  assert.ok(computed > measured + 100, `formula ${computed} should far exceed measured ${measured}`)
})
