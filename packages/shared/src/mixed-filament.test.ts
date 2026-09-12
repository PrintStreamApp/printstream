import assert from 'node:assert/strict'
import test from 'node:test'
import {
  expandMixedFilamentIds,
  parseMixedFilamentGradientCurve,
  parseProjectMixedFilaments,
  sampleMixedFilamentGradientCurve,
  serializeMixedFilamentGradientCurve
} from './mixed-filament.js'

const mix = (componentIds: number[]) => ({
  componentIds,
  ratios: componentIds.map(() => 1 / componentIds.length),
  gradient: false,
  gradientRange: [0.1, 0.9] as [number, number],
  gradientCurve: null,
  gradientPerPart: false,
  issues: []
})

test('used virtual slots expand to physical filament ids for tray mapping', () => {
  const filaments = [
    { id: 1, mixedFilament: null },
    { id: 2, mixedFilament: null },
    { id: 3, mixedFilament: mix([1, 2]) }
  ]
  assert.deepEqual([...expandMixedFilamentIds(filaments, new Set([3]))], [1, 2])
})

test('malformed nested mixed slots cannot loop or leak virtual ids into tray mapping', () => {
  const filaments = [
    { id: 1, mixedFilament: null },
    { id: 2, mixedFilament: mix([3, 1]) },
    { id: 3, mixedFilament: mix([2]) }
  ]
  assert.deepEqual([...expandMixedFilamentIds(filaments, new Set([2]))], [1])
})

test('mixed filament metadata resolves physical components and normalizes ratios', () => {
  const slots = parseProjectMixedFilaments({
    filament_is_mixed: ['0', '0', '1'],
    filament_mixed_components: ['', '', '1,2'],
    filament_mixed_sublayer_ratios: ['', '', '7,3'],
    filament_mixed_gradient: ['0', '0', '1'],
    filament_mixed_gradient_range: ['', '', '0.15,0.85'],
    filament_mixed_gradient_curve: ['', '', '0,0.15|0.5,0.50,,1.25|1,0.85'],
    filament_mixed_gradient_per_part: ['0', '0', '1'],
    filament_type: ['PLA', 'PLA', 'PLA']
  })

  assert.equal(slots[0], null)
  assert.deepEqual(slots[2], {
    componentIds: [1, 2],
    ratios: [0.7, 0.3],
    gradient: true,
    gradientRange: [0.15, 0.85],
    gradientCurve: [
      { x: 0, y: 0.15, mIn: null, mOut: null },
      { x: 0.5, y: 0.5, mIn: null, mOut: 1.25 },
      { x: 1, y: 0.85, mIn: null, mOut: null }
    ],
    gradientPerPart: true,
    issues: []
  })
})

test('mixed filament validation reports unsafe virtual-slot definitions', () => {
  const slots = parseProjectMixedFilaments({
    filament_is_mixed: ['0', '1', '1'],
    filament_mixed_components: ['', '1,3,3', '1,2'],
    filament_mixed_sublayer_ratios: ['', '1,-1', '0.5,0.5'],
    filament_mixed_gradient: ['0', '1', '1'],
    filament_mixed_gradient_range: ['', '0,1', '0.1,0.9'],
    filament_type: ['PLA', 'PLA', 'PETG']
  })

  assert.deepEqual(new Set(slots[1]?.issues), new Set([
    'component-count', 'component-reference', 'component-is-mixed', 'component-type-mismatch', 'ratio-count',
    'gradient-component-count', 'gradient-range'
  ]))
  assert.ok(slots[2]?.issues.includes('component-is-mixed'))
})

test('gradient curve serialization preserves legacy anchors and tangent overrides', () => {
  const curve = parseMixedFilamentGradientCurve('0,0|0.5,0.5,,1.25|1,1')
  assert.ok(curve)
  assert.equal(serializeMixedFilamentGradientCurve(curve), '0.0000,0.1000|0.5000,0.5000,,1.2500|1.0000,0.9000')
})

test('gradient sampling is monotone and honors endpoint clamps', () => {
  const curve = parseMixedFilamentGradientCurve('0,0.15|0.4,0.75|1,0.85')
  assert.ok(curve)
  const values = [0, 0.25, 0.5, 0.75, 1].map((progress) => sampleMixedFilamentGradientCurve(curve, progress))
  assert.equal(values[0], 0.15)
  assert.equal(values.at(-1), 0.85)
  assert.ok(values.every((value, index) => index === 0 || value >= values[index - 1]!))
})
