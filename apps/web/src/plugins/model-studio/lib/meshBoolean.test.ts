/**
 * Mesh booleans, checked by VOLUME rather than by triangle count.
 *
 * A boolean can produce a plausible-looking mesh that is wrong, so counting triangles proves
 * nothing. Two overlapping cubes of known size have an arithmetically known union, difference and
 * intersection, and signed volume measures whether the result is that solid AND whether it came back
 * closed and wound outward.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { toObjectLocalSoup } from './meshBooleanCore'
import {
  EMPTY_MESH_BOOLEAN_LISTS,
  MESH_BOOLEAN_WARNINGS,
  assignMeshBooleanList,
  evaluateMeshBoolean,
  isClosedSoup,
  meshBooleanOperandParticipates,
  meshBooleanPartOperandKey,
  meshBooleanTargetMode,
  parseMeshBooleanPartOperand,
  planMeshBooleanConsumption,
  pruneMeshBooleanLists,
  seedMeshBooleanLists,
  validateMeshBoolean
} from './meshBoolean'

/** An axis-aligned box as a closed triangle soup. */
function boxSoup(min: [number, number, number], max: [number, number, number]): Float32Array {
  const [x0, y0, z0] = min
  const [x1, y1, z1] = max
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]
  ]
  // Wound outward, which the closed-surface and volume checks both depend on.
  const faces = [
    [0, 3, 2], [0, 2, 1], // bottom (-Z)
    [4, 5, 6], [4, 6, 7], // top (+Z)
    [0, 1, 5], [0, 5, 4], // -Y
    [2, 3, 7], [2, 7, 6], // +Y
    [1, 2, 6], [1, 6, 5], // +X
    [3, 0, 4], [3, 4, 7]  // -X
  ]
  const soup = new Float32Array(faces.length * 9)
  faces.forEach((face, f) => {
    face.forEach((index, corner) => {
      soup.set(v[index]!, f * 9 + corner * 3)
    })
  })
  return soup
}

function volumeOf(soup: Float32Array): number {
  let volume = 0
  for (let i = 0; i < soup.length; i += 9) {
    const ax = soup[i]!, ay = soup[i + 1]!, az = soup[i + 2]!
    const bx = soup[i + 3]!, by = soup[i + 4]!, bz = soup[i + 5]!
    const cx = soup[i + 6]!, cy = soup[i + 7]!, cz = soup[i + 8]!
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6
  }
  return volume
}

// Two 10mm cubes overlapping in a 5x10x10 slab: overlap 500, each 1000.
const CUBE_A = boxSoup([0, 0, 0], [10, 10, 10])
const CUBE_B = boxSoup([5, 0, 0], [15, 10, 10])

test('the test fixture itself is a closed, outward-wound solid', () => {
  // The instrument before the measurement: if the box were open or inside-out every assertion below
  // would be measuring the fixture's bug rather than the boolean's behaviour.
  assert.equal(isClosedSoup(CUBE_A), true)
  assert.ok(Math.abs(volumeOf(CUBE_A) - 1000) < 1e-6, `fixture volume ${volumeOf(CUBE_A)}`)
})

test('union is the two solids minus their double-counted overlap', async () => {
  const soup = await evaluateMeshBoolean('union', [CUBE_A, CUBE_B])
  // 1000 + 1000 - 500 overlap.
  assert.ok(Math.abs(volumeOf(soup) - 1500) < 1, `union volume ${volumeOf(soup).toFixed(1)}`)
})

test('intersection is only the overlap', async () => {
  const soup = await evaluateMeshBoolean('intersection', [CUBE_A, CUBE_B])
  assert.ok(Math.abs(volumeOf(soup) - 500) < 1, `intersection volume ${volumeOf(soup).toFixed(1)}`)
})

