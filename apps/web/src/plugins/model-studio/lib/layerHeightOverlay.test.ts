/**
 * The layer-height overlay shades the model, so it is a MESH sitting inside the object's own group
 * -- which is exactly where the editor's geometry traversals look for printed geometry.
 *
 * The dangerous one is `collectWorldTriangles`: it feeds the Adaptive tool's own input soup, so an
 * overlay left in it hands Adaptive every triangle twice and it derives a profile from geometry
 * that is not the model. Nothing throws; the profile is just wrong.
 *
 * The rest of the file pins the things that make the thickness bar legible at all: the colour
 * lookup follows the profile, buckets into ZONES rather than a ramp, and marks the brush band
 * WITHOUT bleeding over the whole model.
 *
 * Colours are asserted against {@link buildLayerHeightTable}, not against the meshes, because the
 * shading is computed per FRAGMENT in a shader. That is not incidental: a vertex-colour attribute
 * cannot express a 2mm band on a box wall built from two triangles spanning the whole height, which
 * is what made the first attempts render as a blur.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { printableMeshBox } from '../editorGeometry'
import { collectWorldTriangles } from './meshCut'
import {
  PROFILE_SAMPLES,
  buildLayerHeightTable,
  removeLayerHeightVisuals,
  syncLayerHeightVisuals
} from './layerHeightOverlay'

const BOUNDS = { min: 0.08, max: 0.28 }

/** A non-indexed box mesh in a group, the shape a placed object has. */
function objectGroup(height = 10): { group: THREE.Group; mesh: THREE.Mesh } {
  const geometry = new THREE.BoxGeometry(20, 20, height).toNonIndexed()
  // Sit it on the bed the way a placed object does, so object space and world space differ.
  geometry.translate(0, 0, height / 2)
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
  const group = new THREE.Group()
  group.add(mesh)
  // Placed objects hang off a plate root; keep that shape so world != object space here.
  const root = new THREE.Group()
  root.add(group)
  root.updateMatrixWorld(true)
  return { group, mesh }
}

function sync(group: THREE.Group, brushZ: number | null, profile: number[] = []): void {
  syncLayerHeightVisuals(group, {
    box: printableMeshBox(group),
    profile,
    bounds: BOUNDS,
    nominalHeight: 0.2,
    brush: brushZ == null ? null : { z: brushZ, bandWidth: 3 }
  })
}

/** The lookup colour at a given height, as the shader would sample it. */
function colorAt(table: Uint8Array, z: number, objectHeight: number): [number, number, number] {
  const sample = Math.min(Math.max(Math.round((z / objectHeight) * (PROFILE_SAMPLES - 1)), 0), PROFILE_SAMPLES - 1)
  return [table[sample * 4]!, table[sample * 4 + 1]!, table[sample * 4 + 2]!]
}

function table(profile: number[], brush?: { z: number; bandWidth: number }): Uint8Array {
  return buildLayerHeightTable({ profile, bounds: BOUNDS, nominalHeight: 0.2, objectHeight: 10, brush })
}

function differs(a: readonly number[], b: readonly number[]): number {
  return Math.abs(a[0]! - b[0]!) + Math.abs(a[1]! - b[1]!) + Math.abs(a[2]! - b[2]!)
}

/** The cursor's additive glow at a height, 0-255. Carried in alpha; the shader adds it as light. */
function glowAt(table: Uint8Array, z: number, objectHeight: number): number {
  const sample = Math.min(Math.max(Math.round((z / objectHeight) * (PROFILE_SAMPLES - 1)), 0), PROFILE_SAMPLES - 1)
  return table[sample * 4 + 3]!
}

test('the overlay stays out of the Adaptive tool input soup', () => {
  const { group } = objectGroup()
  const before = collectWorldTriangles(group).length
  sync(group, 5)
  assert.equal(collectWorldTriangles(group).length, before,
    'overlay leaked into collectWorldTriangles: Adaptive would read it as model geometry')
})

test('the cursor never changes the zone hue, so it cannot be read as another zone', () => {
  // The defect this replaced: the cursor mixed toward yellow, and yellow over the olive zone lands
  // almost exactly on the orange zone, so the cursor looked like a different layer thickness.
  const flat = [0, 0.2, 5, 0.2, 10, 0.2]
  const plain = table(flat)
  const brushed = table(flat, { z: 5, bandWidth: 3.6 })
  for (let z = 0; z <= 10; z += 0.5) {
    assert.equal(differs(colorAt(brushed, z, 10), colorAt(plain, z, 10)), 0,
      `cursor altered the zone colour at ${z}mm; it must add light, not tint`)
  }
})

