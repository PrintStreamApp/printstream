/**
 * Sidecars keyed by 1-based OBJECT ORDINAL must follow the objects when the object set changes.
 *
 * `cut_information.xml`, `layer_config_ranges.xml` and `layer_heights_profile.txt` are addressed by
 * an object's POSITION, not its id, and we copied all three through a save verbatim. Delete an
 * object and every later position shifts, so the entries describe the wrong objects.
 *
 * BambuStudio does not merely ignore a stale entry. `bbs_3mf.cpp` looks cut info up by
 * `object.second + 1` and then indexes `model_object->volumes[connector.volume_id]` guarded only by
 * an assert, which is compiled out of release builds and is off-by-one in any case. So a shifted
 * entry lands its connectors on whichever object slid into that position, and writes out of bounds
 * when that object has fewer volumes.
 *
 * Found by the differential sweep on real projects: 12 of 33 files that our code had never written
 * produced a stale ordinal after an ordinary "delete an object".
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OBJECT_ORDINAL_SIDECAR_ENTRIES, remapObjectOrdinalSidecar } from './object-ordinal-sidecars.js'

const CUT_INFO = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<objects>',
  ' <object id="1">',
  '  <cut_id id="2652" check_sum="2" connectors_cnt="4"/>',
  ' </object>',
  ' <object id="3">',
  '  <cut_id id="991" check_sum="1" connectors_cnt="2"/>',
  ' </object>',
  '</objects>'
].join('\n')

test('an entry follows its object to a new position', () => {
  // Objects 10, 20, 30 in the file; object 20 is deleted, so 30 moves from ordinal 3 to 2.
  const out = remapObjectOrdinalSidecar(CUT_INFO, [10, 20, 30], [10, 30])
  assert.match(out, /<object id="1">/, 'the first object did not move')
  assert.match(out, /<object id="2">/, 'ordinal 3 became ordinal 2')
  assert.doesNotMatch(out, /<object id="3">/)
  // The payload rides along untouched: only the ordinal is ours to rewrite.
  assert.match(out, /<cut_id id="991" check_sum="1" connectors_cnt="2"\/>/)
})

test('an entry whose object is gone is dropped, not renumbered onto a survivor', () => {
  // Object 10 deleted. Its cut info must not land on 30, which is what a naive shift would do.
  const out = remapObjectOrdinalSidecar(CUT_INFO, [10, 20, 30], [20, 30])
  assert.doesNotMatch(out, /2652/, "the deleted object's entry is gone")
  assert.match(out, /<object id="2">/, 'object 30 moved from ordinal 3 to 2')
  assert.match(out, /991/)
})

test('an unchanged object set is returned byte for byte', () => {
  // The common case by far. Rewriting here would churn every save for no reason.
  assert.equal(remapObjectOrdinalSidecar(CUT_INFO, [10, 20, 30], [10, 20, 30]), CUT_INFO)
})

test('an unreadable ordinal space leaves the document alone', () => {
  // No object order to map against means the correct answer is not derivable, and a guess here
  // silently attaches cut connectors to the wrong geometry.
  assert.equal(remapObjectOrdinalSidecar(CUT_INFO, [], [10, 20]), CUT_INFO)
  assert.equal(remapObjectOrdinalSidecar(CUT_INFO, [10, 20, 30], []), CUT_INFO)
})

test('dropping every referenced object empties the document rather than corrupting it', () => {
  const out = remapObjectOrdinalSidecar(CUT_INFO, [10, 20, 30], [20])
  assert.doesNotMatch(out, /<object id=/)
  assert.match(out, /<objects>/, 'the wrapper survives so the file stays well formed')
})

test('the layer-heights profile follows its object and drops with it', () => {
  // Same 1-based ordinal space, confirmed at `bbs_3mf.cpp:2129`, but one line per object rather
  // than an XML block, so it needs its own rewriter.
  const profile = ['object_id=1|0.0;0.2', 'object_id=3|0.0;0.3'].join('\n')
  const moved = remapObjectOrdinalSidecar(profile, [10, 20, 30], [10, 30], 'profileText')
  assert.equal(moved, ['object_id=1|0.0;0.2', 'object_id=2|0.0;0.3'].join('\n'))

  const dropped = remapObjectOrdinalSidecar(profile, [10, 20, 30], [20, 30], 'profileText')
  assert.equal(dropped, 'object_id=2|0.0;0.3', "the deleted object's profile is gone")
})

test('every listed sidecar names a format the remapper implements', () => {
  // A new entry added to the table with no matching branch would silently fall through to the XML
  // rewriter and mangle a text file.
  for (const sidecar of OBJECT_ORDINAL_SIDECAR_ENTRIES) {
    assert.ok(['xml', 'profileText'].includes(sidecar.format), `${sidecar.path} has no rewriter`)
  }
})

/**
 * `cut_information.xml` names a VOLUME as well as an object, and a part removal or reorder permutes
 * that index without necessarily moving any object.
 */
const CUT_INFO_CONNECTORS = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<objects>',
  ' <object id="1">',
  '  <cut_id id="7" check_sum="1" connectors_cnt="3"/>',
  '  <connectors>',
  '   <connector volume_id="0" type="0" radius="2" height="3" r_tolerance="0" h_tolerance="0"/>',
  '   <connector volume_id="1" type="0" radius="2" height="3" r_tolerance="0" h_tolerance="0"/>',
  '   <connector volume_id="2" type="0" radius="2" height="3" r_tolerance="0" h_tolerance="0"/>',
  '  </connectors>',
  ' </object>',
  '</objects>'
].join('\n')

