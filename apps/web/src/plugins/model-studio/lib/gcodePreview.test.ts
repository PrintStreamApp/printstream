import assert from 'node:assert/strict'
import { test } from 'node:test'
import type * as THREE from 'three'
import { buildLayeredGcodePreview, parseGcodeLayers, representativeLayerHeight } from './gcodePreview'

/** Profile vertex count of the bead cross-section (mirrors PROFILE in gcodePreview.ts). */
const P = 6

/**
 * The FIRST layer's bead geometry. The bead is split into one mesh per layer (see
 * `buildPerLayerMeshes`), and these tests build single-layer G-code, so this is that layer.
 */
function extrusionGeometry(preview: ReturnType<typeof buildLayeredGcodePreview>): THREE.BufferGeometry {
  const mesh = preview.object.children.find((child) => (child as THREE.Mesh).isMesh) as THREE.Mesh
  return mesh.geometry
}

/** Every layer's bead geometry, for checks that must hold across the whole print. */
function allExtrusionGeometries(preview: ReturnType<typeof buildLayeredGcodePreview>): THREE.BufferGeometry[] {
  return preview.object.children
    .filter((child) => (child as unknown as { isMesh?: boolean }).isMesh)
    .map((child) => (child as THREE.Mesh).geometry)
}

/** Compare positions tolerant of Float32Array precision. */
function assertCloseArray(actual: Float32Array, start: number, expected: number[]): void {
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Math.abs(actual[start + i]! - expected[i]!) < 1e-3, `index ${start + i}: ${actual[start + i]} != ${expected[i]}`)
  }
}

test('parseGcodeLayers groups extrusion by Z height and ignores travel z-hops', () => {
  // Two print layers at Z=0.2 and Z=0.4, with a travel z-hop (Z=1) between extrusions
  // that must NOT count as its own layer.
  const gcode = [
    'G90', 'M82',
    'G1 Z0.2 F600',
    'G1 X0 Y0 E0',          // position only (no extrusion length yet)
    'G1 X10 Y0 E1',         // layer 0 extrude
    'G1 X10 Y10 E2',        // layer 0 extrude
    'G1 Z1 F600',           // travel z-hop (no XY, no extrude) -> ignored
    'G0 X0 Y0',             // travel move on layer 0
    'G1 Z0.4 F600',
    'G1 X10 Y0 E3',         // layer 1 extrude
  ].join('\n')

  const parsed = parseGcodeLayers(gcode)
  assert.equal(parsed.layerCount, 2)
  // Layer 0 has 2 extrusion segments (4 vertices); layer 1 has 1 (2 vertices).
  assert.deepEqual(parsed.extrusionLayerEnd, [4, 6])
  assert.equal(parsed.extrusionPositions.length, 6 * 3)
  // First extrusion segment runs (0,0,0.2)->(10,0,0.2).
  assertCloseArray(parsed.extrusionPositions, 0, [0, 0, 0.2, 10, 0, 0.2])
})

test('parseGcodeLayers honors relative positioning and relative extrusion', () => {
  const gcode = [
    'G90', 'M83',           // absolute XYZ, relative E
    'G1 X0 Y0 Z0.2',
    'G1 X5 Y0 E0.5',        // relative extrude > 0 -> layer 0
    'G91',                  // relative XYZ
    'G1 X5 Y0 E0.5',        // moves to X10 -> still layer 0 (same Z)
  ].join('\n')

  const parsed = parseGcodeLayers(gcode)
  assert.equal(parsed.layerCount, 1)
  assert.deepEqual(parsed.extrusionLayerEnd, [4])
  // Second segment is relative: from (5,0,0.2) to (10,0,0.2).
  assertCloseArray(parsed.extrusionPositions, 6, [5, 0, 0.2, 10, 0, 0.2])
})

test('parseGcodeLayers resets extrusion baseline on G92 E0 so retracts are not extrusions', () => {
  const gcode = [
    'G90', 'M82',
    'G1 X0 Y0 Z0.2',
    'G1 X10 Y0 E5',         // layer 0 extrude
    'G92 E0',               // reset E baseline
    'G1 X10 Y10 E5',        // E5 again, but baseline reset -> still a real extrusion
  ].join('\n')

  const parsed = parseGcodeLayers(gcode)
  assert.equal(parsed.layerCount, 1)
  // Both moves extrude (the second only because G92 reset the baseline to 0).
  assert.deepEqual(parsed.extrusionLayerEnd, [4])
})