test('the cursor is confined to the band the bar points at', () => {
  const brushed = table([0, 0.2, 5, 0.2, 10, 0.2], { z: 8, bandWidth: 2 })
  assert.ok(glowAt(brushed, 8, 10) > 200, `cursor centre is dim (${glowAt(brushed, 8, 10)})`)
  assert.equal(glowAt(brushed, 1, 10), 0, 'cursor reaches a height well outside its own band')
})

test("the cursor fades out like Studio's rather than ending in a wall", () => {
  // Studio's falloff shape is kept even though the cursor is now light rather than tint. The rim
  // sits at bandWidth / 1.8, Studio's own divisor.
  const brushed = table([0, 0.2, 5, 0.2, 10, 0.2], { z: 5, bandWidth: 3.6 })
  assert.ok(glowAt(brushed, 5, 10) > glowAt(brushed, 6, 10), 'glow does not fall off with distance')
  assert.equal(glowAt(brushed, 7.2, 10), 0, 'glow reaches past the cursor rim')
  assert.ok(glowAt(brushed, 6.9, 10) < glowAt(brushed, 5, 10) * 0.2, 'glow is still strong at the rim')
})

test('syncing repeatedly builds one overlay, not one per commit', () => {
  const { group, mesh } = objectGroup()
  for (let i = 0; i < 5; i += 1) sync(group, 4, [0, 0.1, 5, 0.2, 10, 0.1])
  const overlays = mesh.children.filter((child) => child.name === 'layerHeightOverlay')
  assert.equal(overlays.length, 1)
})

test('teardown removes every overlay', () => {
  const { group } = objectGroup()
  sync(group, 4)
  removeLayerHeightVisuals(group)
  let overlays = 0
  group.traverse((node) => { if (node.name === 'layerHeightOverlay') overlays += 1 })
  assert.equal(overlays, 0)
})

test('the shading tracks the profile: a varying curve tints differently at different heights', () => {
  const varying = table([0, 0.08, 10, 0.28])
  const delta = differs(colorAt(varying, 0, 10), colorAt(varying, 10, 10))
  assert.ok(delta > 50, `base and top tinted alike (delta ${delta}): the shading is not reading the profile`)
})

test('heights inside one step share a colour; crossing a step changes it', () => {
  // Zones are what make the tint read as layers rather than as a wash: flat bands with a hard edge
  // exactly where the thickness actually changes. A continuous ramp has an edge nowhere.
  const sameStep = (a: number, b: number): boolean =>
    differs(colorAt(table([0, a, 10, a]), 5, 10), colorAt(table([0, b, 10, b]), 5, 10)) === 0
  // 0.09 and 0.11 are both inside the first 0.04 step above the 0.08 floor.
  assert.equal(sameStep(0.09, 0.11), true, 'one step rendered as two colours: that is a gradient, not a zone')
  // 0.11 and 0.13 straddle the boundary at 0.12.
  assert.equal(sameStep(0.11, 0.13), false, 'a step boundary produced no colour change, so no visible edge')
})

test('the overlay is lit and carries normals, so the model keeps its shape', () => {
  // An unlit overlay paints one flat colour per height, which erases every shading cue and turns
  // the model into a glowing silhouette. That shipped once and was reported as exactly that.
  const { group, mesh } = objectGroup()
  sync(group, null, [0, 0.2, 10, 0.2])
  const overlay = mesh.children.find((child) => child.name === 'layerHeightOverlay') as THREE.Mesh
  const material = overlay.material as THREE.Material
  assert.equal('isMeshBasicMaterial' in material, false, 'overlay is unlit: the model will read as a glow')
  assert.ok(overlay.geometry.getAttribute('normal'), 'overlay has no normals, so a lit material shades it flat')
})

test('a flat profile shades uniformly, so an untouched model does not look varied', () => {
  const flat = table([0, 0.2, 5, 0.2, 10, 0.2])
  const base = colorAt(flat, 0, 10)
  for (let z = 0; z <= 10; z += 0.5) {
    assert.equal(differs(colorAt(flat, z, 10), base), 0, `flat profile varied at ${z}mm`)
  }
})
