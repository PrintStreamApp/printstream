import assert from 'node:assert/strict'
import { test } from 'node:test'
import { calibrationFilamentIdentityFromTray, resolveTargetedCalibrationValue, type SlicingPresetSummary } from '@printstream/shared'
import { buildLoadedPrinterMaterialOptions, buildSliceMaterialOptions, resolveProfileMaterialBrand, type LoadedMaterialSource } from './slicingPresetMatching'

test('a Polymaker PETG rule matches PolyLite from AMS, external spool and vendor-less project presets', () => {
  const preset: SlicingPresetSummary = {
    id: 'polylite', source: 'builtin', kind: 'filament',
    name: 'PolyLite PETG @BBL H2D', filamentVendor: 'Polymaker', filamentType: 'PETG'
  }
  const tray = {
    slot: 3, occupied: true, trayName: null, trayInfoIdx: 'GFG60', trayUuid: null,
    filamentType: 'PETG', color: '#C7372F', colors: ['#C7372F']
  }
  const source = {
    ams: [{ unitId: 0, type: 'ams', nozzleId: 1, slots: [tray] }],
    externalSpools: [{ ...tray, amsId: 255, nozzleId: 0 }], nozzleCount: 2
  } as unknown as LoadedMaterialSource
  const rule = {
    kind: 'flowRatio', value: 1.1, printerModel: 'H2D', nozzleDiameter: '0.4',
    printerTarget: { scope: 'models' as const, models: ['H2D'] },
    scope: 'identity' as const, spoolId: null, brand: 'Polymaker', filamentType: 'PETG',
    materialSubtype: null, colorName: null
  }
  const options = buildLoadedPrinterMaterialOptions(source, [preset], null, 'H2D')
  assert.equal(options.length, 2)
  for (const option of options) {
    assert.equal(option.brand, 'Polymaker')
    assert.equal(option.materialSubtype, 'PolyLite PETG')
    const identity = {
      spoolId: option.spoolId ?? null, brand: option.brand, filamentType: option.materialType,
      materialSubtype: option.materialSubtype ?? null, colorName: option.colorName
    }
    assert.equal(resolveTargetedCalibrationValue([rule], identity, { printerModel: 'H2D', nozzleDiameter: '0.4' })?.value, 1.1)
    const lineRule = { ...rule, materialSubtype: 'PolyLite PETG' }
    assert.equal(resolveTargetedCalibrationValue([lineRule], identity, { printerModel: 'H2D', nozzleDiameter: '0.4' })?.value, 1.1)
    assert.equal(resolveTargetedCalibrationValue([lineRule], { ...identity, materialSubtype: 'PETG HF' }, { printerModel: 'H2D', nozzleDiameter: '0.4' }), null)
    assert.deepEqual(calibrationFilamentIdentityFromTray(tray), identity)
    assert.equal(resolveTargetedCalibrationValue([rule], identity, { printerModel: 'P1S', nozzleDiameter: '0.4' }), null)
  }
  assert.equal(resolveProfileMaterialBrand({ ...preset, filamentVendor: undefined }), 'Polymaker')
  assert.equal(buildSliceMaterialOptions([preset], [])[0]?.materialSubtype, 'PolyLite PETG')
  // A selected slicing preset cannot overwrite the physical spool's declared manufacturer.
  const tracked = buildLoadedPrinterMaterialOptions(source, [preset], null, 'H2D', {
    printerId: 'home', resolveSpool: () => ({ spoolId: 'custom', brand: 'Custom brand' })
  })
  assert.ok(tracked.every((option) => option.brand === 'Custom brand'))
})
