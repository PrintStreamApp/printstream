/**
 * `Metadata/cut_information.xml`, checked against what BambuStudio's reader actually requires.
 *
 * The rules pinned here are the ones whose breakage is either silent or catastrophic: a missing
 * attribute throws INSIDE the project load and takes the whole file down, an inherited group
 * vanishing strips cuts the session never touched, and a connector pointed at the wrong volume
 * makes Studio offer to delete ordinary geometry.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CUT_CONNECTOR_TYPE_CODES,
  CUT_INFORMATION_ENTRY,
  parseCutInformation,
  serializeCutInformation,
  type CutInformationGroup
} from './cut-information.js'

/** Two cut halves (ids 10 and 11), each a components object; 11 carries a connector volume (21). */
const MODEL_XML = `<?xml version="1.0"?>
<model><resources>
 <object id="20" type="model"><mesh/></object>
 <object id="21" type="model"><mesh/></object>
 <object id="10" type="model"><components>
   <component objectid="20" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
  </components></object>
 <object id="11" type="model"><components>
   <component objectid="20" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
   <component objectid="21" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
  </components></object>
</resources><build>
 <item objectid="10" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
 <item objectid="11" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
</build></model>`

function group(overrides: Partial<CutInformationGroup> = {}): CutInformationGroup {
  return {
    objectIds: [10, 11],
    connectorCount: 1,
    connectors: [{
      objectId: 11,
      componentObjectId: 21,
      type: 'plug',
      radius: 1.25,
      height: 3,
      radiusTolerance: 0.1,
      heightTolerance: 0.1
    }],
    ...overrides
  }
}

test('the entry is the path BambuStudio reads', () => {
  assert.equal(CUT_INFORMATION_ENTRY, 'Metadata/cut_information.xml')
})

test('both halves of a cut carry the SAME identity, which is what pairs them', () => {
  // `CutObjectBase::is_equal` compares the id, the check sum AND the connector count together.
  // Any of the three differing between halves means "delete all connectors" and "invalidate cut"
  // silently act on one half only.
  const xml = serializeCutInformation([group()], MODEL_XML)!
  const ids = [...xml.matchAll(/<cut_id id="(\d+)" check_sum="(\d+)" connectors_cnt="(\d+)"\/>/g)]
  assert.equal(ids.length, 2, 'one cut_id per object in the group')
  assert.deepEqual(ids[0]!.slice(1), ids[1]!.slice(1), 'the halves disagree about their cut identity')
})

test('check_sum counts the objects in the group, never more than were written', () => {
  // A check sum larger than the objects present means the user can never "fully select" the group,
  // and Studio leaves non-uniform scaling permanently disabled for it.
  const withPin = serializeCutInformation([group({ objectIds: [10, 11, 99] })], MODEL_XML)!
  // 99 is not in the build, so it takes no block and must not be counted.
  assert.match(withPin, /check_sum="2"/)
  assert.equal([...withPin.matchAll(/<object id=/g)].length, 2)
})

test('every attribute the reader requires is present', () => {
  // `pt::ptree::get` with no default THROWS, and nothing between the extractor and `load_model`
  // catches it, so one missing attribute fails the entire project load rather than the cut.
  const xml = serializeCutInformation([group()], MODEL_XML)!
  const connector = xml.match(/<connector\b[^>]*\/>/)![0]
  for (const attribute of ['volume_id', 'type', 'radius', 'height', 'r_tolerance', 'h_tolerance']) {
    assert.match(connector, new RegExp(`\\b${attribute}="`), `${attribute} is required and missing`)
  }
  for (const attribute of ['id', 'check_sum', 'connectors_cnt']) {
    assert.match(xml.match(/<cut_id\b[^>]*\/>/)![0], new RegExp(`\\b${attribute}="`))
  }
})

test('an object is named by its BUILD ORDINAL, not its 3MF id', () => {
  const xml = serializeCutInformation([group()], MODEL_XML)!
  // Objects 10 and 11 are the first and second build items, so 1 and 2.
  assert.match(xml, /<object id="1">/)
  assert.match(xml, /<object id="2">/)
  assert.doesNotMatch(xml, /<object id="10">/)
})

test('a connector names its volume by POSITION among the object components', () => {
  // Object 11's components are [20, 21], so the connector's mesh (21) is volume 1. Predicting this
  // instead of reading the written document is what breaks when a pass reorders components.
  const xml = serializeCutInformation([group()], MODEL_XML)!
  assert.match(xml, /<connector volume_id="1"/)
})

test('the connector type is the code Studio serializes, not the name', () => {
  assert.deepEqual(CUT_CONNECTOR_TYPE_CODES, { plug: 0, dowel: 1, snap: 2 })
  for (const [name, code] of Object.entries(CUT_CONNECTOR_TYPE_CODES)) {
    const xml = serializeCutInformation(
      [group({ connectors: [{ ...group().connectors[0]!, type: name as 'plug' }] })],
      MODEL_XML
    )!
    assert.match(xml, new RegExp(`type="${code}"`))
  }
})

test('a connector drilled into the mesh is OMITTED, and the count still reports it', () => {
  // The dowel case: every side is a hole, so neither half has a volume to point at. The list is
  // empty and `connectors_cnt` carries the truth, which is what keeps the halves paired.
  const xml = serializeCutInformation([group({ connectorCount: 2, connectors: [] })], MODEL_XML)!
  assert.doesNotMatch(xml, /<connectors>/, 'an empty list must not be written at all')
  assert.match(xml, /connectors_cnt="2"/)
  assert.equal([...xml.matchAll(/<cut_id/g)].length, 2, 'the halves are still a recognised pair')
})

