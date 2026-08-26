import assert from 'node:assert/strict'
import test from 'node:test'
import { arrangePlateItems, decodeFootprintCellKey, FOOTPRINT_CELL_MM, footprintCellKey, planFillBedCopies, shiftFootprintCells } from './arrange'

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
  // the plate centre and then left the unfittable B "in place": overlapping A.
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
  // shifting the cached cells must equal rasterizing the shape at the new position: the difference
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

// --- Fill bed with copies -------------------------------------------------------------------

/** Absolute mm bounds of a copy placed at `offset` from the template's current cells. */
function copyBounds(templateCells: number[], offset: { dx: number; dy: number }) {
  return movedBounds(templateCells, offset)
}

test('fill bed packs copies into the free space without touching what is already placed', () => {
  // A 20mm square parked in the bottom-left corner, filling the rest of a 100mm plate.
  const template = rectCells(0, 0, 20, 20)
  const offsets = planFillBedCopies({
    bed: BED,
    spacingMm: 6,
    templateFootprint: template,
    occupiedFootprints: [template]
  })

  assert.ok(offsets.length >= 4, `expected several copies, got ${offsets.length}`)
  const placed = offsets.map((offset) => copyBounds(template, offset))
  const original = copyBounds(template, { dx: 0, dy: 0 })

  for (const bounds of placed) {
    assert.ok(bounds.minX >= BED.minX && bounds.maxX <= BED.maxX, `copy off plate in x: ${JSON.stringify(bounds)}`)
    assert.ok(bounds.minY >= BED.minY && bounds.maxY <= BED.maxY, `copy off plate in y: ${JSON.stringify(bounds)}`)
    // The template instance holds its ground, so no copy may land on it.
    assert.ok(!rectsOverlap(bounds, original), `copy lands on the template: ${JSON.stringify(bounds)}`)
  }
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      assert.ok(!rectsOverlap(placed[i]!, placed[j]!), `copies ${i}/${j} overlap`)
    }
  }
})

test('fill bed keeps clear of other objects and blocked cells', () => {
  // Another object occupies the top strip and the left half is blocked outright, so every copy
  // must land in the bottom-right quadrant.
  const template = rectCells(0, 0, 20, 20)
  const neighbour = rectCells(0, 70, 100, 100)
  const blocked = new Set(rectCells(0, 0, 50, 100))
  const offsets = planFillBedCopies({
    bed: BED,
    spacingMm: 6,
    templateFootprint: template,
    occupiedFootprints: [template, neighbour],
    blockedCells: blocked
  })

  assert.ok(offsets.length > 0, 'expected at least one copy to fit')
  const neighbourBounds = copyBounds(neighbour, { dx: 0, dy: 0 })
  for (const offset of offsets) {
    const bounds = copyBounds(template, offset)
    assert.ok(bounds.minX >= 50, `copy entered the blocked half: ${JSON.stringify(bounds)}`)
    assert.ok(!rectsOverlap(bounds, neighbourBounds), `copy lands on the neighbour: ${JSON.stringify(bounds)}`)
  }
})

test('fill bed reports nothing when the plate is already full', () => {
  const template = rectCells(0, 0, 90, 90)
  const offsets = planFillBedCopies({
    bed: BED,
    spacingMm: 6,
    templateFootprint: template,
    occupiedFootprints: [template]
  })
  assert.deepEqual(offsets, [], 'a plate with no room left must yield no copies')
})

test('fill bed offsets are relative to wherever the template currently stands', () => {
  // Same geometry, two different starting positions: the ABSOLUTE placements must match, which is
  // what lets the caller apply an offset to the template's position without knowing the grid.
  const atOrigin = rectCells(0, 0, 20, 20)
  const shifted = rectCells(40, 60, 60, 80)
  const fromOrigin = planFillBedCopies({
    bed: BED, spacingMm: 6, templateFootprint: atOrigin, occupiedFootprints: []
  })
  const fromShifted = planFillBedCopies({
    bed: BED, spacingMm: 6, templateFootprint: shifted, occupiedFootprints: []
  })
  assert.equal(fromOrigin.length, fromShifted.length)
  for (let i = 0; i < fromOrigin.length; i += 1) {
    const a = copyBounds(atOrigin, fromOrigin[i]!)
    const b = copyBounds(shifted, fromShifted[i]!)
    assert.deepEqual(a, b, `copy ${i} landed in a different absolute spot`)
  }
})

test('fill bed honours the copy cap', () => {
  const template = rectCells(0, 0, 10, 10)
  const offsets = planFillBedCopies({
    bed: BED, spacingMm: 2, templateFootprint: template, occupiedFootprints: [], maxCopies: 3
  })
  assert.equal(offsets.length, 3)
})
