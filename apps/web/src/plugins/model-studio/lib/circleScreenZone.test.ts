import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { circleScreenZone, raySeesThroughCircle } from './circleScreenZone'

/** A circle whose rim lies in the XY plane, so an identity projection keeps it round on screen. */
function flatCircle(radius: number, segments = 64) {
  const rim: THREE.Vector3[] = []
  for (let i = 0; i < segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2
    rim.push(new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, 0))
  }
  return { center: new THREE.Vector3(0, 0, 0), rim }
}

/** World XY straight through to screen XY, so the fixtures read as the pixels they describe. */
const flat = (point: THREE.Vector3) => ({ x: point.x, y: point.y })

const SNAP = 14

test('the ring is claimed within the snap reach, on both sides of it', () => {
  const circle = flatCircle(100)
  assert.equal(circleScreenZone(circle, { x: 100, y: 0 }, flat, SNAP), 'ring', 'dead on')
  assert.equal(circleScreenZone(circle, { x: 90, y: 0 }, flat, SNAP), 'ring', 'just inside')
  assert.equal(circleScreenZone(circle, { x: 110, y: 0 }, flat, SNAP), 'ring', 'just outside')
})

test('a small circle keeps a usable centre, because the ring band scales with it', () => {
  // A fixed band is most of a small hole: at a 14px reach a 16px radius would report its ring from
  // 2px to 30px out and leave a 2px centre, so the gesture the panel advertises would be unusable.
  const small = flatCircle(16)
  assert.equal(circleScreenZone(small, { x: 16, y: 0 }, flat, SNAP), 'ring', 'on the ring')
  assert.equal(circleScreenZone(small, { x: 8, y: 0 }, flat, SNAP), 'interior', 'half way in')
  assert.equal(circleScreenZone(small, { x: 0, y: 0 }, flat, SNAP), 'interior', 'dead centre')
})

test('the band never grows past the caller reach on a large circle', () => {
  // The fraction is a floor for small circles, not a licence to claim a 40px ring on a big bore.
  const large = flatCircle(200)
  assert.equal(circleScreenZone(large, { x: 180, y: 0 }, flat, SNAP), 'interior', '20px in is not the ring')
  assert.equal(circleScreenZone(large, { x: 188, y: 0 }, flat, SNAP), 'ring', '12px in is')
})

test('everything further inside the ring selects the centre', () => {
  const circle = flatCircle(100)
  assert.equal(circleScreenZone(circle, { x: 0, y: 0 }, flat, SNAP), 'interior', 'dead centre')
  assert.equal(circleScreenZone(circle, { x: 40, y: 30 }, flat, SNAP), 'interior', 'off centre')
})

test('outside the ring the circle claims nothing, so the model behind it stays pickable', () => {
  const circle = flatCircle(100)
  assert.equal(circleScreenZone(circle, { x: 140, y: 0 }, flat, SNAP), null)
})

test('a point the camera cannot see claims nothing', () => {
  // project() divides by a negative w behind the camera and hands back MIRRORED coordinates rather
  // than nothing, so a circle orbited out of view would go on claiming a region of the screen. The
  // projector reports null instead, and every zone must fall away with it.
  const circle = flatCircle(100)
  assert.equal(circleScreenZone(circle, { x: 0, y: 0 }, () => null, SNAP), null, 'centre unseen')
  const rimUnseen = (point: THREE.Vector3) => (point.lengthSq() > 0 ? null : { x: 0, y: 0 })
  assert.equal(circleScreenZone(circle, { x: 0, y: 0 }, rimUnseen, SNAP), null, 'every rim vertex unseen')
})