test('parseGcodeLayers interpolates G2/G3 arc moves into segments on the arc', () => {
  // CCW quarter circle, radius 10 about the origin: (10,0) -> (0,10), I/J point to the centre.
  const gcode = [
    'G90', 'M82',
    'G1 X10 Y0 Z0.2',        // position only
    'G3 X0 Y10 I-10 J0 E5',  // extruding arc
  ].join('\n')

  const parsed = parseGcodeLayers(gcode)
  assert.equal(parsed.layerCount, 1)
  const segCount = parsed.extrusionPositions.length / 6
  assert.ok(segCount >= 6, `arc should tessellate into many segments, got ${segCount}`)
  // Every interpolated vertex sits on the radius-10 circle.
  for (let i = 0; i < parsed.extrusionPositions.length; i += 3) {
    const vx = parsed.extrusionPositions[i]!, vy = parsed.extrusionPositions[i + 1]!
    assert.ok(Math.abs(Math.hypot(vx, vy) - 10) < 0.2, `vertex ${i / 3} off the arc: r=${Math.hypot(vx, vy)}`)
  }
  // First vertex is the start, last vertex is the commanded endpoint.
  assertCloseArray(parsed.extrusionPositions, 0, [10, 0, 0.2])
  assertCloseArray(parsed.extrusionPositions, parsed.extrusionPositions.length - 3, [0, 10, 0.2])
  // One width/height/role entry per generated segment.
  assert.equal(parsed.extrusionWidths.length, segCount)
})

test('parseGcodeLayers keeps a Z-changing (helical) arc on a single layer, not one per sub-segment', () => {
  // A spiral arc whose Z rises across the sweep: previously each interpolated sub-segment bumped
  // the layer counter, exploding layerCount. It should count as one layer (keyed off the move).
  const gcode = [
    'G90', 'M82',
    'G1 X10 Y0 Z0.2',          // position only
    'G3 X0 Y10 Z0.4 I-10 J0 E5' // extruding arc that also climbs in Z
  ].join('\n')

  const parsed = parseGcodeLayers(gcode)
  assert.equal(parsed.layerCount, 1)
  assert.ok(parsed.extrusionPositions.length / 6 >= 6, 'arc still tessellates into many segments')
})

test('parseGcodeLayers caps arc chord length so large-radius walls stay round', () => {
  // Quarter circle at radius 100: sag tolerance alone would allow ~8mm flat chords, which read
  // as straight facets on big curved walls. Every tessellated chord must stay near 1mm.
  const gcode = [
    'G90', 'M82',
    'G1 X100 Y0 Z0.2',
    'G3 X0 Y100 I-100 J0 E5',
  ].join('\n')

  const parsed = parseGcodeLayers(gcode)
  const segCount = parsed.extrusionPositions.length / 6
  assert.ok(segCount >= 150, `expected fine tessellation, got ${segCount} segments`)
  for (let seg = 0; seg < segCount; seg++) {
    const o = seg * 6
    const chord = Math.hypot(
      parsed.extrusionPositions[o + 3]! - parsed.extrusionPositions[o]!,
      parsed.extrusionPositions[o + 4]! - parsed.extrusionPositions[o + 1]!
    )
    assert.ok(chord < 1.05, `segment ${seg} chord too long: ${chord}mm`)
  }
})

