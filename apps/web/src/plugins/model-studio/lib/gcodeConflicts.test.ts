import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseGcodeLayers } from './gcodePreview'
import { findGcodeToolpathConflict } from './gcodeConflicts'

/**
 * Build a one-layer plate from per-object move lists.
 *
 * Each entry is an object label id plus the XY points its extrusions walk through, so a test can
 * say "these two objects cross here" without hand-writing the object-block boilerplate.
 */
function plate(objects: Array<{ id: number; feature?: string; points: Array<[number, number]> }>): string {
  const lines = ['G90', 'M83', '; LAYER_HEIGHT: 0.2', '; LINE_WIDTH: 0.42', 'G1 X0 Y0 Z0.2 F1200']
  for (const object of objects) {
    lines.push(`; start printing object, unique label id: ${object.id}`)
    lines.push(`; FEATURE: ${object.feature ?? 'Outer wall'}`)
    const [first, ...rest] = object.points
    lines.push(`G1 X${first![0]} Y${first![1]} F30000`)
    for (const [x, y] of rest) lines.push(`G1 X${x} Y${y} E0.5`)
    lines.push('M625')
  }
  return lines.join('\n')
}

test('two objects whose paths cross are reported, with the layer and the crossing point', () => {
  // A horizontal run at y=10 and a vertical run at x=10 must meet at (10, 10).
  const gcode = plate([
    { id: 1, points: [[0, 10], [20, 10]] },
    { id: 2, points: [[10, 0], [10, 20]] }
  ])
  const conflict = findGcodeToolpathConflict(parseGcodeLayers(gcode))
  assert.ok(conflict, 'a genuine crossing must be found')
  assert.equal(conflict.layer, 0)
  assert.deepEqual([...conflict.objectIds].sort(), [1, 2])
  assert.ok(Math.abs(conflict.point.x - 10) < 1e-6, `x was ${conflict.point.x}`)
  assert.ok(Math.abs(conflict.point.y - 10) < 1e-6, `y was ${conflict.point.y}`)
})

test('objects that stay apart are not reported', () => {
  const gcode = plate([
    { id: 1, points: [[0, 0], [20, 0]] },
    { id: 2, points: [[0, 50], [20, 50]] }
  ])
  assert.equal(findGcodeToolpathConflict(parseGcodeLayers(gcode)), null)
})

test('one object crossing ITSELF is not a conflict', () => {
  // Self-intersection is normal (infill crosses perimeters constantly). Studio skips same-owner
  // pairs before any geometry, and so must we, or every plate reports.
  const gcode = plate([
    { id: 1, points: [[0, 10], [20, 10], [10, 10], [10, 0], [10, 20]] }
  ])
  assert.equal(findGcodeToolpathConflict(parseGcodeLayers(gcode)), null)
})

test('a plate with only one object is answered without geometry work', () => {
  const gcode = plate([{ id: 1, points: [[0, 0], [20, 0], [20, 20]] }])
  assert.equal(findGcodeToolpathConflict(parseGcodeLayers(gcode)), null)
})

test('brim and skirt are exempt, because they are meant to run between objects', () => {
  // Brim is emitted INSIDE the object's own label block, so a naive group-by-object flags every
  // plate whose brims touch. Studio never sees brim or skirt at all.
  const crossingBrim = plate([
    { id: 1, feature: 'Brim', points: [[0, 10], [20, 10]] },
    { id: 2, feature: 'Brim', points: [[10, 0], [10, 20]] }
  ])
  assert.equal(findGcodeToolpathConflict(parseGcodeLayers(crossingBrim)), null)

  const crossingSkirt = plate([
    { id: 1, feature: 'Skirt', points: [[0, 10], [20, 10]] },
    { id: 2, feature: 'Outer wall', points: [[10, 0], [10, 20]] }
  ])
  assert.equal(findGcodeToolpathConflict(parseGcodeLayers(crossingSkirt)), null)
})

test('support crossing support is exempt, but support crossing a model wall is not', () => {
  // Studio raises the threshold to 100mm for support-vs-support, which no segment can exceed;
  // its own comment says that "almost disables" the check for that pair.
  const supportVsSupport = plate([
    { id: 1, feature: 'Support', points: [[0, 10], [20, 10]] },
    { id: 2, feature: 'Support', points: [[10, 0], [10, 20]] }
  ])
  assert.equal(findGcodeToolpathConflict(parseGcodeLayers(supportVsSupport)), null)

  const supportVsWall = plate([
    { id: 1, feature: 'Support', points: [[0, 10], [20, 10]] },
    { id: 2, feature: 'Outer wall', points: [[10, 0], [10, 20]] }
  ])
  assert.ok(findGcodeToolpathConflict(parseGcodeLayers(supportVsWall)), 'support against a wall still conflicts')
})

test('paths that merely touch end to end are adjacency, not a conflict', () => {
  // Studio ignores a crossing that lands within 0.01mm of any of the four endpoints. Without that
  // rule, every place two objects' paths meet at a shared corner reports.
  const gcode = plate([
    { id: 1, points: [[0, 0], [10, 0]] },
    { id: 2, points: [[10, 0], [20, 0]] }
  ])
  assert.equal(findGcodeToolpathConflict(parseGcodeLayers(gcode)), null)
})

test('collinear overlap longer than the tolerance is a conflict', () => {
  // The second rule in Studio's test: two objects laying beads down the same line, not merely
  // crossing it. A proper-crossing test alone finds nothing here, because they are parallel.
  const gcode = plate([
    { id: 1, points: [[0, 5], [20, 5]] },
    { id: 2, points: [[10, 5], [30, 5]] }
  ])
  const conflict = findGcodeToolpathConflict(parseGcodeLayers(gcode))
  assert.ok(conflict, 'a 10mm collinear overlap must be reported')
  assert.ok(Math.abs(conflict.point.y - 5) < 1e-6)
})

test('the LOWEST conflicting layer is reported, not whichever is found first', () => {
  // Studio parallelises over layers and returns whichever thread won, so its answer is neither
  // deterministic nor necessarily the lowest. Reporting the lowest is the deliberate improvement.
  const lines = ['G90', 'M83', '; LAYER_HEIGHT: 0.2', '; LINE_WIDTH: 0.42', 'G1 X0 Y0 Z0.2 F1200']
  for (const [index, z] of [0.2, 0.4, 0.6].entries()) {
    // Layers 1 and 2 conflict; layer 0 does not.
    const conflicting = index > 0
    lines.push('; start printing object, unique label id: 1', '; FEATURE: Outer wall')
    lines.push(`G1 X0 Y10 Z${z} F30000`, `G1 X20 Y10 Z${z} E0.5`, 'M625')
    lines.push('; start printing object, unique label id: 2', '; FEATURE: Outer wall')
    lines.push(`G1 X10 Y${conflicting ? 0 : 40} Z${z} F30000`, `G1 X10 Y${conflicting ? 20 : 60} Z${z} E0.5`, 'M625')
  }
  const conflict = findGcodeToolpathConflict(parseGcodeLayers(lines.join('\n')))
  assert.ok(conflict)
  assert.equal(conflict.layer, 1, 'the first conflicting layer, not the last')
  assert.ok(Math.abs(conflict.layerZ - 0.4) < 1e-6)
})
