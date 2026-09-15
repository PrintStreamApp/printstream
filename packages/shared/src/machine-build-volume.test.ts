import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyRectangularMachineBuildVolume,
  hasPerExtruderMachineBuildVolume,
  readRectangularMachineBuildVolume,
  validateRectangularMachineBuildVolume
} from './machine-build-volume.js'

test('reads a translated rectangular printable area as bed size and G-code origin', () => {
  const result = readRectangularMachineBuildVolume({
    printable_area: ['-100x-90', '120x-90', '120x130', '-100x130'],
    printable_height: '275'
  })

  assert.deepEqual(result, {
    volume: { width: 220, depth: 220, originX: 100, originY: 90, height: 275 },
    exactRectangle: true
  })
})

test('a custom polygon exposes its bounds without claiming it is rectangular', () => {
  const result = readRectangularMachineBuildVolume({
    printable_area: ['0x0', '200x0', '180x200', '20x200'],
    printable_height: '250'
  })

  assert.deepEqual(result.volume, { width: 200, depth: 200, originX: 0, originY: 0, height: 250 })
  assert.equal(result.exactRectangle, false)
})

test('accepts comma-packed and explicitly closed rectangles without accepting a bow-tie', () => {
  assert.equal(readRectangularMachineBuildVolume({
    printable_area: ['0x0,100x0,100x80,0x80,0x0']
  }).exactRectangle, true)

  const crossed = readRectangularMachineBuildVolume({
    printable_area: ['0x0', '100x80', '100x0', '0x80']
  })
  assert.equal(crossed.exactRectangle, false)
  assert.deepEqual(crossed.volume, { width: 100, depth: 80, originX: 0, originY: 0, height: 100 })
})

test('applies BambuStudio rectangular bed and origin serialization without mutating other settings', () => {
  const original = {
    printer_model: 'Bambu Lab A1',
    bed_exclude_area: ['0x0', '18x0', '18x28', '0x28'],
    printable_area: ['0x0', '256x0', '256x256', '0x256'],
    printable_height: '256'
  }
  const updated = applyRectangularMachineBuildVolume(original, {
    width: 300,
    depth: 280,
    originX: 0,
    originY: 0,
    height: 320
  })

  assert.deepEqual(updated.printable_area, ['0x0', '300x0', '300x280', '0x280'])
  assert.equal(updated.printable_height, '320')
  assert.deepEqual(updated.bed_exclude_area, original.bed_exclude_area)
  assert.equal(original.printable_height, '256')
})

test('moving the origin keeps coordinate-based safety regions fixed on the physical bed', () => {
  const updated = applyRectangularMachineBuildVolume({
    printable_area: ['0x0', '256x0', '256x256', '0x256'],
    printable_height: '256',
    bed_exclude_area: ['0x0', '18x0', '18x28', '0x28'],
    bed_heat_soak_area: ['60x49', '270x49', '270x271', '60x271'],
    wrapping_exclude_area: ['145x310,256x310,256x326,145x326']
  }, {
    width: 300,
    depth: 280,
    originX: 128,
    originY: 64,
    height: 320
  })

  assert.deepEqual(updated.bed_exclude_area, ['-128x-64', '-110x-64', '-110x-36', '-128x-36'])
  assert.deepEqual(updated.bed_heat_soak_area, ['-68x-15', '142x-15', '142x207', '-68x207'])
  assert.deepEqual(updated.wrapping_exclude_area, ['17x246,128x246,128x262,17x262'])
})

test('changing only size or height preserves coordinate-area serialization exactly', () => {
  const config = {
    printable_area: ['0x0', '256x0', '256x256', '0x256'],
    printable_height: '256',
    bed_exclude_area: ['vendor-specific-format']
  }
  const updated = applyRectangularMachineBuildVolume(config, {
    width: 300,
    depth: 280,
    originX: 0,
    originY: 0,
    height: 320
  })

  assert.deepEqual(updated.bed_exclude_area, config.bed_exclude_area)
})

test('per-extruder reach constraints block a partial global build-volume edit', () => {
  const config = {
    printable_area: ['0x0', '350x0', '350x320', '0x320'],
    printable_height: '325',
    extruder_printable_area: [
      '0x0,325x0,325x320,0x320',
      '25x0,350x0,350x320,25x320'
    ],
    extruder_printable_height: ['325', '325']
  }

  assert.equal(hasPerExtruderMachineBuildVolume(config), true)
  assert.equal(hasPerExtruderMachineBuildVolume({
    ...config,
    extruder_printable_area: [],
    extruder_printable_height: []
  }), false)
  assert.throws(() => applyRectangularMachineBuildVolume(config, {
    width: 300,
    depth: 300,
    originX: 0,
    originY: 0,
    height: 300
  }), /per-extruder/i)
})

test('an invalid safety polygon blocks an origin move instead of preserving unsafe coordinates', () => {
  assert.throws(() => applyRectangularMachineBuildVolume({
    printable_area: ['0x0', '200x0', '200x200', '0x200'],
    bed_exclude_area: ['not-a-point']
  }, {
    width: 200,
    depth: 200,
    originX: 100,
    originY: 100,
    height: 200
  }), /bed_exclude_area contains an invalid point/i)
})

test('validates build-volume limits and keeps a valid negative origin offset', () => {
  assert.equal(validateRectangularMachineBuildVolume({
    width: 200,
    depth: 200,
    originX: -10,
    originY: 0,
    height: 250
  }), null)
  assert.match(validateRectangularMachineBuildVolume({
    width: 200,
    depth: 200,
    originX: 200,
    originY: 0,
    height: 250
  }) ?? '', /origin/i)
  assert.throws(() => applyRectangularMachineBuildVolume({}, {
    width: 0,
    depth: 200,
    originX: 0,
    originY: 0,
    height: 250
  }), /greater than zero/i)
})

test('accepts large-format beds and origins when their coordinates remain serializable', () => {
  assert.equal(validateRectangularMachineBuildVolume({
    width: 2500,
    depth: 1600,
    height: 900,
    originX: -1200,
    originY: 800
  }), null)
})

test('rejects dimensions whose derived bed coordinates overflow', () => {
  assert.equal(validateRectangularMachineBuildVolume({
    width: Number.MAX_VALUE,
    depth: 1600,
    height: 900,
    originX: -Number.MAX_VALUE,
    originY: 0
  }), 'The bed size and origin are too large to serialize safely.')
})

test('serializes small decimal coordinates without exponent notation', () => {
  const updated = applyRectangularMachineBuildVolume({}, {
    width: 200,
    depth: 200,
    originX: 0.0000001,
    originY: 0,
    height: 250
  })
  assert.deepEqual(updated.printable_area, [
    '-0.0000001x0',
    '199.9999999x0',
    '199.9999999x200',
    '-0.0000001x200'
  ])

  const tiny = applyRectangularMachineBuildVolume({}, {
    width: 0.0000000000001,
    depth: 200,
    originX: 0,
    originY: 0,
    height: 0.0000000000001
  })
  assert.deepEqual(tiny.printable_area, [
    '0x0',
    '0.0000000000001x0',
    '0.0000000000001x200',
    '0x200'
  ])
  assert.equal(tiny.printable_height, '0.0000000000001')
})
