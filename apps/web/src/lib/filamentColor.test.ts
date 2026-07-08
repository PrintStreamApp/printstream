import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  COMMON_FILAMENT_COLOR_SWATCHES,
  colorDistance,
  commonFilamentColorName,
  deltaE2000,
  filamentBackground,
  hasLoadedFilament,
  resolveCompactFilamentTypeLabel,
  resolveFilamentColorName,
  resolveFilamentColorSwatches,
  resolveFilamentDisplay,
  resolveProjectFilamentColorName,
  resolveFilamentSwatchName,
  type Lab
} from './filamentColor.js'

test('resolveFilamentColorName prefers a known Bambu swatch name', () => {
  assert.equal(
    resolveFilamentColorName({
      color: '#FFFFFF',
      trayName: 'Jade White',
      filamentType: 'PLA'
    }),
    'Jade White'
  )
})

test('resolveFilamentColorName falls back to the primary palette color when color is missing', () => {
  assert.equal(
    resolveFilamentColorName({
      color: null,
      colors: ['#0086D6FF'],
      trayName: 'PLA',
      trayUuid: '0F674662BC86478AA008E7CCAD3B3A2A',
      filamentType: 'PLA'
    }),
    'Cyan'
  )
})

test('resolveFilamentColorName recognizes the printer-reported cyan alias used by some PLA presets', () => {
  assert.equal(
    resolveFilamentColorName({
      color: '#00FFFF',
      colors: ['#00FFFF'],
      trayName: null,
      trayInfoIdx: 'GFL00',
      filamentType: 'PLA'
    }),
    'Cyan'
  )
})

test('resolveFilamentColorName falls back to the scanned tray name when the swatch catalog misses', () => {
  assert.equal(
    resolveFilamentColorName({
      color: '#123456',
      trayName: 'Seafoam Green',
      filamentType: 'PLA'
    }),
    'Seafoam Green'
  )
})

test('resolveFilamentColorName ignores tray names that only repeat the filament type', () => {
  assert.equal(
    resolveFilamentColorName({
      color: '#123456',
      trayName: 'PLA',
      filamentType: 'PLA'
    }),
    null
  )
})

test('resolveFilamentColorName prefers material-specific names for shared hex colors', () => {
  assert.equal(
    resolveFilamentColorName({
      color: '#FFFFFF',
      trayName: 'PETG Translucent',
      trayInfoIdx: 'GFG01',
      trayUuid: '0F674662BC86478AA008E7CCAD3B3A2A',
      filamentType: 'PETG Translucent'
    }),
    'Clear'
  )
})

test('resolveFilamentDisplay resolves BambuStudio multi-color entries from trayInfoIdx and colors', () => {
  assert.deepEqual(
    resolveFilamentDisplay({
      color: '#FFFFFF',
      colors: ['#FFFFFFFF', '#9CDBD9FF'],
      trayName: 'A00-G0',
      trayInfoIdx: 'GFA00',
      filamentType: 'PLA Basic'
    }),
    {
      name: 'Arctic Whisper',
      material: 'PLA Basic',
      colors: ['#FFFFFF', '#9CDBD9'],
      rawTrayCode: 'A00-G0'
    }
  )
})

test('resolveFilamentDisplay does not surface a raw tray-code alias as a guessed label when the palette is missing', () => {
  assert.equal(
    resolveFilamentColorName({
      color: '#123456',
      trayName: 'A00-G0',
      trayInfoIdx: 'GFA00',
      filamentType: 'PLA Basic'
    }),
    null
  )
})

test('resolveFilamentDisplay does not leak unknown raw tray codes as the primary label', () => {
  assert.equal(
    resolveFilamentColorName({
      color: '#123456',
      trayName: 'A05-M9',
      trayInfoIdx: 'GFA05',
      filamentType: 'PLA Silk'
    }),
    null
  )
})

test('resolveFilamentDisplay resolves single-color Bambu tray codes from preset id and color', () => {
  assert.equal(
    resolveFilamentColorName({
      color: '#F55A74',
      trayName: 'A00-P2',
      trayInfoIdx: 'GFA00',
      trayUuid: '0F674662BC86478AA008E7CCAD3B3A2A',
      filamentType: 'PLA Basic'
    }),
    'Pink'
  )
})

test('resolveFilamentColorName promotes support material names when the printer only reports a raw support tray code', () => {
  assert.equal(
    resolveFilamentColorName({
      color: '#123456',
      trayName: 'S05-C0',
      trayInfoIdx: 'GFS02',
      filamentType: 'PLA-S'
    }),
    'Support for PLA'
  )
})