test('a tilted circle judges its ring along the cursor bearing, not from one rim vertex', () => {
  // The regression this module exists for. Squashing Y by 10x makes the ring an ellipse 100px across
  // and 10px tall. Sampling ONE rim vertex would take the first, at (100, 0) -- a 100px radius in
  // every direction -- so a cursor 40px above the centre would read as deep INSIDE the hole when it
  // is well outside a ring that only reaches 10px up there.
  const squashed = flatCircle(100)
  const project = (point: THREE.Vector3) => ({ x: point.x, y: point.y / 10 })

  assert.equal(circleScreenZone(squashed, { x: 0, y: 40 }, project, SNAP), null, 'past the short axis')
  assert.equal(circleScreenZone(squashed, { x: 0, y: 10 }, project, SNAP), 'ring', 'on the short axis')
  assert.equal(circleScreenZone(squashed, { x: 0, y: 0 }, project, SNAP), 'interior', 'dead centre')
  assert.equal(circleScreenZone(squashed, { x: 60, y: 0 }, project, SNAP), 'interior', 'inside the long axis')
  assert.equal(circleScreenZone(squashed, { x: 100, y: 0 }, project, SNAP), 'ring', 'on the long axis')
})

test('an edge-on circle claims nothing at all', () => {
  // Collapsed to a line, it has no interior to offer, and claiming one would swallow every click
  // aimed at whatever sits behind it.
  const circle = flatCircle(100)
  const edgeOn = (point: THREE.Vector3) => ({ x: point.x / 50, y: point.y / 50 })
  assert.equal(circleScreenZone(circle, { x: 0, y: 0 }, edgeOn, SNAP), null)
})

test('a circle with no detected rim claims nothing rather than swallowing its surroundings', () => {
  const rimless = { center: new THREE.Vector3(0, 0, 0), rim: [] }
  assert.equal(circleScreenZone(rimless, { x: 0, y: 0 }, flat, SNAP), null)
})

/** A ray fired straight down -Z from well above the origin, as a top view would cast one. */
const downward = (x = 0, y = 0) =>
  new THREE.Ray(new THREE.Vector3(x, y, 100), new THREE.Vector3(0, 0, -1))

/** A circle lying in the z = 0 plane, which the downward ray meets 100 units along. */
const inZeroPlane = { center: new THREE.Vector3(0, 0, 0), normal: new THREE.Vector3(0, 0, 1) }

test('a ray that reaches nothing is looking through the hole', () => {
  assert.equal(raySeesThroughCircle(inZeroPlane, downward(), Infinity), true)
})

test('a ray stopping at the circle\'s own plane is looking at solid face, not through it', () => {
  // The round-boss case. An outer silhouette is a circle too, so without this the top face of any
  // cylinder would be swallowed by its own rim and nothing on it could be picked.
  assert.equal(raySeesThroughCircle(inZeroPlane, downward(), 100), false)
})

test('a ray reaching past the plane is looking through the hole', () => {
  // The floor of a blind hole, or the far wall of a bore.
  assert.equal(raySeesThroughCircle(inZeroPlane, downward(), 130), true)
})

test('a ray stopped in FRONT of the circle is not looking through it', () => {
  // Something drawn over the hole stays pickable through the projected disc.
  assert.equal(raySeesThroughCircle(inZeroPlane, downward(), 40), false)
})

test('the plane tolerance scales, so a distant face does not read as a floor behind it', () => {
  // The two distances are equal BY CONSTRUCTION when the hit is the circle's own face, so the only
  // difference is float error, and that grows with depth. A fixed epsilon fails far from the origin.
  const far = { center: new THREE.Vector3(0, 0, 0), normal: new THREE.Vector3(0, 0, 1) }
  const ray = new THREE.Ray(new THREE.Vector3(0, 0, 1e5), new THREE.Vector3(0, 0, -1))
  assert.equal(raySeesThroughCircle(far, ray, 1e5 + 1), false, 'within the scaled tolerance')
  assert.equal(raySeesThroughCircle(far, ray, 1e5 + 100), true, 'genuinely behind it')
})

test('a circle the ray runs parallel to is never seen through', () => {
  // Offset from the plane and parallel to it, so the ray meets it NOWHERE: there is no depth to
  // compare, and the safe answer is the one that leaves the model pickable. (A ray lying exactly IN
  // the plane is a different case, meeting it everywhere, and is not what an edge-on view produces.)
  const parallel = new THREE.Ray(new THREE.Vector3(-100, 0, 5), new THREE.Vector3(1, 0, 0))
  assert.equal(raySeesThroughCircle(inZeroPlane, parallel, 50), false)
})
