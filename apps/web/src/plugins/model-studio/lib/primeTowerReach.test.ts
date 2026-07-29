/**
 * Prime-tower nozzle reach (see primeTowerReach.ts). A tower dropped in a "Left/Right nozzle only"
 * strip cannot be purged into by the other extruder, so unlike an object it is unprintable there
 * regardless of how materials are assigned.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clampPrimeTowerIntoReach, nozzleOnlyZoneBounds, primeTowerReachIssue } from './primeTowerReach'

const rect = (minX: number, maxX: number, minY: number, maxY: number) => ({ minX, maxX, minY, maxY })
const zone = (minX: number, maxX: number, label: string | null) => ({
  polygon: [{ x: minX, y: 0 }, { x: maxX, y: 0 }, { x: maxX, y: 320 }, { x: minX, y: 320 }],
  label
})

/** H2D-shaped bed: a left-nozzle-only strip at the left edge, right-only at the right. */
const BED = { minX: 0, maxX: 350, minY: 0, maxY: 320 }
const ZONES = [zone(0, 30, 'Left nozzle only'), zone(320, 350, 'Right nozzle only')]

test('only nozzle-limited zones count; ordinary unprintable areas are a different concern', () => {
  const mixed = [...ZONES, zone(100, 120, null), zone(200, 220, 'Unprintable')]
  assert.deepEqual(nozzleOnlyZoneBounds(mixed).map((entry) => entry.label), ['Left nozzle only', 'Right nozzle only'])
  // A tower over the unlabelled cutout is not flagged BY THIS RULE (objects report that separately).
  assert.equal(primeTowerReachIssue(rect(102, 118, 40, 56), mixed), null)
})

test('a tower inside a nozzle-only strip is reported, naming the zone the user can see', () => {
  const issue = primeTowerReachIssue(rect(5, 45, 40, 80), ZONES)
  assert.match(issue ?? '', /left nozzle only/i)
  assert.match(issue ?? '', /cannot reach/i)
  assert.match(primeTowerReachIssue(rect(310, 340, 40, 80), ZONES) ?? '', /right nozzle only/i)
})

test('a tower in the shared area, or merely touching a strip edge, is fine', () => {
  assert.equal(primeTowerReachIssue(rect(100, 160, 40, 100), ZONES), null)
  // Flush against the boundary is reachable; only real overlap is a problem.
  assert.equal(primeTowerReachIssue(rect(30, 90, 40, 100), ZONES), null)
  assert.equal(primeTowerReachIssue(null, ZONES), null)
  assert.equal(primeTowerReachIssue(rect(100, 160, 40, 100), []), null)
})

test('a drag into a strip is clamped clear of it, staying as close as possible', () => {
  // Mostly overlapping the left strip: least penetration is to the right, so it lands just clear.
  const moved = clampPrimeTowerIntoReach(rect(10, 50, 40, 80), BED, ZONES)
  assert.ok(moved.x >= 30, `expected clear of the 30mm strip, got ${moved.x}`)
  assert.equal(primeTowerReachIssue(rect(moved.x, moved.x + 40, moved.y, moved.y + 40), ZONES), null)
  assert.equal(moved.y, 40, 'the axis that was never in conflict must not move')

  const fromRight = clampPrimeTowerIntoReach(rect(300, 340, 40, 80), BED, ZONES)
  assert.ok(fromRight.x + 40 <= 320.5, `expected clear of the right strip, got ${fromRight.x}`)
})

test('a clean drag is left exactly where the user put it', () => {
  assert.deepEqual(clampPrimeTowerIntoReach(rect(100, 140, 40, 80), BED, ZONES), { x: 100, y: 40 })
  assert.deepEqual(clampPrimeTowerIntoReach(rect(100, 140, 40, 80), BED, []), { x: 100, y: 40 })
})

test('clamping never pushes the tower off the plate, even when it cannot fit the shared area', () => {
  // Shared area is 30..320 (290mm); a 300mm tower fits nowhere. It must stay on the bed and be
  // reported rather than shoved past the edge.
  const huge = clampPrimeTowerIntoReach(rect(10, 310, 40, 80), BED, ZONES)
  assert.ok(huge.x >= BED.minX, 'stayed on the plate')
  assert.ok(huge.x + 300 <= BED.maxX, 'stayed on the plate')
  assert.notEqual(primeTowerReachIssue(rect(huge.x, huge.x + 300, huge.y, huge.y + 40), ZONES), null)
})

test('a single-nozzle machine publishes no such zones, so nothing is constrained', () => {
  // computeNozzleOnlyZones only emits for the two-extruder layout; the rule must be inert otherwise.
  assert.equal(primeTowerReachIssue(rect(0, 40, 0, 40), [zone(0, 30, null)]), null)
  assert.deepEqual(clampPrimeTowerIntoReach(rect(0, 40, 0, 40), BED, [zone(0, 30, null)]), { x: 0, y: 0 })
})