test('resolveFilamentColorName uses common color names for non-Bambu preset brands', () => {
  assert.equal(
    resolveFilamentColorName({
      color: '#FFFFFF',
      trayName: 'PLA',
      trayInfoIdx: 'GFL00',
      filamentType: 'PLA'
    }),
    'White'
  )
})

test('resolveFilamentColorName still uses Bambu-specific names for scanned Bambu spools', () => {
  assert.equal(
    resolveFilamentColorName({
      color: '#FFFFFF',
      trayName: 'PLA Basic',
      trayInfoIdx: 'GFA00',
      trayUuid: '0F674662BC86478AA008E7CCAD3B3A2A',
      filamentType: 'PLA Basic'
    }),
    'Jade White'
  )
})

test('resolveFilamentColorName uses common names for custom filament assigned a Bambu preset without an RFID tag', () => {
  // A custom spool mapped to "Bambu PLA Basic" for slicing (trayInfoIdx GFA00) but with no scanned
  // RFID tag is not genuine Bambu filament, so its white reads "White", never "Jade White".
  assert.equal(
    resolveFilamentColorName({
      color: '#FFFFFF',
      trayName: null,
      trayInfoIdx: 'GFA00',
      trayUuid: null,
      filamentType: 'PLA'
    }),
    'White'
  )
})

test('resolveFilamentColorName uses common names for custom filament with no preset or RFID tag', () => {
  assert.equal(
    resolveFilamentColorName({
      color: '#FFFFFF',
      trayName: null,
      trayInfoIdx: null,
      trayUuid: null,
      filamentType: 'PLA'
    }),
    'White'
  )
})

test('resolveFilamentDisplay prefers the preset-derived support material over the raw filament type', () => {
  assert.deepEqual(
    resolveFilamentDisplay({
      color: '#000000',
      trayName: 'Support for PLA/PETG',
      trayInfoIdx: 'GFS05',
      trayUuid: '0F674662BC86478AA008E7CCAD3B3A2A',
      filamentType: 'PLA'
    }),
    {
      name: 'Nature',
      material: 'Support for PLA/PETG',
      colors: ['#000000'],
      rawTrayCode: null
    }
  )
})

test('resolveFilamentSwatchName only returns actual color names, not fallback tray labels', () => {
  assert.equal(
    resolveFilamentSwatchName({
      color: '#000000',
      trayName: 'Support for PLA/PETG',
      trayInfoIdx: 'GFS05',
      trayUuid: '0F674662BC86478AA008E7CCAD3B3A2A',
      filamentType: 'PLA'
    }),
    'Nature'
  )
  assert.equal(
    resolveFilamentSwatchName({
      color: '#123456',
      trayName: 'Seafoam Green',
      filamentType: 'PLA'
    }),
    null
  )
  // Custom filament mapped to a Bambu preset but without an RFID tag stays a plain colour.
  assert.equal(
    resolveFilamentSwatchName({
      color: '#FFFFFF',
      trayName: null,
      trayInfoIdx: 'GFA00',
      trayUuid: null,
      filamentType: 'PLA'
    }),
    'White'
  )
})

test('resolveProjectFilamentColorName uses sliced material context before naming colors', () => {
  assert.equal(
    resolveProjectFilamentColorName({
      color: '#FFFFFF',
      filamentName: 'Bambu Support for ABS',
      filamentType: 'ABS'
    }),
    'White'
  )
  assert.equal(
    resolveProjectFilamentColorName({
      color: '#FFFFFF',
      filamentName: 'Bambu PLA Basic',
      filamentType: 'PLA'
    }),
    'Jade White'
  )
  // Generic and custom-brand filament keep plain common names even though the type maps to a
  // Bambu material — a white "Generic PLA" or a user's own brand is "White", not "Jade White".
  assert.equal(
    resolveProjectFilamentColorName({
      color: '#FFFFFF',
      filamentName: 'Generic PLA',
      filamentType: 'PLA'
    }),
    'White'
  )
  assert.equal(
    resolveProjectFilamentColorName({
      color: '#FFFFFF',
      filamentName: "Michael's",
      filamentType: 'PLA'
    }),
    'White'
  )
})

test('resolveFilamentColorSwatches falls back to common colors when a material has no catalog entries', () => {
  assert.deepEqual(
    resolveFilamentColorSwatches('Unknown Material'),
    {
      swatches: COMMON_FILAMENT_COLOR_SWATCHES,
      usesCommonFallback: true
    }
  )
})

test('resolveFilamentColorSwatches uses common colors for non-Bambu preset brands', () => {
  assert.deepEqual(
    resolveFilamentColorSwatches('PLA Lite', { presetBrand: 'PolyLite' }),
    {
      swatches: COMMON_FILAMENT_COLOR_SWATCHES,
      usesCommonFallback: true
    }
  )
})