test('difference is A minus B, and is NOT symmetric', async () => {
  // The one operation where order is a real choice, which is why Studio keeps two lists rather than
  // one. A-minus-B leaves 500; B-minus-A leaves the other 500, and a commutative implementation
  // would return the same solid for both.
  const aMinusB = await evaluateMeshBoolean('difference', [CUBE_A], [CUBE_B])
  assert.ok(Math.abs(volumeOf(aMinusB) - 500) < 1, `A-B volume ${volumeOf(aMinusB).toFixed(1)}`)

  // The remaining half sits at the far end of A, so its centroid is on the low-x side.
  let cx = 0
  for (let i = 0; i < aMinusB.length; i += 3) cx += aMinusB[i]!
  cx /= aMinusB.length / 3
  assert.ok(cx < 5, `A-B should keep A's low-x half, centroid x ${cx.toFixed(2)}`)
})

test('difference subtracts the WHOLE of B, not one operand at a time', async () => {
  // Each side is unioned before subtracting, so the answer cannot depend on the order things were
  // added to the B list. Two halves of A, subtracted together, remove all of it.
  const left = boxSoup([0, 0, 0], [5, 10, 10])
  const right = boxSoup([5, 0, 0], [10, 10, 10])
  const soup = await evaluateMeshBoolean('difference', [CUBE_A], [left, right])
  assert.ok(Math.abs(volumeOf(soup)) < 1, `nothing should remain, got ${volumeOf(soup).toFixed(1)}`)
})

test('shapes that do not touch have an empty intersection, which is an answer', async () => {
  // Not a failure: the caller must be able to tell "they do not overlap" from "the engine broke",
  // and silently treating this as an error would hide a legitimate result.
  const far = boxSoup([100, 100, 100], [110, 110, 110])
  assert.ok(Math.abs(volumeOf(await evaluateMeshBoolean('intersection', [CUBE_A, far]))) < 1)
})

test('an open shell is rejected before it can be booleaned', () => {
  // THE gate. CSG asks "is this point inside?", which an open mesh cannot answer, so it returns
  // plausible geometry that slices into nonsense rather than failing. One face removed is enough.
  const open = CUBE_A.slice(0, CUBE_A.length - 9)
  assert.equal(isClosedSoup(open), false)
  assert.equal(isClosedSoup(CUBE_A), true)
})

test('an over-shared edge is not an open mesh, so a dense real model is not refused', () => {
  // The regression: the gate tested "every edge shared by EXACTLY two triangles", which a real
  // 663k-triangle model fails -- not because it has a hole, but because quantising the positions
  // merges distinct-but-close vertices and fuses separate edges. Measured on that model: 220
  // over-shared edges, zero boundaries. Two boxes meeting on an exact shared face reproduce the
  // shape of it (the shared edges land in four triangles) while staying a closed volume.
  const left = boxSoup([0, 0, 0], [10, 10, 10])
  const right = boxSoup([10, 0, 0], [20, 10, 10])
  const joined = new Float32Array(left.length + right.length)
  joined.set(left); joined.set(right, left.length)

  // The shape of the artifact: edges shared by more than two triangles, and no boundary edge.
  const key = (i: number) => `${Math.round(joined[i]! * 1e4)},${Math.round(joined[i+1]! * 1e4)},${Math.round(joined[i+2]! * 1e4)}`
  const edges = new Map<string, number>()
  for (let i = 0; i < joined.length; i += 9) {
    const [a, b, c] = [key(i), key(i + 3), key(i + 6)]
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const e = p! < q! ? `${p}|${q}` : `${q}|${p}`
      edges.set(e, (edges.get(e) ?? 0) + 1)
    }
  }
  const counts = [...edges.values()]
  assert.ok(counts.some((n) => n > 2), 'fixture does not reproduce an over-shared edge')
  assert.ok(counts.every((n) => n >= 2), 'fixture must have no boundary edge, or it proves nothing')

  assert.equal(isClosedSoup(joined), true, 'an over-shared edge still encloses a volume')
  // And the thing the gate exists for still fails: one face removed leaves real boundary edges.
  assert.equal(isClosedSoup(joined.slice(0, joined.length - 9)), false)
})