const connectorVolumes = (xml: string): number[] =>
  [...xml.matchAll(/<connector\b[^>]*\bvolume_id="(\d+)"/g)].map((match) => Number(match[1]))

test('a part REORDER remaps the connector volume ids even though no object moved', () => {
  // The object order is identical, so the old early-return left every connector on the volume that
  // slid into its slot. Layout [2, 0, 1] means old volume 2 is now first.
  const remapped = remapObjectOrdinalSidecar(CUT_INFO_CONNECTORS, [5], [5], 'xml', new Map([[5, [2, 0, 1]]]))
  assert.deepEqual(connectorVolumes(remapped), [1, 2, 0])
})

test('a connector whose volume was removed is dropped, and the count is left alone', () => {
  // Volume 1 is gone: dropping is the same rule a stale OBJECT entry follows, because renumbering
  // would hand this connector to whichever volume took the slot.
  //
  // `connectors_cnt` does NOT follow, though it reads like a count of the list above it. See the
  // identity test below.
  const remapped = remapObjectOrdinalSidecar(CUT_INFO_CONNECTORS, [5], [5], 'xml', new Map([[5, [0, 2]]]))
  assert.deepEqual(connectorVolumes(remapped), [0, 1])
  assert.match(remapped, /connectors_cnt="3"/)
})

test('connectors_cnt is cut-group IDENTITY, so nothing here may rewrite it', () => {
  // The one that made this worth pinning. `connectors_cnt` is not a count of the block's
  // `<connector>` elements: it is written from `object->cut_id.connectors_cnt()`, a CUMULATIVE
  // counter incremented once per cut and shared by every half of a cut group, and it is compared
  // field-for-field by `CutObjectBase::is_equal` (id + check_sum + connectors_cnt) -- which is how
  // BambuStudio finds an object's cut siblings for "delete all connectors".
  //
  // So the two numbers legitimately diverge: a twice-cut half can list 2 connectors and carry 4.
  // Rewriting it to what we counted desynchronises this half from its sibling, and a PURE REORDER
  // (nothing removed, nothing that could justify a new count) is enough to do it.
  const twiceCut = CUT_INFO_CONNECTORS
    .replace('connectors_cnt="3"', 'connectors_cnt="4"')
    .replace(/[ \t]*<connector volume_id="2"[^>]*\/>\n/, '')
  const remapped = remapObjectOrdinalSidecar(twiceCut, [5], [5], 'xml', new Map([[5, [1, 0]]]))
  assert.deepEqual(connectorVolumes(remapped), [1, 0], 'the volume ids themselves must still remap')
  assert.match(remapped, /connectors_cnt="4"/)
})

test('an object move and a volume move in one save both land', () => {
  // Object 5 goes from ordinal 1 to ordinal 2 AND its volumes are reordered.
  const remapped = remapObjectOrdinalSidecar(CUT_INFO_CONNECTORS, [5, 9], [9, 5], 'xml', new Map([[5, [2, 0, 1]]]))
  assert.match(remapped, /<object id="2">/)
  assert.deepEqual(connectorVolumes(remapped), [1, 2, 0])
})

test('no layout for an object leaves its connectors alone', () => {
  assert.equal(remapObjectOrdinalSidecar(CUT_INFO_CONNECTORS, [5], [5], 'xml', new Map([[9, [1, 0]]])), CUT_INFO_CONNECTORS)
  assert.equal(remapObjectOrdinalSidecar(CUT_INFO_CONNECTORS, [5], [5], 'xml', new Map()), CUT_INFO_CONNECTORS)
  assert.equal(remapObjectOrdinalSidecar(CUT_INFO_CONNECTORS, [5], [5], 'xml'), CUT_INFO_CONNECTORS)
})

test('a cut_id with no connectors list keeps its count', () => {
  // `connectors_cnt` on a bare `<cut_id>` counts records that are not in this block; rewriting it
  // to the zero we matched would unregister every one of them. CUT_INFO (the file's own fixture)
  // is exactly that shape.
  // CUT_INFO's blocks are ordinals 1 and 3, so the order needs three objects to keep both.
  const remapped = remapObjectOrdinalSidecar(CUT_INFO, [5, 9, 11], [5, 9, 11], 'xml', new Map([[5, [1, 0]]]))
  assert.match(remapped, /connectors_cnt="4"/)
  assert.match(remapped, /connectors_cnt="2"/)
})

test('a connector written with an explicit close tag is remapped, not just self-closing ones', () => {
  const explicit = CUT_INFO_CONNECTORS
    .replace('<connector volume_id="0" type="0" radius="2" height="3" r_tolerance="0" h_tolerance="0"/>',
      '<connector volume_id="0" type="0" radius="2" height="3" r_tolerance="0" h_tolerance="0"></connector>')
  const remapped = remapObjectOrdinalSidecar(explicit, [5], [5], 'xml', new Map([[5, [2, 0, 1]]]))
  assert.deepEqual(connectorVolumes(remapped), [1, 2, 0])
  assert.match(remapped, /connectors_cnt="3"/)
})

test('brim ears follow their object, like every other positional sidecar', () => {
  // Authored only when the session touched an ear, so an ordinary reorder streams the file through
  // and the ordinals underneath it move. That is what put an object's ears on a different model.
  const brim = 'brim_points_format_version=1\nobject_id=1|1 2 3 4\nobject_id=2|5 6 7 8'
  const remapped = remapObjectOrdinalSidecar(brim, [5, 9], [9, 5], 'profileText')
  assert.match(remapped, /^brim_points_format_version=1$/m)
  assert.match(remapped, /^object_id=2\|1 2 3 4$/m)
  assert.match(remapped, /^object_id=1\|5 6 7 8$/m)
})