test('parseGcodeLayers reads LINE_WIDTH, LAYER_HEIGHT and FEATURE per segment', () => {
  const gcode = [
    'G90', 'M82',
    '; LAYER_HEIGHT: 0.2',
    '; FEATURE: Outer wall',
    '; LINE_WIDTH: 0.42',
    'G1 X0 Y0 Z0.2',         // position only
    'G1 X10 Y0 E1',          // outer wall @ 0.42
    '; FEATURE: Sparse infill',
    '; LINE_WIDTH: 0.6',
    'G1 X10 Y10 E2',         // sparse infill @ 0.6
  ].join('\n')

  const parsed = parseGcodeLayers(gcode)
  assert.equal(parsed.extrusionWidths.length, 2)
  assert.ok(Math.abs(parsed.extrusionWidths[0]! - 0.42) < 1e-6)
  assert.ok(Math.abs(parsed.extrusionWidths[1]! - 0.6) < 1e-6)
  assert.ok(Math.abs(parsed.extrusionHeights[0]! - 0.2) < 1e-6)
  // Outer wall -> palette index 2, Sparse infill -> index 4.
  assert.deepEqual(Array.from(parsed.extrusionRoles), [2, 4])
})

test('buildLayeredGcodePreview welds contiguous same-bead segments into one tube', () => {
  // One path of two segments with identical width/height/feature: the shared joint must reuse a
  // single ring (3 rings + 2 cap rings, not 4 + 4) so curved walls have no gaps between segments.
  const gcode = [
    'G90', 'M82',
    '; LAYER_HEIGHT: 0.2',
    '; LINE_WIDTH: 0.42',
    '; FEATURE: Outer wall',
    'G1 X0 Y0 Z0.2',
    'G1 X10 Y0 E1',
    'G1 X20 Y0 E2',
  ].join('\n')

  const preview = buildLayeredGcodePreview(parseGcodeLayers(gcode))
  const geometry = extrusionGeometry(preview)
  assert.equal(geometry.getAttribute('position').count, (3 + 2) * P)
  // 2 tube sections (P quads = P*6 indices each) + 2 end caps ((P-2)*3 indices each).
  assert.equal(geometry.getIndex()!.count, 2 * P * 6 + 2 * (P - 2) * 3)
  // Every vertex carries a unit normal (smooth shading; no flat-shaded facet banding).
  // Normals are stored int8-normalized, so allow the quantization error (~1/127 per axis).
  const normals = geometry.getAttribute('normal')
  assert.equal(normals.count, geometry.getAttribute('position').count)
  for (let i = 0; i < normals.count; i++) {
    const len = Math.hypot(normals.getX(i), normals.getY(i), normals.getZ(i))
    assert.ok(Math.abs(len - 1) < 2.5e-2, `normal ${i} not unit length: ${len}`)
  }
  preview.dispose()
})

test('buildLayeredGcodePreview welds across small width changes with a tapered joint', () => {
  // Bambu varies LINE_WIDTH slightly between wall moves; a small change must keep the weld
  // (3 rings + 2 cap rings) with the joint ring at the averaged width.
  const gcode = [
    'G90', 'M82',
    '; LAYER_HEIGHT: 0.2',
    '; LINE_WIDTH: 0.42',
    '; FEATURE: Outer wall',
    'G1 X0 Y0 Z0.2',
    'G1 X10 Y0 E1',
    '; LINE_WIDTH: 0.46',
    'G1 X20 Y0 E2',
  ].join('\n')

  const preview = buildLayeredGcodePreview(parseGcodeLayers(gcode))
  const geometry = extrusionGeometry(preview)
  const positions = geometry.getAttribute('position')
  assert.equal(positions.count, (3 + 2) * P)
  // Joint ring (vertices 2P..3P-1, after the start ring and its cap ring) sits at the averaged
  // half width: profile u=-1 on a straight +X path (perp (0,1)) -> y = -avgHalfW.
  const avgHalfW = (0.42 + 0.46) / 4
  assert.ok(Math.abs(positions.getY(2 * P) + avgHalfW) < 1e-3, `joint y ${positions.getY(2 * P)} != ${-avgHalfW}`)
  preview.dispose()
})

