import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  COMMON_FILAMENT_COLOR_SWATCHES,
  commonFilamentColorName,
  filamentBackground,
  hasLoadedFilament,
  resolveCompactFilamentTypeLabel,
  resolveFilamentColorName,
  resolveFilamentColorSwatches,
  resolveFilamentDisplay,
  resolveProjectFilamentColorName,
  resolveFilamentSwatchName
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

test('resolveFilamentColorName still uses Bambu-specific names for Bambu presets', () => {
  assert.equal(
    resolveFilamentColorName({
      color: '#FFFFFF',
      trayName: 'PLA Basic',
      trayInfoIdx: 'GFA00',
      filamentType: 'PLA Basic'
    }),
    'Jade White'
  )
})

test('resolveFilamentDisplay prefers the preset-derived support material over the raw filament type', () => {
  assert.deepEqual(
    resolveFilamentDisplay({
      color: '#000000',
      trayName: 'Support for PLA/PETG',
      trayInfoIdx: 'GFS05',
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

test('resolveCompactFilamentTypeLabel keeps meaningful engineering variants and support labels', () => {
  assert.equal(resolveCompactFilamentTypeLabel('PAHT-CF Black'), 'PAHT-CF')
  assert.equal(resolveCompactFilamentTypeLabel('PLA-S'), 'Sup. PLA')
  assert.equal(resolveCompactFilamentTypeLabel('Support for PLA'), 'Sup. PLA')
  assert.equal(resolveCompactFilamentTypeLabel('Bambu Support for PLA/PETG'), 'Sup. PLA')
  assert.equal(resolveCompactFilamentTypeLabel('Bambu Support for ABS'), 'Sup. ABS')
})