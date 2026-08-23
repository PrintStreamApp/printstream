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
import { OBJECT_ORDINAL_SIDECAR_ENTRIES, remapObjectOrdinalSidecar } from './object-ordinal-sidecars'

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