test('a mesh written more than once over is judged on the surface underneath', () => {
  // What a plain edge count could NOT catch: doubling every facet doubles every edge count, so an
  // OPEN shell reaches two-per-edge and reads as closed under a "no edge used once" rule. The check
  // divides out the cover multiplicity, so any whole number of copies gives the same answer as one.
  const cover = (soup: Float32Array, times: number) => {
    const out = new Float32Array(soup.length * times)
    for (let i = 0; i < times; i++) out.set(soup, soup.length * i)
    return out
  }
  const openShell = CUBE_A.slice(0, CUBE_A.length - 9)
  for (const times of [2, 3]) {
    assert.equal(isClosedSoup(cover(openShell, times)), false, `an open shell covered ${times}x is still open`)
    assert.equal(isClosedSoup(cover(CUBE_A, times)), true, `a closed solid covered ${times}x is still closed`)
  }
})

test('a coincident flap on a closed solid is covered surface, not a hole', () => {
  // The case that made "collapse every duplicate to one copy" wrong, taken from a real 663k-triangle
  // model: a zero-thickness pair of triangles hanging off the mesh. Its free rim is used exactly
  // twice, by its own two copies, which is edge-for-edge identical to a doubled shell's boundary --
  // so a rule that flattens duplicates opens the rim and refuses a model that slices perfectly.
  const flap = Float32Array.from([20, 0, 0, 30, 0, 0, 20, 10, 0])
  const withFlap = new Float32Array(CUBE_A.length + flap.length * 2)
  withFlap.set(CUBE_A)
  withFlap.set(flap, CUBE_A.length)
  withFlap.set(flap, CUBE_A.length + flap.length)
  assert.equal(isClosedSoup(withFlap), true)
  // And the flap does not smuggle a real hole past the gate.
  const holedWithFlap = new Float32Array(withFlap)
  holedWithFlap.set(withFlap.subarray(9), 0)
  assert.equal(isClosedSoup(holedWithFlap.subarray(0, holedWithFlap.length - 9)), false)
})

test('a genuine crack is reported as open rather than tolerated', () => {
  // The gate is exact on purpose, so this is the honest answer rather than a limitation: viewport
  // geometry arrives already welded (`meshParseCore` runs `mergeVertices`), so a gap that survives
  // that is a real defect, and CSG has nothing to say about a surface with a boundary. The editor's
  // own "Repair mesh" is the fix, which is why the refusal names the operand.
  const cracked = Float32Array.from(CUBE_A)
  for (let i = 0; i < cracked.length; i += 3) {
    if (cracked[i] === 10) cracked[i] = 10 + (i % 2 === 0 ? 1e-6 : -1e-6)
  }
  assert.equal(isClosedSoup(cracked), false)
  assert.equal(isClosedSoup(CUBE_A), true, 'and the same solid without the crack still passes')
})

test('validation matches Studio, and words itself for objects or volumes', () => {
  // Same rules and same strings, so our message and Studio's documentation agree.
  assert.equal(validateMeshBoolean('union', 'object', { working: 1, listA: 0, listB: 0 }),
    MESH_BOOLEAN_WARNINGS.minObjectsUnion)
  assert.equal(validateMeshBoolean('union', 'part', { working: 1, listA: 0, listB: 0 }),
    MESH_BOOLEAN_WARNINGS.minVolumesUnion)
  assert.equal(validateMeshBoolean('union', 'object', { working: 2, listA: 0, listB: 0 }), null)

  assert.equal(validateMeshBoolean('intersection', 'part', { working: 1, listA: 0, listB: 0 }),
    MESH_BOOLEAN_WARNINGS.minVolumesIntersection)

  // Difference reads its own lists, never the working one: two things on the A side is still not a
  // difference, because there is nothing to subtract.
  assert.equal(validateMeshBoolean('difference', 'part', { working: 5, listA: 2, listB: 0 }),
    MESH_BOOLEAN_WARNINGS.minVolumesDifference)
  assert.equal(validateMeshBoolean('difference', 'part', { working: 0, listA: 1, listB: 1 }), null)
})