test('buildLayeredGcodePreview miters the shared ring at a bend', () => {
  // A 90-degree corner at (10,0): the joint ring must lie along the miter direction, widened by
  // 1/cos(45deg), so the bead's outer wall stays flush through the bend.
  const gcode = [
    'G90', 'M82',
    '; LAYER_HEIGHT: 0.2',
    '; LINE_WIDTH: 0.42',
    '; FEATURE: Outer wall',
    'G1 X0 Y0 Z0.2',
    'G1 X10 Y0 E1',
    'G1 X10 Y10 E2',
  ].join('\n')

  const preview = buildLayeredGcodePreview(parseGcodeLayers(gcode))
  const geometry = extrusionGeometry(preview)
  const positions = geometry.getAttribute('position')
  assert.equal(positions.count, (3 + 2) * P)
  // Joint ring follows the start ring and its cap ring (vertices 2P..3P-1). Its first profile
  // vertex has u = -1, i.e. corner - miter * (halfW / cos(45deg)); miter = normalize((0,1) + (-1,0)).
  const halfW = 0.21
  const scaled = halfW / Math.cos(Math.PI / 4)
  const expectedX = 10 - -Math.SQRT1_2 * scaled
  const expectedY = 0 - Math.SQRT1_2 * scaled
  assert.ok(Math.abs(positions.getX(2 * P) - expectedX) < 1e-3, `joint x ${positions.getX(2 * P)} != ${expectedX}`)
  assert.ok(Math.abs(positions.getY(2 * P) - expectedY) < 1e-3, `joint y ${positions.getY(2 * P)} != ${expectedY}`)
  preview.dispose()
})

test('buildLayeredGcodePreview breaks the weld when the width changes sharply', () => {
  // Same path but the second segment jumps width beyond the taper tolerance: the joint must NOT
  // weld (4 rings + 4 cap rings) and every open end gets a cap, so each bead stays closed.
  const gcode = [
    'G90', 'M82',
    '; LAYER_HEIGHT: 0.2',
    '; LINE_WIDTH: 0.42',
    '; FEATURE: Outer wall',
    'G1 X0 Y0 Z0.2',
    'G1 X10 Y0 E1',
    '; LINE_WIDTH: 0.6',
    'G1 X20 Y0 E2',
  ].join('\n')

  const preview = buildLayeredGcodePreview(parseGcodeLayers(gcode))
  const geometry = extrusionGeometry(preview)
  assert.equal(geometry.getAttribute('position').count, (4 + 4) * P)
  // 2 tubes + 4 caps.
  assert.equal(geometry.getIndex()!.count, 2 * P * 6 + 4 * (P - 2) * 3)
  preview.dispose()
})

test('buildLayeredGcodePreview patches the material with the anti-moire normal fade', () => {
  const gcode = [
    'G90', 'M82',
    '; LAYER_HEIGHT: 0.16',
    '; LINE_WIDTH: 0.5',
    '; FEATURE: Outer wall',
    'G1 X0 Y0 Z0.16',
    'G1 X10 Y0 E1',
    '; FEATURE: Top surface',
    'G1 X10 Y10 E2',
  ].join('\n')

  const preview = buildLayeredGcodePreview(parseGcodeLayers(gcode))
  const mesh = preview.object.children.find((child) => (child as THREE.Mesh).isMesh) as THREE.Mesh
  // Wall beads fade against layer stacking (aMacroUp 0); flat beads against bead pitch (1).
  const macroUp = mesh.geometry.getAttribute('aMacroUp')
  assert.equal(macroUp.count, mesh.geometry.getAttribute('position').count)
  assert.equal(macroUp.getX(0), 0)
  assert.equal(macroUp.getX(macroUp.count - 1), 1)
  // Apply the onBeforeCompile patch to a stand-in shader carrying the three.js chunk markers it
  // targets; if a three upgrade renames a chunk, the replacements stop landing and this fails.
  const material = mesh.material as THREE.MeshStandardMaterial
  const shader = {
    uniforms: {} as Record<string, { value: number }>,
    vertexShader: '#include <common>\n#include <project_vertex>',
    fragmentShader: '#include <common>\n#include <normal_fragment_begin>'
  }
  material.onBeforeCompile(shader as never, null as never)
  assert.ok(Math.abs(shader.uniforms.uLayerPitch!.value - 0.16) < 1e-6)
  assert.ok(Math.abs(shader.uniforms.uBeadWidth!.value - 0.5) < 1e-6)
  assert.ok(shader.vertexShader.includes('vBeadWorld = '), 'vertex stage must export the world-position varying')
  assert.ok(shader.fragmentShader.includes('repeatsPerPixel'), 'fragment stage must apply the fade')
  preview.dispose()
})

