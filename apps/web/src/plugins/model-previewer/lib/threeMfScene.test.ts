import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import {
  BED_GRID_MAJOR_STEP_MM,
  BED_GRID_MINOR_STEP_MM,
  createBedGridLines
} from './threeMfScene'

/** Collect the unique line coordinates (x of vertical lines, y of horizontal) from a LineSegments. */
function lineCoordinates(segments: THREE.Object3D): { vertical: number[]; horizontal: number[] } {
  const position = (segments as THREE.LineSegments).geometry.getAttribute('position')
  const vertical = new Set<number>()
  const horizontal = new Set<number>()
  for (let i = 0; i < position.count; i += 2) {
    const x0 = position.getX(i)
    const y0 = position.getY(i)
    const x1 = position.getX(i + 1)
    if (x0 === x1) vertical.add(x0)
    else horizontal.add(y0)
  }
  return {
    vertical: [...vertical].sort((a, b) => a - b),
    horizontal: [...horizontal].sort((a, b) => a - b)
  }
}

test('bed grid draws true-millimetre lines on a 0-based 256mm bed', () => {
  const grid = createBedGridLines(0, 256, 0, 256)
  const [minor, major] = grid.children
  assert.ok(minor && major)

  const majors = lineCoordinates(major)
  // Major lines at every 50mm of absolute bed coordinates: 0..250.
  assert.deepEqual(majors.vertical, [0, 50, 100, 150, 200, 250])
  assert.deepEqual(majors.horizontal, [0, 50, 100, 150, 200, 250])

  const minors = lineCoordinates(minor)
  // Minor lines at the remaining 10mm steps (majors excluded).
  assert.equal(minors.vertical.length, 26 - 6)
  for (const x of minors.vertical) {
    assert.equal(Math.round(x) % BED_GRID_MINOR_STEP_MM, 0)
    assert.notEqual(Math.round(x) % BED_GRID_MAJOR_STEP_MM, 0)
  }
})

test('bed grid anchors to absolute coordinates on an offset bed', () => {
  // A bed spanning -100..100 (centre-origin style) still gets lines at absolute
  // multiples of the step, so labels/lines mean real machine millimetres.
  const grid = createBedGridLines(-100, 100, -100, 100)
  const [, major] = grid.children
  assert.ok(major)
  assert.deepEqual(lineCoordinates(major).vertical, [-100, -50, 0, 50, 100])
})
