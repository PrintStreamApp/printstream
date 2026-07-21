import assert from 'node:assert/strict'
import test from 'node:test'
import { arrangePlateItems, decodeFootprintCellKey, FOOTPRINT_CELL_MM, footprintCellKey, shiftFootprintCells } from './arrange'

/** Rasterize an axis-aligned rect (mm) into footprint cell keys. */
function rectCells(minX: number, minY: number, maxX: number, maxY: number): number[] {
  const cells: number[] = []
  for (let cx = Math.floor(minX / FOOTPRINT_CELL_MM); cx < Math.ceil(maxX / FOOTPRINT_CELL_MM); cx += 1) {
    for (let cy = Math.floor(minY / FOOTPRINT_CELL_MM); cy < Math.ceil(maxY / FOOTPRINT_CELL_MM); cy += 1) {
      cells.push(footprintCellKey(cx, cy))
    }
  }
  return cells
}

/** Translate a rect's cells by an arrange move and return the resulting mm bounds. */
function movedBounds(cells: number[], move: { dx: number; dy: number }) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const key of cells) {
    const [cx, cy] = decodeFootprintCellKey(key)
    minX = Math.min(minX, cx * FOOTPRINT_CELL_MM + move.dx)
    maxX = Math.max(maxX, (cx + 1) * FOOTPRINT_CELL_MM + move.dx)
    minY = Math.min(minY, cy * FOOTPRINT_CELL_MM + move.dy)
    maxY = Math.max(maxY, (cy + 1) * FOOTPRINT_CELL_MM + move.dy)
  }
  return { minX, maxX, minY, maxY }
}

const BED = { minX: 0, maxX: 100, minY: 0, maxY: 100 }

test('cell keys round-trip', () => {
  assert.deepEqual(decodeFootprintCellKey(footprintCellKey(5, -7)), [5, -7])
  assert.deepEqual(decodeFootprintCellKey(footprintCellKey(-100, 42)), [-100, 42])
})

test('arrange places every item on the plate without overlap and with spacing', () => {
  const a = rectCells(0, 0, 20, 20)
  const b = rectCells(200, 200, 220, 220) // starts off-plate entirely
  const result = arrangePlateItems(
    [{ key: 'a', cells: a }, { key: 'b', cells: b }],
    { bed: BED, spacingMm: 6 }
  )
  assert.equal(result.unplaced.length, 0)
  const boundsA = movedBounds(a, result.moves.get('a')!)
  const boundsB = movedBounds(b, result.moves.get('b')!)
  for (const bounds of [boundsA, boundsB]) {
    assert.ok(bounds.minX >= BED.minX && bounds.maxX <= BED.maxX, `x in plate: ${JSON.stringify(bounds)}`)
    assert.ok(bounds.minY >= BED.minY && bounds.maxY <= BED.maxY, `y in plate: ${JSON.stringify(bounds)}`)
  }
  // Separated by at least the clearance on one axis (no overlap).
  const gapX = Math.max(boundsA.minX - boundsB.maxX, boundsB.minX - boundsA.maxX)
  const gapY = Math.max(boundsA.minY - boundsB.maxY, boundsB.minY - boundsA.maxY)
  assert.ok(Math.max(gapX, gapY) >= 4, `items too close: gapX=${gapX} gapY=${gapY}`)
  // The first (largest-or-equal) item lands at the plate centre.
  assert.ok(Math.abs((boundsA.minX + boundsA.maxX) / 2 - 50) <= 4)
  assert.ok(Math.abs((boundsA.minY + boundsA.maxY) / 2 - 50) <= 4)
})

test('items that cannot fit are reported unplaced', () => {
  const huge = rectCells(0, 0, 120, 120)
  const result = arrangePlateItems([{ key: 'huge', cells: huge }], { bed: BED })
  assert.deepEqual(result.unplaced, ['huge'])
  assert.equal(result.moves.size, 0)
})

/** Final mm bounds of an item: moved if it was arranged, original otherwise. */
function finalBounds(cells: number[], result: { moves: Map<string, { dx: number; dy: number }> }, key: string) {
  return movedBounds(cells, result.moves.get(key) ?? { dx: 0, dy: 0 })
}

function rectsOverlap(a: ReturnType<typeof movedBounds>, b: ReturnType<typeof movedBounds>): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY
}

test('a partial arrange never leaves items overlapping', () => {
  // A fills the left side; B sits on the right with too little room to repack both
  // with clearance. The old packer ignored not-yet-placed items, so it moved A to
  // the plate centre and then left the unfittable B "in place" — overlapping A.
  const a = rectCells(0, 0, 60, 60)
  const b = rectCells(64, 0, 100, 60)
  const result = arrangePlateItems(
    [{ key: 'a', cells: a }, { key: 'b', cells: b }],
    { bed: BED, spacingMm: 6 }
  )
  const boundsA = finalBounds(a, result, 'a')
  const boundsB = finalBounds(b, result, 'b')
  assert.ok(!rectsOverlap(boundsA, boundsB), `items overlap: ${JSON.stringify({ boundsA, boundsB })}`)
})

test('blocked cells are never covered', () => {
  // Block the whole left half; a 40mm square must land entirely in the right half.
  const blocked = new Set(rectCells(0, 0, 50, 100))
  const square = rectCells(0, 0, 40, 40)
  const result = arrangePlateItems([{ key: 's', cells: square }], { bed: BED, blockedCells: blocked })
  assert.equal(result.unplaced.length, 0)
  const bounds = movedBounds(square, result.moves.get('s')!)
  assert.ok(bounds.minX >= 50, `expected right half, got ${JSON.stringify(bounds)}`)
})

test('shiftFootprintCells translates cells by whole cells, matching a re-rasterization of the moved shape', () => {
  // The placement-warning recompute relies on this: a pure move keeps the footprint SHAPE, so
  // shifting the cached cells must equal rasterizing the shape at the new position — the difference
  // between a smooth and a frozen drop for a many-part object.
  const shape = new Set(rectCells(10, 10, 30, 24))
  const dCellX = 15
  const dCellY = -8
  const shifted = shiftFootprintCells(shape, dCellX, dCellY)
  const expected = new Set(rectCells(
    10 + dCellX * FOOTPRINT_CELL_MM, 10 + dCellY * FOOTPRINT_CELL_MM,
    30 + dCellX * FOOTPRINT_CELL_MM, 24 + dCellY * FOOTPRINT_CELL_MM
  ))
  assert.deepEqual([...shifted].sort((a, b) => a - b), [...expected].sort((a, b) => a - b))
  // A zero delta returns the same set instance (no allocation on an idle poll tick).
  assert.equal(shiftFootprintCells(shape, 0, 0), shape)
})