test('buildLayeredGcodePreview allocates exact-size quantized buffers', () => {
  // Mix of welded (90-degree miter), weld-broken (sharp width jump), and isolated segments
  // so the counting pre-pass is exercised across every branch.
  const gcode = [
    'G90', 'M82',
    '; LAYER_HEIGHT: 0.2',
    '; LINE_WIDTH: 0.42',
    '; FEATURE: Outer wall',
    'G1 X0 Y0 Z0.2',
    'G1 X10 Y0 E1',
    'G1 X10 Y10 E2',
    '; LINE_WIDTH: 0.8',
    'G1 X20 Y10 E3',
  ].join('\n')

  const preview = buildLayeredGcodePreview(parseGcodeLayers(gcode))
  const geometry = extrusionGeometry(preview)
  const positions = geometry.getAttribute('position') as THREE.BufferAttribute
  const normals = geometry.getAttribute('normal') as THREE.BufferAttribute
  const colors = geometry.getAttribute('color') as THREE.BufferAttribute
  const index = geometry.getIndex()!
  // The backing ArrayBuffers are trimmed to what welding/caps actually used: the previous
  // worst-case allocation (4 rings per segment) retained the full oversized buffers on
  // dense plates via subarray views.
  assert.equal((positions.array as Float32Array).buffer.byteLength, positions.count * 3 * 4)
  assert.ok(normals.array instanceof Int8Array && normals.normalized, 'normals are int8-normalized')
  assert.equal((normals.array as Int8Array).buffer.byteLength, normals.count * 3)
  assert.ok(colors.array instanceof Uint8Array && colors.normalized, 'colours are uint8-normalized')
  assert.equal((colors.array as Uint8Array).buffer.byteLength, colors.count * 3)
  assert.ok(index.array instanceof Uint16Array, 'small meshes use a uint16 index')
  assert.equal((index.array as Uint16Array).buffer.byteLength, index.count * 2)
  preview.dispose()
})

test('buildLayeredGcodePreview precomputes bounds so freed CPU arrays are never re-read', () => {
  // The renderer frees the CPU arrays after upload (onUpload); its sort pass lazily
  // computes a null boundingSphere in the SAME frame, after the free, so the builder
  // must leave every geometry with bounds already computed.
  const gcode = [
    'G90', 'M82',
    '; LAYER_HEIGHT: 0.2',
    '; LINE_WIDTH: 0.42',
    '; FEATURE: Outer wall',
    'G1 X0 Y0 Z0.2',
    'G1 X10 Y0 E1',
    'G0 X0 Y0',
  ].join('\n')

  const preview = buildLayeredGcodePreview(parseGcodeLayers(gcode))
  for (const child of preview.object.children) {
    const geometry = (child as THREE.Mesh).geometry
    assert.ok(geometry.boundingSphere, `${child.type} boundingSphere precomputed`)
    assert.ok(geometry.boundingBox, `${child.type} boundingBox precomputed`)
  }
  preview.dispose()
})

test('representativeLayerHeight returns the median, robust to adaptive-height outliers', () => {
  assert.ok(Math.abs(representativeLayerHeight(new Float32Array([0.2, 0.2, 0.2, 0.08, 0.28])) - 0.2) < 1e-6)
  // Zero entries are skipped; an empty/zeroed array falls back to the 0.2 default.
  assert.equal(representativeLayerHeight(new Float32Array([])), 0.2)
  assert.ok(Math.abs(representativeLayerHeight(new Float32Array([0, 0, 0.16])) - 0.16) < 1e-6)
})