test('a connector whose volume is gone is dropped rather than pointed somewhere else', () => {
  // Studio indexes `volumes[volume_id]` behind an assert that release builds compile out, so a
  // stale ordinal is a connector on unrelated geometry at best.
  const xml = serializeCutInformation(
    [group({ connectors: [{ ...group().connectors[0]!, componentObjectId: 404 }] })],
    MODEL_XML
  )!
  assert.doesNotMatch(xml, /<connector\b/)
  assert.match(xml, /<cut_id/, 'the cut itself is still recorded')
})

test('groups the base file already carried are kept, not replaced', () => {
  // The one way this differs from the other authored sidecars. A project can hold cuts made in
  // BambuStudio for objects this session never touched; rewriting the file wholesale would strip
  // them silently.
  const base = `<?xml version="1.0" encoding="utf-8"?>
<objects>
 <object id="7">
  <cut_id id="2652" check_sum="2" connectors_cnt="4"/>
 </object>
</objects>`
  const xml = serializeCutInformation([group()], MODEL_XML, base)!
  assert.match(xml, /<object id="7">/, 'the inherited group was dropped')
  assert.match(xml, /id="2652"/)
  // And a new group must not reuse an id already in the file, or the two would read as one cut.
  const ours = [...xml.matchAll(/<cut_id id="(\d+)"/g)].map((m) => Number(m[1])).filter((id) => id !== 2652)
  assert.ok(ours.every((id) => id > 2652), `a new cut id collided with the inherited one: ${ours}`)
  assert.equal(new Set(ours).size, 1, 'both halves of our cut share one id')
})

test('a cut that kept only one half is not recorded', () => {
  // Studio declines too: `update_object_cut_id` returns early unless both halves survive, because a
  // group of one has nothing to pair with and only disables scaling.
  assert.equal(serializeCutInformation([group({ objectIds: [10] })], MODEL_XML), null)
})

test('nothing to say produces no file at all', () => {
  assert.equal(serializeCutInformation([], MODEL_XML), null)
  // But an inherited file with no new groups is preserved rather than deleted.
  const base = '<objects>\n <object id="3">\n  <cut_id id="5" check_sum="2" connectors_cnt="0"/>\n </object>\n</objects>'
  assert.match(serializeCutInformation([], MODEL_XML, base)!, /<object id="3">/)
})

test('the document is the shape the reader parses', () => {
  const xml = serializeCutInformation([group()], MODEL_XML)!
  assert.match(xml, /^<\?xml version="1\.0" encoding="utf-8"\?>\n<objects>/)
  assert.match(xml, /<\/objects>\n$/)
  // Self-closing, as boost emits an element with attributes and no children.
  assert.match(xml, /<cut_id\b[^>]*\/>/)
})

test('the record reads back, which is what makes a SAVED cut reopen as a cut', () => {
  // The hop the text tool shipped without. Written correctly, read by nobody, and the only symptom
  // is a feature that works until you reopen the file.
  const parsed = parseCutInformation(serializeCutInformation([group()], MODEL_XML))
  assert.equal(parsed.size, 2, 'both halves should come back')
  const [first, second] = [...parsed.values()]
  assert.equal(first!.cutId, second!.cutId, 'the halves must read as one group')
  // Object 11 carries the connector at volume ordinal 1; object 10 carries none.
  const withConnectors = [...parsed.values()].filter((entry) => entry.connectorVolumeIds.size > 0)
  assert.equal(withConnectors.length, 1)
  assert.deepEqual([...withConnectors[0]!.connectorVolumeIds], [1])
})

test('an uncut object is skipped, though BambuStudio writes a block for it', () => {
  // Its writer emits one per object regardless, with id="0" for anything never cut, and
  // `ObjectID::valid()` is `id != 0`. Reading those as cuts would mark the whole plate.
  const parsed = parseCutInformation(
    '<objects>\n <object id="1">\n  <cut_id id="0" check_sum="1" connectors_cnt="0"/>\n </object>\n</objects>'
  )
  assert.equal(parsed.size, 0)
})

test('a malformed block is skipped rather than fatal', () => {
  // BambuStudio's own reader throws here and takes the project load with it. We are reading a file
  // that may have been written by anything, so a cut we cannot describe is better dropped.
  const parsed = parseCutInformation([
    '<objects>',
    ' <object id="nonsense"><cut_id id="5" check_sum="2" connectors_cnt="0"/></object>',
    ' <object id="2"><cut_id check_sum="2" connectors_cnt="0"/></object>',
    ' <object id="3"><cut_id id="9" check_sum="2" connectors_cnt="1"/>',
    '  <connectors><connector type="0"/><connector volume_id="2" type="0"/></connectors>',
    ' </object>',
    '</objects>'
  ].join('\n'))
  assert.deepEqual([...parsed.keys()], [3], 'only the readable block survives')
  // The connector missing a volume_id is ignored; its sibling is kept.
  assert.deepEqual([...parsed.get(3)!.connectorVolumeIds], [2])
})

test('nothing to read is an empty map, not a throw', () => {
  assert.equal(parseCutInformation(null).size, 0)
  assert.equal(parseCutInformation('').size, 0)
  assert.equal(parseCutInformation('<objects></objects>').size, 0)
})
