import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createCircleCursor,
  createHeightRangeCursor,
  createSphereCursor,
  decodePaintTree,
  encodePaintTree,
  isPaintTreeEmpty,
  paintTreeWithBrush,
  splitChildTriangles,
  walkPaintTree,
  type PaintTreeNode,
  type PaintVec3
} from './trianglePaintTree'

const TRI: [PaintVec3, PaintVec3, PaintVec3] = [
  { x: 0, y: 0, z: 0 },
  { x: 100, y: 0, z: 0 },
  { x: 0, y: 100, z: 0 }
]

test('whole-triangle leaf codes match the Bambu nibble encoding', () => {
  assert.equal(encodePaintTree({ kind: 'leaf', state: 1 }), '4')
  assert.equal(encodePaintTree({ kind: 'leaf', state: 2 }), '8')
  assert.equal(encodePaintTree({ kind: 'leaf', state: 3 }), '0C')
  assert.equal(encodePaintTree({ kind: 'leaf', state: 4 }), '1C')
  assert.deepEqual(decodePaintTree('8'), { kind: 'leaf', state: 2 })
  assert.deepEqual(decodePaintTree('1C'), { kind: 'leaf', state: 4 })
})

test('split trees round-trip through encode/decode', () => {
  const tree: PaintTreeNode = {
    kind: 'split',
    splits: 3,
    special: 0,
    children: [
      { kind: 'leaf', state: 1 },
      { kind: 'leaf', state: 0 },
      { kind: 'split', splits: 1, special: 2, children: [{ kind: 'leaf', state: 2 }, { kind: 'leaf', state: 0 }] },
      { kind: 'leaf', state: 5 }
    ]
  }
  const code = encodePaintTree(tree)
  assert.deepEqual(decodePaintTree(code), tree)
})

test('split child layout bisects edges per perform_split', () => {
  // 3-way split of TRI: corner children + the centre triangle of midpoints.
  const children = splitChildTriangles(TRI, 3, 0)
  assert.equal(children.length, 4)
  assert.deepEqual(children[3], [
    { x: 50, y: 0, z: 0 },
    { x: 50, y: 50, z: 0 },
    { x: 0, y: 50, z: 0 }
  ])
  // 1-way split keeps two children sharing the bisected edge's midpoint.
  const halves = splitChildTriangles(TRI, 1, 0)
  assert.equal(halves.length, 2)
  assert.deepEqual(halves[0]![2], { x: 50, y: 50, z: 0 })
})

test('brush painting splits partially covered leaves and erasing collapses back', () => {
  const brush = createSphereCursor({ x: 2, y: 2, z: 0 }, 6, 1.2)
  const painted = paintTreeWithBrush({ kind: 'leaf', state: 0 }, TRI, brush, 1)
  assert.equal(painted.kind, 'split')
  // Painted leaves are concentrated near the brushed corner.
  let paintedArea = 0
  let totalLeaves = 0
  walkPaintTree(painted, TRI, (state, verts) => {
    totalLeaves += 1
    if (state === 1) {
      const area = Math.abs(
        (verts[1].x - verts[0].x) * (verts[2].y - verts[0].y) -
        (verts[2].x - verts[0].x) * (verts[1].y - verts[0].y)
      ) / 2
      paintedArea += area
    }
  })
  assert.ok(totalLeaves > 1)
  assert.ok(paintedArea > 0)
  assert.ok(paintedArea < 1000, `painted ${paintedArea}mm^2 of a 5000mm^2 triangle`)

  const erased = paintTreeWithBrush(painted, TRI, brush, 0)
  assert.equal(isPaintTreeEmpty(erased), true)
  assert.deepEqual(erased, { kind: 'leaf', state: 0 })
})

test('circle cursor is an infinite cylinder around the pointer ray', () => {
  const circle = createCircleCursor({ x: 2, y: 2, z: 0 }, { x: 0, y: 0, z: -1 }, 6, 1.2)
  // Distance from the axis ignores z entirely.
  assert.equal(circle.containsPoint({ x: 3, y: 3, z: 50 }), true)
  assert.equal(circle.containsPoint({ x: 20, y: 2, z: 0 }), false)
  // Painting TRI near the corner behaves like the sphere brush footprint.
  const painted = paintTreeWithBrush({ kind: 'leaf', state: 0 }, TRI, circle, 1)
  assert.equal(painted.kind, 'split')
  let paintedArea = 0
  walkPaintTree(painted, TRI, (state, verts) => {
    if (state !== 1) return
    paintedArea += Math.abs(
      (verts[1].x - verts[0].x) * (verts[2].y - verts[0].y) -
      (verts[2].x - verts[0].x) * (verts[1].y - verts[0].y)
    ) / 2
  })
  assert.ok(paintedArea > 0)
  assert.ok(paintedArea < 1000, `painted ${paintedArea}mm^2 of a 5000mm^2 triangle`)
})

test('height-range cursor paints a crisp z band', () => {
  // Vertical right triangle in the xz plane: legs 10mm along x and z.
  const wall: [PaintVec3, PaintVec3, PaintVec3] = [
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 0, y: 0, z: 10 }
  ]
  const slab = createHeightRangeCursor((p) => p.z, 2, 3, 0.1)
  const painted = paintTreeWithBrush({ kind: 'leaf', state: 0 }, wall, slab, 2)
  assert.equal(painted.kind, 'split')
  let bandArea = 0
  let outsideArea = 0
  walkPaintTree(painted, wall, (state, verts) => {
    const area = Math.abs(
      (verts[1].x - verts[0].x) * (verts[2].z - verts[0].z) -
      (verts[2].x - verts[0].x) * (verts[1].z - verts[0].z)
    ) / 2
    const zMid = (verts[0].z + verts[1].z + verts[2].z) / 3
    if (state === 2) bandArea += area
    else if (zMid > 3.2 || zMid < 1.8) outsideArea += area
  })
  // The band's exact area on this triangle is 7.5mm^2 (trapezoid between z=2 and z=3).
  assert.ok(Math.abs(bandArea - 7.5) < 1, `band area ${bandArea}`)
  // Nothing clearly outside the band may be painted.
  walkPaintTree(painted, wall, (state, verts) => {
    const zMin = Math.min(verts[0].z, verts[1].z, verts[2].z)
    const zMax = Math.max(verts[0].z, verts[1].z, verts[2].z)
    if (state === 2) assert.ok(zMax > 1.8 && zMin < 3.2, `painted leaf outside band z=[${zMin},${zMax}]`)
  })
  assert.ok(outsideArea > 0)
})