test('buildLayeredGcodePreview keeps per-layer draw ranges aligned with welded geometry', () => {
  const gcode = [
    'G90', 'M82',
    '; LAYER_HEIGHT: 0.2',
    '; LINE_WIDTH: 0.42',
    '; FEATURE: Outer wall',
    'G1 X0 Y0 Z0.2',
    'G1 X10 Y0 E1',
    'G1 X10 Y10 E2',
    'G1 Z0.4',
    'G1 X0 Y10 E3',
  ].join('\n')

  const preview = buildLayeredGcodePreview(parseGcodeLayers(gcode))
  assert.equal(preview.layerCount, 2)
  // Asserted through what is DRAWN rather than a single draw range: the bead is now one mesh per
  // layer, so "visible" is a per-layer decision plus a range on the top layer alone.
  const totalTriangles = allExtrusionGeometries(preview).reduce((sum, g) => sum + g.getIndex()!.count, 0) / 3
  const singleLayerTriangles = (P * 6 + 2 * (P - 2) * 3) / 3

  preview.setVisibleLayers(1)
  assert.equal(drawnTriangles(preview).size, totalTriangles, 'the whole print draws every triangle')

  preview.setVisibleLayers(1, { single: true })
  // Single layer 1: one isolated segment = 1 tube + 2 caps.
  assert.equal(drawnTriangles(preview).size, singleLayerTriangles)

  // Within-layer scrub: layer 0 has 2 welded moves; truncating after the first must stop at that
  // move's recorded boundary, and moveEnd 0 hides the whole top layer.
  assert.equal(preview.moveCount(0), 2)
  assert.equal(preview.moveCount(1), 1)
  preview.setVisibleLayers(0, { moveEnd: 1 })
  const truncated = drawnTriangles(preview).size
  assert.ok(truncated > 0 && truncated < totalTriangles - singleLayerTriangles)
  preview.setVisibleLayers(0, { moveEnd: 0 })
  assert.equal(drawnTriangles(preview).size, 0, 'moveEnd 0 draws nothing')
  // moveEnd at/above the move count shows the full layer again.
  preview.setVisibleLayers(0, { moveEnd: 99 })
  assert.equal(drawnTriangles(preview).size, totalTriangles - singleLayerTriangles)
  // No vertex slot escaped initialization (caps/welds only shrink usage; the buffers are trimmed).
  const positions = extrusionGeometry(preview).getAttribute('position')
  for (let i = 0; i < positions.count; i++) {
    assert.ok(Number.isFinite(positions.getX(i)) && Number.isFinite(positions.getY(i)) && Number.isFinite(positions.getZ(i)))
  }
  preview.dispose()
})

test('parseGcodeLayers accumulates per-feature time, filament usage, and the header total', () => {
  const gcode = [
    '; total estimated time: 1m 30s',
    'G90', 'M82',
    'G1 Z0.2 F600',
    'G1 X0 Y0 E0',
    '; FEATURE: Outer wall',
    'G1 X60 Y0 E2 F1200',  // 60mm at 20mm/s -> 3s, 2mm filament
    '; FEATURE: Sparse infill',
    'G1 X60 Y30 E3 F600',  // 30mm at 10mm/s -> 3s, 1mm filament
    'G0 X0 Y0 F6000',      // 67.08mm travel at 100mm/s -> ~0.67s
  ].join('\n')

  const { stats } = parseGcodeLayers(gcode)
  assert.equal(stats.headerTotalSeconds, 90)
  assert.ok(Math.abs(stats.featureSeconds[2]! - 3) < 1e-6, `outer wall ${stats.featureSeconds[2]}`)
  assert.ok(Math.abs(stats.featureSeconds[4]! - 3) < 1e-6, `infill ${stats.featureSeconds[4]}`)
  // Travel = the XY return (67.08mm at 100mm/s) plus the initial Z move (0.2mm at 10mm/s).
  assert.ok(Math.abs(stats.travelSeconds - (Math.hypot(60, 30) / 100 + 0.02)) < 1e-3, `travel ${stats.travelSeconds}`)
  assert.ok(Math.abs(stats.totalSeconds - (6 + stats.travelSeconds)) < 1e-9)
  assert.equal(stats.featureExtrusionMm[2], 2)
  assert.equal(stats.featureExtrusionMm[4], 1)
  assert.equal(stats.filamentMm, 3)
  assert.ok(Math.abs(stats.maxZ - 0.2) < 1e-9)
})

test('parseGcodeDuration formats via the header regex: hours and days', () => {
  const gcode = ['; model printing time: 8m 2s; total estimated time: 1d 2h 3m 4s', 'G90'].join('\n')
  const { stats } = parseGcodeLayers(gcode)
  assert.equal(stats.headerTotalSeconds, 86400 + 2 * 3600 + 3 * 60 + 4)
})