test('the lists seed as Studio does: first operand minus the rest', () => {
  // `init_object_mode_lists` puts the FIRST selected object in A and every other in B, so a
  // difference reads as "what I picked first, minus the rest" with no further clicks.
  const lists = seedMeshBooleanLists(['obj-a', 'obj-b', 'obj-c'])
  assert.deepEqual(lists.a, ['obj-a'])
  assert.deepEqual(lists.b, ['obj-b', 'obj-c'])
  assert.deepEqual(lists.working, ['obj-a', 'obj-b', 'obj-c'], 'union and intersection read all of them')
})

test('A and B are exclusive, because an operand cannot be both sides of a minus', () => {
  const seeded = seedMeshBooleanLists(['obj-a', 'obj-b'])
  const moved = assignMeshBooleanList(seeded, 'obj-b', 'a')
  assert.deepEqual(moved.a, ['obj-a', 'obj-b'])
  assert.deepEqual(moved.b, [], 'the operand stayed on the far side of the subtraction too')
  // The working list does not partition, so it is untouched.
  assert.deepEqual(moved.working, ['obj-a', 'obj-b'])
})

test('a selection change prunes stale operands and adopts new ones', () => {
  // The selection can move while the panel is open (a Ctrl-click, an undo). A list naming an
  // operand that is gone would hand the evaluator geometry the user cannot see, and a newly
  // selected one that never reached the working list would be silently left out of a union.
  const lists = assignMeshBooleanList(seedMeshBooleanLists(['a', 'b', 'c']), 'c', 'a')
  const pruned = pruneMeshBooleanLists(lists, ['b', 'c', 'd'])
  assert.deepEqual(pruned.a, ['c'], 'a dropped operand survived in the A list')
  assert.deepEqual(pruned.working, ['b', 'c', 'd'], 'a newly selected operand never joined the working list')
  assert.deepEqual(pruned.b, ['b', 'd'], 'the operand the user moved to A stayed there; only the new one joined B')
})

test('an adopted operand reaches a DIFFERENCE list, not just the working one', () => {
  // The difference panel renders A and B only, so an operand that joined `working` alone is
  // invisible there: unassignable, and silently left out of the operation on screen. It joins B,
  // which is where the seed puts everything after the first, so Ctrl-clicking another shape
  // subtracts it -- the same answer as having picked it before opening the tool.
  const seeded = seedMeshBooleanLists(['a', 'b'])
  const grown = pruneMeshBooleanLists(seeded, ['a', 'b', 'c'])
  assert.deepEqual(grown.a, ['a'])
  assert.deepEqual(grown.b, ['b', 'c'])
  assert.deepEqual(grown.working, ['a', 'b', 'c'])
  // And it must not be adopted twice: pruning again with the same selection is a no-op.
  assert.deepEqual(pruneMeshBooleanLists(grown, ['a', 'b', 'c']), grown)
})

test('the empty lists are one shared value, so an un-seeded panel does not churn its props', () => {
  // `EditorView` renders the panel from `lists ?? EMPTY_MESH_BOOLEAN_LISTS` while the tool is
  // opening. A `{working: [], a: [], b: []}` literal there would be a new object every render.
  assert.deepEqual(EMPTY_MESH_BOOLEAN_LISTS, { working: [], a: [], b: [] })
  assert.equal(validateMeshBoolean('union', 'object', {
    working: EMPTY_MESH_BOOLEAN_LISTS.working.length,
    listA: EMPTY_MESH_BOOLEAN_LISTS.a.length,
    listB: EMPTY_MESH_BOOLEAN_LISTS.b.length
  }), MESH_BOOLEAN_WARNINGS.minObjectsUnion, 'an un-seeded panel reads as "not enough operands"')
})

