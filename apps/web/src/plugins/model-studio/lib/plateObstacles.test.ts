import assert from 'node:assert/strict'
import test from 'node:test'
import { computePlateObstacles } from './plateObstacles'
import { decodeFootprintCellKey, FOOTPRINT_CELL_MM } from './arrange'

const BED = { minX: -100, maxX: 100, minY: -100, maxY: 100 }

/** Rasterize an axis-aligned rect (mm) the way the editor's polygon rasterizer would. */
function rasterizeRect(polygon: ReadonlyArray<{ x: number; y: number }>): Set<number> {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const point of polygon) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x)
    minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y)
  }
  const cells = new Set<number>()
  for (let cx = Math.floor(minX / FOOTPRINT_CELL_MM); cx < Math.ceil(maxX / FOOTPRINT_CELL_MM); cx += 1) {
    for (let cy = Math.floor(minY / FOOTPRINT_CELL_MM); cy < Math.ceil(maxY / FOOTPRINT_CELL_MM); cy += 1) {
      cells.add((cx + 16384) * 32768 + (cy + 16384))
    }
  }
  return cells
}

function rect(minX: number, minY: number, maxX: number, maxY: number) {
  return [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }]
}

const base = { bed: BED, rasterizePolygon: rasterizeRect, primeTower: null }

test('with no zones and no tower the whole bed is usable', () => {
  const obstacles = computePlateObstacles({ ...base, zones: [], nozzleDemands: [new Set([0, 1])] })
  assert.deepEqual(obstacles.safeArea, BED)
  assert.equal(obstacles.blockedCells.size, 0)
})

test('a nozzle-only zone shrinks the rect only for objects needing the OTHER nozzle', () => {
  // Runtime nozzle ids: 0 = right, 1 = left. A right-only strip on the far right bounds how far
  // right a LEFT-nozzle object may go; a right-nozzle object is unaffected by it.
  const zones = [{ polygon: rect(60, -100, 100, 100), requiredNozzle: 0 }]

  const leftOnly = computePlateObstacles({ ...base, zones, nozzleDemands: [new Set([1])] })
  assert.equal(leftOnly.safeArea.maxX, 60, 'a left-nozzle object may not enter the right-only strip')
  assert.equal(leftOnly.safeArea.minX, BED.minX, 'its left edge is untouched')

  const rightOnly = computePlateObstacles({ ...base, zones, nozzleDemands: [new Set([0])] })
  assert.deepEqual(rightOnly.safeArea, BED, 'a right-nozzle object can use the whole bed')

  // A zone never becomes blocked CELLS: that would cost the whole strip for everyone.
  assert.equal(leftOnly.blockedCells.size, 0)
})

test('the tightest demand wins when several objects are being placed', () => {
  const zones = [
    { polygon: rect(60, -100, 100, 100), requiredNozzle: 0 },
    { polygon: rect(-100, -100, -60, 100), requiredNozzle: 1 }
  ]
  const obstacles = computePlateObstacles({
    ...base,
    zones,
    nozzleDemands: [new Set([1]), new Set([0])]
  })
  assert.equal(obstacles.safeArea.maxX, 60)
  assert.equal(obstacles.safeArea.minX, -60)
})

test('an unprintable zone is blocked cell-by-cell rather than costing an edge strip', () => {
  // The corner cutout every X1/P1 has. It must not shrink the rect, or the whole edge is lost.
  const zones = [{ polygon: rect(-100, -100, -82, -72), requiredNozzle: null }]
  const obstacles = computePlateObstacles({ ...base, zones, nozzleDemands: [new Set([0, 1])] })
  assert.deepEqual(obstacles.safeArea, BED, 'an unprintable zone must not shrink the usable rect')
  assert.ok(obstacles.blockedCells.size > 0, 'it is blocked as cells instead')
  for (const key of obstacles.blockedCells) {
    const [cx, cy] = decodeFootprintCellKey(key)
    assert.ok(cx * FOOTPRINT_CELL_MM < -72 && cy * FOOTPRINT_CELL_MM < -72, 'blocked cells stay in the cutout')
  }
})

test('the prime tower blocks its live footprint', () => {
  const obstacles = computePlateObstacles({
    ...base,
    zones: [],
    nozzleDemands: [],
    primeTower: { centerX: 0, centerY: 0, width: 40, depth: 20 }
  })
  assert.ok(obstacles.blockedCells.size > 0)
  for (const key of obstacles.blockedCells) {
    const [cx, cy] = decodeFootprintCellKey(key)
    assert.ok(Math.abs(cx * FOOTPRINT_CELL_MM) <= 20, 'tower cells stay within its width')
    assert.ok(Math.abs(cy * FOOTPRINT_CELL_MM) <= 10, 'tower cells stay within its depth')
  }
})

test('a zero-sized prime tower blocks nothing', () => {
  // A plate with the tower disabled reports no size; blocking a degenerate rect would still
  // stamp a cell at the origin and quietly cost the middle of the plate.
  const obstacles = computePlateObstacles({
    ...base,
    zones: [],
    nozzleDemands: [],
    primeTower: { centerX: 0, centerY: 0, width: 0, depth: 0 }
  })
  assert.equal(obstacles.blockedCells.size, 0)
})