test('commonFilamentColorName returns generic names for basic swatches', () => {
  assert.equal(commonFilamentColorName('#FFFFFF'), 'White')
})

test('filamentBackground returns a gradient for multi-color palettes', () => {
  assert.equal(filamentBackground(['#FFFFFF', '#9CDBD9'], null).startsWith('linear-gradient('), true)
})

test('hasLoadedFilament treats palette-only AMS slots as loaded', () => {
  assert.equal(hasLoadedFilament(null, null, ['#0086D6FF']), true)
})

test('hasLoadedFilament treats retained tray identity as loaded', () => {
  assert.equal(hasLoadedFilament(null, null, [], { trayInfoIdx: 'GFA00' }), true)
  assert.equal(hasLoadedFilament(null, null, [], { trayName: 'A00-G0' }), true)
  assert.equal(hasLoadedFilament(null, null, [], { trayUuid: 'ABCDEF1234567890ABCDEF1234567890' }), true)
  assert.equal(hasLoadedFilament(null, null, [], { remainPercent: 100 }), true)
  assert.equal(hasLoadedFilament(null, null, [], { occupied: true }), true)
})

test('hasLoadedFilament ignores empty identity strings', () => {
  assert.equal(hasLoadedFilament(null, null, [], { trayInfoIdx: '   ', trayName: '', trayUuid: '  ' }), false)
})

test('resolveCompactFilamentTypeLabel collapses preset-like PLA names to the base family', () => {
  assert.equal(resolveCompactFilamentTypeLabel('PLA Basic Gray'), 'PLA')
  assert.equal(resolveCompactFilamentTypeLabel('PLA Matte White'), 'PLA')
})

// Reference pairs from Sharma, Wu & Dalal (2005), "The CIEDE2000 Color-Difference Formula".
// The antipodal-hue near-grey pairs (their rows 9-12) are intentionally omitted: they sit exactly
// on the formula's 180-degree hue discontinuity, where the result is floating-point-sensitive and
// not meaningful for ranking real colours.
const SHARMA_DELTA_E_PAIRS: ReadonlyArray<readonly [Lab, Lab, number]> = [
  [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
  [[50, -0.001, 2.49], [50, 0.0009, -2.49], 4.8045],
  [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
  [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
  [[6.7747, -0.2908, -2.4247], [5.8714, -0.0985, -2.2286], 0.6377],
  [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082]
]

test('deltaE2000 matches the Sharma et al. CIEDE2000 reference data', () => {
  for (const [reference, sample, expected] of SHARMA_DELTA_E_PAIRS) {
    assert.ok(
      Math.abs(deltaE2000(reference, sample) - expected) < 1e-4,
      `dE00(${JSON.stringify(reference)}, ${JSON.stringify(sample)}) = ${deltaE2000(reference, sample)}, expected ${expected}`
    )
  }
})

test('colorDistance ranks a muted teal nearest other teals, not greys (perceptual, not RGB)', () => {
  const teal = '#408080'
  const darkTeal = colorDistance(teal, '#005F61')
  // The exact regression from the screenshot: a desaturated teal scored numerically close to greys
  // under raw RGB distance, burying the obvious teal match. The perceptual metric reverses that.
  assert.ok(darkTeal < colorDistance(teal, '#808080'), 'dark teal should beat mid grey')
  assert.ok(darkTeal < colorDistance(teal, '#545454'), 'dark teal should beat dark grey')
  assert.ok(darkTeal < colorDistance(teal, '#2FA84F'), 'dark teal should beat a saturated green')
})

test('colorDistance is 0 for identical colours and Infinity for unparseable input', () => {
  assert.equal(colorDistance('#408080', '#408080'), 0)
  assert.equal(colorDistance('#408080', 'not-a-colour'), Number.POSITIVE_INFINITY)
  assert.equal(colorDistance(null, '#408080'), Number.POSITIVE_INFINITY)
})

test('resolveCompactFilamentTypeLabel keeps meaningful engineering variants and support labels', () => {
  assert.equal(resolveCompactFilamentTypeLabel('PAHT-CF Black'), 'PAHT-CF')
  assert.equal(resolveCompactFilamentTypeLabel('PLA-S'), 'Sup. PLA')
  assert.equal(resolveCompactFilamentTypeLabel('Support for PLA'), 'Sup. PLA')
  assert.equal(resolveCompactFilamentTypeLabel('Bambu Support for PLA/PETG'), 'Sup. PLA')
  assert.equal(resolveCompactFilamentTypeLabel('Bambu Support for ABS'), 'Sup. ABS')
})