test('difference consumes A even under "keep the originals", as Studio does', () => {
  // `GLGizmoMeshBoolean.cpp:2899` "Difference: Always delete A group objects". A has BECOME the
  // result, so keeping it would leave the carved-away shape sitting inside its own remainder; the
  // toggle protects B, which the operation only read.
  const lists = { working: ['a', 'b'], a: ['a'], b: ['b'] }
  const kept = planMeshBooleanConsumption('difference', lists, { keepOriginals: true, solidPartsOnly: true })
  assert.deepEqual(kept.consumed, ['a'], 'A goes whatever the checkbox says')
  const consumedBoth = planMeshBooleanConsumption('difference', lists, { keepOriginals: false, solidPartsOnly: true })
  assert.deepEqual(consumedBoth.consumed, ['a', 'b'])
})

test('union and intersection consume everything or nothing', () => {
  const lists = { working: ['a', 'b', 'c'], a: ['a'], b: ['b', 'c'] }
  for (const operation of ['union', 'intersection'] as const) {
    assert.deepEqual(
      planMeshBooleanConsumption(operation, lists, { keepOriginals: false, solidPartsOnly: true }).consumed,
      ['a', 'b', 'c'], `${operation} takes the working list, not the A/B split`)
    assert.deepEqual(
      planMeshBooleanConsumption(operation, lists, { keepOriginals: true, solidPartsOnly: true }).consumed,
      [], `${operation} takes nothing when the originals are kept`)
  }
})

test('a helper volume travels only when its object is consumed', () => {
  // Carrying a copy onto the result while the source survives would duplicate every blocker in the
  // project -- the source keeps its own, which is what Studio's collection gate means.
  const lists = { working: ['a', 'b'], a: ['a'], b: ['b'] }
  const kept = planMeshBooleanConsumption('union', lists, { keepOriginals: true, solidPartsOnly: true })
  assert.deepEqual(kept.carried, [])
  assert.deepEqual(kept.dropped, [])
  const consumed = planMeshBooleanConsumption('union', lists, { keepOriginals: false, solidPartsOnly: true })
  assert.deepEqual(consumed.carried, ['a', 'b'])
})

test("difference carries A's helper volumes and reports B's as lost", () => {
  // `:2211` "Skip B group volumes in Object mode (they're never attached to result)" -- right,
  // since they marked a region of the solid that is now a hole. Studio deletes them silently; we
  // report them, which is the whole reason `dropped` is separate from `consumed`.
  const lists = { working: ['a', 'b'], a: ['a'], b: ['b'] }
  const plan = planMeshBooleanConsumption('difference', lists, { keepOriginals: false, solidPartsOnly: true })
  assert.deepEqual(plan.carried, ['a'])
  assert.deepEqual(plan.dropped, ['b'], 'B is consumed, so its volumes go with it and must be reported')
  // With B kept, nothing of B's is lost: the volumes stay on the object that still holds them.
  const keptB = planMeshBooleanConsumption('difference', lists, { keepOriginals: true, solidPartsOnly: true })
  assert.deepEqual(keptB.carried, ['a'])
  assert.deepEqual(keptB.dropped, [], 'B survives, so nothing of its was lost to report')
})

test('with the solid-parts toggle off, nothing is carried or dropped', () => {
  // The helper geometry took part in the boolean, so it is already IN the result. Carrying a copy
  // as well would leave a blocker sitting over a shape that has already been cut by it.
  const lists = { working: ['a', 'b'], a: ['a'], b: ['b'] }
  for (const operation of ['union', 'intersection', 'difference'] as const) {
    for (const keepOriginals of [true, false]) {
      const plan = planMeshBooleanConsumption(operation, lists, { keepOriginals, solidPartsOnly: false })
      assert.deepEqual(plan.carried, [], `${operation}/${keepOriginals} carried something`)
      assert.deepEqual(plan.dropped, [], `${operation}/${keepOriginals} reported a loss that did not happen`)
    }
  }
  // Consumption is unaffected: which objects survive does not depend on how their volumes were read.
  assert.deepEqual(
    planMeshBooleanConsumption('difference', lists, { keepOriginals: false, solidPartsOnly: false }).consumed,
    ['a', 'b'])
})