/*
 * Winding, checked as pure geometry with no GPU involved.
 *
 * Each triangle's GEOMETRIC normal (from its vertex order) must agree with the OUTWARD normal the
 * builder authored per vertex: `pushVertex` is given an explicit outward direction, so the two
 * agreeing is exactly "this triangle is wound front-side out". That invariant holds for any path
 * shape; an earlier cut of this compared against the solid's centre instead, which is only valid
 * for a CONVEX solid and reported false failures the moment the path turned a corner.
 *
 * It matters because the mesh was drawn `side: DoubleSide`, shading BOTH faces of all 2.6M
 * triangles (measured on a real plate) for back faces a closed bead can never show. Culling them
 * is free only if the winding is consistent, which DoubleSide let us never establish.
 */
function windingReport(geometry: THREE.BufferGeometry): { total: number; inward: number } {
  const position = geometry.getAttribute('position')
  const normal = geometry.getAttribute('normal')
  const index = geometry.getIndex()
  assert.ok(index, 'indexed geometry')
  assert.ok(normal, 'authored outward normals')

  let inward = 0
  const total = index.count / 3
  for (let t = 0; t < total; t++) {
    const a = index.getX(t * 3), b = index.getX(t * 3 + 1), c = index.getX(t * 3 + 2)
    const ax = position.getX(a), ay = position.getY(a), az = position.getZ(a)
    const bx = position.getX(b), by = position.getY(b), bz = position.getZ(b)
    const cx2 = position.getX(c), cy2 = position.getY(c), cz2 = position.getZ(c)
    // Geometric normal = (B-A) x (C-A); CCW when viewed from the side it faces.
    const ux = bx - ax, uy = by - ay, uz = bz - az
    const vx = cx2 - ax, vy = cy2 - ay, vz = cz2 - az
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    // Outward reference: the normals the builder authored for these vertices.
    const ox = (normal.getX(a) + normal.getX(b) + normal.getX(c)) / 3
    const oy = (normal.getY(a) + normal.getY(b) + normal.getY(c)) / 3
    const oz = (normal.getZ(a) + normal.getZ(b) + normal.getZ(c)) / 3
    if (nx * ox + ny * oy + nz * oz <= 0) inward += 1
  }
  return { total, inward }
}

test('every bead triangle faces outward, so back-face culling is safe', () => {
  // One straight extrusion: side quads plus a cap at each end.
  const parsed = parseGcodeLayers([
    'G1 Z0.2',
    'G1 X0 Y0',
    'G1 X20 Y0 E5'
  ].join('\n'))
  const preview = buildLayeredGcodePreview(parsed)
  let total = 0, inward = 0
  for (const geometry of allExtrusionGeometries(preview)) {
    const report = windingReport(geometry)
    total += report.total; inward += report.inward
  }
  assert.ok(total > 0, 'geometry was built')
  assert.equal(inward, 0, `${inward} of ${total} triangles face inward`)
})

test('winding holds through a welded joint and a direction reversal', () => {
  // A corner welds two segments (shared ring) and reverses direction: the cases where a
  // hand-rolled winding is most likely to flip.
  // E is ABSOLUTE here, so each move must raise it or the parser reads a travel and the corner
  // never gets built (the first cut of this test silently checked one straight segment).
  const parsed = parseGcodeLayers([
    'G1 Z0.2',
    'G1 X0 Y0',
    'G1 X20 Y0 E5',
    'G1 X20 Y20 E10',
    'G1 X0 Y20 E15'
  ].join('\n'))
  assert.equal(parsed.extrusionPositions.length / 6, 3, 'three extrusion segments, not one')
  const { total, inward } = windingReport(extrusionGeometry(buildLayeredGcodePreview(parsed)))
  assert.ok(total > 20, 'more than the single-segment case')
  assert.equal(inward, 0, `${inward} of ${total} triangles face inward`)
})

