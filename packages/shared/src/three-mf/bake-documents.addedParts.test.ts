/**
 * `applyAddedParts` rewrites `<part>` entries with regexes, and the XML it rewrites was written by
 * somebody else -- BambuStudio, another slicer, a hand-edited project. What varies is not the data
 * but the SPELLING, and a regex written against one spelling silently mangles another: a lazy
 * `[\s\S]*?</part>` on an entry that has no closing tag runs on to the next part's and deletes it.
 *
 * Driven directly rather than through a full archive round trip because our own writer always emits
 * a closing tag, so the base file a round trip can build cannot express the case.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyAddedParts } from './bake-documents.js'
import type { SceneEdit } from '../slicing.js'

const MODEL_XML = [
  '<model>',
  ' <resources>',
  '  <object id="1" type="model">',
  '   <mesh><vertices/><triangles/></mesh>',
  '  </object>',
  ' </resources>',
  '</model>'
].join('\n')

const added: NonNullable<SceneEdit['addedParts']> = [
  { objectId: 1, meshImportId: 'imp-added', subtype: 'normal_part', name: 'Keeper', matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] }
]

const bake = (modelSettingsXml: string, removedBodies: ReadonlySet<number>) => applyAddedParts(
  MODEL_XML,
  modelSettingsXml,
  added,
  new Map([['imp-added', 9]]),
  () => 50,
  null,
  new Map(),
  removedBodies
)

test('dropping a SELF-CLOSING body part leaves the parts after it alone', () => {
  // `<part id="1" .../>` is legal and carries everything in its attributes. Matched with a pattern
  // that assumes a closing tag, the replace swallowed everything up to the NEXT `</part>` -- so
  // deleting object 1's body also deleted part 2's name, extruder and settings, in a file the user
  // never touched those in.
  const settings = [
    '<config>',
    '  <object id="1">',
    '    <metadata key="name" value="Widget"/>',
    '    <part id="1" subtype="normal_part"/>',
    '    <part id="2" subtype="normal_part">',
    '      <metadata key="name" value="Neighbour"/>',
    '      <metadata key="extruder" value="3"/>',
    '    </part>',
    '  </object>',
    '</config>'
  ].join('\n')

  const { modelSettingsXml } = bake(settings, new Set([1]))
  assert.doesNotMatch(modelSettingsXml, /<part id="1"/, 'the removed body kept its part entry')
  assert.match(modelSettingsXml, /<metadata key="name" value="Neighbour"\/>/,
    "the neighbouring part's name was deleted with the body")
  assert.match(modelSettingsXml, /<metadata key="extruder" value="3"\/>/,
    "the neighbouring part's extruder was deleted with the body")
  // ...and the volume the body made way for is still added.
  assert.match(modelSettingsXml, /<part id="9"/)
})

test('dropping a body part written with a closing tag still removes the whole entry', () => {
  // The other spelling, pinned alongside so a fix for one cannot regress the other.
  const settings = [
    '<config>',
    '  <object id="1">',
    '    <part id="1" subtype="normal_part">',
    '      <metadata key="name" value="Widget"/>',
    '    </part>',
    '    <part id="2" subtype="normal_part">',
    '      <metadata key="name" value="Neighbour"/>',
    '    </part>',
    '  </object>',
    '</config>'
  ].join('\n')

  const { modelSettingsXml } = bake(settings, new Set([1]))
  assert.doesNotMatch(modelSettingsXml, /value="Widget"/, "the body's own part entry survived")
  assert.match(modelSettingsXml, /value="Neighbour"/)
})

test('a KEPT body is re-keyed onto its promoted mesh, in either spelling', () => {
  // The keep branch only rewrites the id attribute, so it was never exposed to this -- asserted so
  // the two branches are known to agree.
  for (const bodyEntry of ['<part id="1" subtype="normal_part"/>', '<part id="1" subtype="normal_part"></part>']) {
    const settings = ['<config>', '  <object id="1">', `    ${bodyEntry}`, '  </object>', '</config>'].join('\n')
    const { modelSettingsXml } = bake(settings, new Set())
    assert.match(modelSettingsXml, /<part id="50"/, `the body kept its old id for ${bodyEntry}`)
    assert.doesNotMatch(modelSettingsXml, /<part id="1"/)
  }
})