test('a part operand round-trips whichever kind of part it names', () => {
  // The three address spaces meet HERE and nowhere else: the lists, the panel and the evaluator all
  // see one opaque string, which is what keeps a baked part, a session-added volume and the object's
  // own body the same thing to everything downstream.
  const baked = { kind: 'baked', partIndex: 7 } as const
  const added = { kind: 'added', key: 'inst-42' } as const
  const body = { kind: 'body' } as const
  assert.deepEqual(parseMeshBooleanPartOperand(meshBooleanPartOperandKey(baked)), baked)
  assert.deepEqual(parseMeshBooleanPartOperand(meshBooleanPartOperandKey(added)), added)
  assert.deepEqual(parseMeshBooleanPartOperand(meshBooleanPartOperandKey(body)), body)
  // An OBJECT-mode operand is a bare instance key and must not decode as a part.
  assert.equal(parseMeshBooleanPartOperand('instance-3'), null)
})

test("the body key cannot be forged by a part that happens to be called 'body'", () => {
  // Why the body's key carries no separator: an added part's key is arbitrary data, so any prefixed
  // form (`body:`) would be reachable from a part key, and a forged body operand would send the
  // apply down the REPLACE-the-object's-geometry path for a volume that is not the body.
  const impostor = { kind: 'added', key: 'body' } as const
  assert.equal(meshBooleanPartOperandKey(impostor), 'added:body')
  assert.deepEqual(parseMeshBooleanPartOperand('added:body'), impostor)
  assert.deepEqual(parseMeshBooleanPartOperand('body'), { kind: 'body' })
})

test('a boolean that consumes the body reports it, so the result can replace the geometry', () => {
  // The apply branches on this: an object whose body was consumed must take the result AS its
  // geometry, because leaving it as an added volume would produce an object with no geometry of its
  // own, which nothing downstream can render, bake or slice.
  //
  // Which side the body is on decides whether the toggle can save it, and Studio's difference rule
  // makes the two genuinely different. A is ALWAYS consumed, keep-the-originals or not, because A
  // has BECOME the result -- so a body carved into is always replaced by what it became. A body in
  // B was only READ, so the toggle protects it and the result arrives as an added volume beside it.
  const bodyKey = meshBooleanPartOperandKey({ kind: 'body' })
  const volume = meshBooleanPartOperandKey({ kind: 'added', key: 'cut-1' })
  const carvedInto = { working: [bodyKey, volume], a: [bodyKey], b: [volume] }
  const carvedAway = { working: [volume, bodyKey], a: [volume], b: [bodyKey] }
  const consumesBody = (lists: typeof carvedInto, keepOriginals: boolean) =>
    planMeshBooleanConsumption('difference', lists, { keepOriginals, solidPartsOnly: true })
      .consumed.includes(bodyKey)

  assert.equal(consumesBody(carvedInto, false), true)
  assert.equal(consumesBody(carvedInto, true), true, 'difference always consumes A, body included')
  assert.equal(consumesBody(carvedAway, false), true)
  assert.equal(consumesBody(carvedAway, true), false, 'the toggle protects a body that was only read')

  // A union consumes the whole working list, so the body goes with it unless originals are kept.
  const union = { working: [bodyKey, volume], a: [], b: [] }
  assert.equal(
    planMeshBooleanConsumption('union', union, { keepOriginals: false, solidPartsOnly: true })
      .consumed.includes(bodyKey), true)
  assert.equal(
    planMeshBooleanConsumption('union', union, { keepOriginals: true, solidPartsOnly: true })
      .consumed.includes(bodyKey), false)
})

test("an added part's key may contain a colon and still round-trips", () => {
  // Split-on-colon would truncate the id, and a truncated id matches no volume: the operand would
  // silently contribute nothing rather than failing, which is the worst way for this to break.
  const awkward = { kind: 'added', key: 'text:2026:a' } as const
  assert.deepEqual(parseMeshBooleanPartOperand(meshBooleanPartOperandKey(awkward)), awkward)
  assert.equal(parseMeshBooleanPartOperand('added:'), null, 'an empty key names nothing')
})