/** Every triangle the preview would actually draw, as a set of "a,b,c" index triples. */
function drawnTriangles(preview: ReturnType<typeof buildLayeredGcodePreview>): Set<string> {
  const drawn = new Set<string>()
  for (const child of preview.object.children) {
    const mesh = child as THREE.Mesh
    if (!(mesh as unknown as { isMesh?: boolean }).isMesh || !mesh.visible) continue
    const index = mesh.geometry.getIndex()
    if (!index) continue
    const range = mesh.geometry.drawRange
    const start = range.start
    const count = Math.min(range.count === Infinity ? index.count : range.count, index.count - start)
    for (let i = 0; i < count; i += 3) {
      drawn.add(`${index.getX(start + i)},${index.getX(start + i + 1)},${index.getX(start + i + 2)}`)
    }
  }
  return drawn
}

// The bead is split into one mesh PER LAYER so three can sort them front-to-back (`painterSortStable`
// orders opaque objects by ascending camera z, which lets early-Z discard buried fragments). A
// single mesh drew layer 0 first, back-to-front for a top-down camera, so every layer was shaded
// and then painted over. The split must not change WHICH triangles are drawn, only their order.
test('the layer split draws one mesh per layer and nothing else changes', () => {
  const parsed = parseGcodeLayers([
    'G1 Z0.2', 'G1 X0 Y0', 'G1 X20 Y0 E5', 'G1 X20 Y20 E10',
    'G1 Z0.4', 'G1 X0 Y0', 'G1 X20 Y0 E15',
    'G1 Z0.6', 'G1 X0 Y0', 'G1 X20 Y0 E20'
  ].join('\n'))
  const preview = buildLayeredGcodePreview(parsed)
  assert.equal(preview.layerCount, 3)
  const meshes = preview.object.children.filter((c) => (c as unknown as { isMesh?: boolean }).isMesh)
  assert.equal(meshes.length, 3, 'one mesh per layer')

  // Each layer's bounds must be its OWN, not the whole print's: the trap when geometries share a
  // position buffer, because computeBoundingSphere would read all of it and cull nothing.
  const zs = meshes.map((m) => (m as THREE.Mesh).geometry.boundingBox!.min.z)
  assert.deepEqual([...zs].sort((a, b) => a - b), zs, 'layer bounds ascend with Z')
  assert.ok(zs[0]! < zs[2]!, 'the bottom layer does not claim the top layer position')

  // Showing everything draws every triangle exactly once.
  preview.setVisibleLayers(2)
  const all = drawnTriangles(preview)
  const totalIndices = meshes.reduce((sum, m) => sum + ((m as THREE.Mesh).geometry.getIndex()?.count ?? 0), 0)
  assert.equal(all.size, totalIndices / 3, 'every triangle drawn once, none duplicated')
})

test('scrubbing hides upper layers and truncates the top one, as the single mesh did', () => {
  const parsed = parseGcodeLayers([
    'G1 Z0.2', 'G1 X0 Y0', 'G1 X20 Y0 E5',
    'G1 Z0.4', 'G1 X0 Y0', 'G1 X20 Y0 E10', 'G1 X20 Y20 E15'
  ].join('\n'))
  const preview = buildLayeredGcodePreview(parsed)

  preview.setVisibleLayers(1)
  const both = drawnTriangles(preview)
  preview.setVisibleLayers(0)
  const bottomOnly = drawnTriangles(preview)
  assert.ok(bottomOnly.size > 0 && bottomOnly.size < both.size, 'hiding the top layer draws less')
  for (const triangle of bottomOnly) assert.ok(both.has(triangle), 'and draws a SUBSET, not different geometry')

  // `single` shows only the top layer: disjoint from the bottom-only set.
  preview.setVisibleLayers(1, { single: true })
  const topOnly = drawnTriangles(preview)
  assert.ok(topOnly.size > 0)
  for (const triangle of topOnly) assert.ok(!bottomOnly.has(triangle), 'single mode excludes lower layers')

  // Truncating the top layer's moves draws strictly fewer than the whole layer.
  preview.setVisibleLayers(1, { single: true, moveEnd: 1 })
  const truncated = drawnTriangles(preview)
  assert.ok(truncated.size > 0 && truncated.size < topOnly.size, 'the move scrub still truncates')
  for (const triangle of truncated) assert.ok(topOnly.has(triangle))
})
