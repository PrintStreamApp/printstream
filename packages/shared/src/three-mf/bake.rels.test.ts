/**
 * A from-scratch archive's `_rels/.rels` must name the same relationships BambuStudio's own exporter
 * writes. Ours carried only the 3dmodel relationship, which made our fresh archives the only files
 * in the wild missing the thumbnail ones (33 of 33 real projects carry them).
 *
 * Deliberately NOT justified as "otherwise there is no preview": the importer falls back to the
 * `Metadata/plate_1.png` literal when the relationship is absent (`bbs_3mf.cpp:1504`) and our own
 * readers resolve thumbnails by name, so nothing observed breaks. It is conformance, not repair.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { THREE_MF_RELS_XML } from './bake-documents'

test('the root relationships name the model and all three thumbnail roles', () => {
  const types = [...THREE_MF_RELS_XML.matchAll(/Type="([^"]+)"/g)].map((match) => match[1])
  assert.deepEqual(types, [
    'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel',
    'http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail',
    'http://schemas.bambulab.com/package/2021/cover-thumbnail-middle',
    'http://schemas.bambulab.com/package/2021/cover-thumbnail-small'
  ])
})

test('the thumbnail targets are the names our own thumbnail writer uses', () => {
  // The engine emits these defaults without checking the entry exists, and `embedPlateThumbnails`
  // writes exactly these names, so the pointers resolve rather than dangling.
  assert.match(THREE_MF_RELS_XML, /Target="\/Metadata\/plate_1\.png" Id="rel-2"/)
  assert.match(THREE_MF_RELS_XML, /Target="\/Metadata\/plate_1\.png" Id="rel-4"/)
  assert.match(THREE_MF_RELS_XML, /Target="\/Metadata\/plate_1_small\.png" Id="rel-5"/)
})

test('every relationship id is unique', () => {
  const ids = [...THREE_MF_RELS_XML.matchAll(/Id="([^"]+)"/g)].map((match) => match[1])
  assert.equal(new Set(ids).size, ids.length)
})