test('the target mode follows the selection the way Studio picks its own', () => {
  // `update_cur_mode`: several whole objects boolean as objects, otherwise the volumes inside one.
  assert.equal(meshBooleanTargetMode({ objects: 2, partsInOneObject: 0 }), 'object')
  assert.equal(meshBooleanTargetMode({ objects: 3, partsInOneObject: 9 }), 'object',
    'a multi-object selection is an object boolean even when those objects have parts')
  assert.equal(meshBooleanTargetMode({ objects: 1, partsInOneObject: 2 }), 'part')
  // One object with one part is neither: it stays in object mode, where the count warning explains
  // itself in terms of the models the user can see rather than volumes they cannot.
  assert.equal(meshBooleanTargetMode({ objects: 1, partsInOneObject: 1 }), 'object')
  assert.equal(meshBooleanTargetMode({ objects: 0, partsInOneObject: 0 }), 'object')
})

test('the solid-parts filter keeps an operand it could not classify', () => {
  // Studio's `filter_volumes`, as the rule the apply path now shares. A helper volume must leave the
  // OPERAND set rather than reach the evaluator as an empty soup, which the closed-solid gate would
  // then report as an unrepairable open mesh. But an operand whose subtype did not resolve
  // participates: silently omitting geometry we merely failed to classify is the worse error.
  const part = { solidPartsOnly: true, mode: 'part' } as const
  assert.equal(meshBooleanOperandParticipates('normal_part', part), true)
  assert.equal(meshBooleanOperandParticipates('negative_part', part), false)
  assert.equal(meshBooleanOperandParticipates('support_blocker', part), false)
  assert.equal(meshBooleanOperandParticipates('modifier_part', part), false)
  assert.equal(meshBooleanOperandParticipates(null, part), true, 'unclassified must not be dropped')

  // Toggle off: a helper volume is an operand solid like any other.
  assert.equal(meshBooleanOperandParticipates('negative_part', { solidPartsOnly: false, mode: 'part' }), true)
  // Object mode: operands are whole objects, so nothing is filtered whatever the toggle says.
  assert.equal(meshBooleanOperandParticipates('negative_part', { solidPartsOnly: true, mode: 'object' }), true)
})

test('a world soup re-expressed in an object frame lands back on the geometry it came from', () => {
  // The part-mode result is world-space but an added part's soup is read relative to its host, so
  // it is pulled back through the rotor's inverse and placed at identity. Getting this wrong throws
  // nothing -- it puts the volume somewhere plausible and wrong, which on a rotated or scaled host
  // is nowhere near what it was cut from. A rotation AND a scale, because either alone hides a
  // transposed or unscaled matrix.
  const host = new THREE.Object3D()
  host.position.set(120, 80, 0)
  host.rotation.set(0, 0, Math.PI / 2)
  host.scale.set(2, 2, 2)
  host.updateWorldMatrix(true, false)

  const local = boxSoup([-5, -5, 0], [5, 5, 10])
  // Push it out to world through the host, then pull it back: the round trip must be the identity.
  const toWorld = host.matrixWorld
  const world = local.slice()
  const v = new THREE.Vector3()
  for (let i = 0; i < world.length; i += 3) {
    v.set(world[i]!, world[i + 1]!, world[i + 2]!).applyMatrix4(toWorld)
    world[i] = v.x; world[i + 1] = v.y; world[i + 2] = v.z
  }
  assert.ok(Math.abs(world[0]! - local[0]!) > 1 || Math.abs(world[1]! - local[1]!) > 1,
    'fixture transform must actually move the soup, or the round trip proves nothing')

  const back = toObjectLocalSoup(world, new THREE.Matrix4().copy(toWorld).invert())
  let worst = 0
  for (let i = 0; i < local.length; i++) worst = Math.max(worst, Math.abs(back[i]! - local[i]!))
  assert.ok(worst < 1e-3, `round trip drifted by ${worst}`)

  // And the source is untouched: the caller's world soup is the live scene's geometry.
  assert.notEqual(back, world)
})
