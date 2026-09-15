import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeProjectAuxiliaryBase64, type ProjectAuxiliaries } from '../project-auxiliaries.js'
import {
  applyProjectAuxiliaryMetadata,
  applyProjectAuxiliaryRelationships,
  managedProjectAuxiliaryPrefixes,
  projectAuxiliaryArchiveEntries,
  readProjectAuxiliaryCoverNames,
  readProjectAuxiliaryMetadata
} from './project-auxiliaries.js'

const auxiliaries: ProjectAuxiliaries = {
  files: [
    { category: 'Model Pictures', name: 'cover.png', contentBase64: encodeProjectAuxiliaryBase64(Uint8Array.from([1, 2])), cover: true },
    { category: 'Others', name: 'notes.txt', contentBase64: encodeProjectAuxiliaryBase64(Uint8Array.from([3])) }
  ],
  metadata: {
    modelName: 'Gear & axle',
    modelAuthor: 'Ryan',
    modelDescription: 'A <small> assembly',
    modelId: '42',
    profileName: 'Fast',
    profileAuthor: 'PrintStream',
    profileDescription: '0.2 mm'
  },
  coverThumbnails: {
    threeMf: encodeProjectAuxiliaryBase64(Uint8Array.from([4])),
    small: encodeProjectAuxiliaryBase64(Uint8Array.from([5])),
    middle: encodeProjectAuxiliaryBase64(Uint8Array.from([6]))
  }
}

test('writes binary attachment and thumbnail entries at BambuStudio paths', () => {
  const entries = projectAuxiliaryArchiveEntries(auxiliaries)
  assert.deepEqual(entries.map((entry) => entry.name), [
    'Auxiliaries/Model Pictures/cover.png',
    'Auxiliaries/Others/notes.txt',
    'Auxiliaries/.thumbnails/thumbnail_3mf.png',
    'Auxiliaries/.thumbnails/thumbnail_small.png',
    'Auxiliaries/.thumbnails/thumbnail_middle.png'
  ])
  assert.deepEqual([...entries[0]!.content], [1, 2])
  assert.ok(managedProjectAuxiliaryPrefixes().includes('Auxiliaries/Others/'))
})

test('round-trips project metadata and cover names through the root model', () => {
  const xml = applyProjectAuxiliaryMetadata('<?xml version="1.0"?><model><resources/></model>', auxiliaries)
  assert.deepEqual(readProjectAuxiliaryMetadata(xml), auxiliaries.metadata)
  assert.deepEqual(readProjectAuxiliaryCoverNames(xml), { model: 'cover.png', profile: '' })
})

test('points cover relationships at auxiliary thumbnails', () => {
  const source = '<Relationships><Relationship Id="rel-2" Target="/Metadata/plate_1.png"/><Relationship Target="old" Id="rel-4"/><Relationship Id="rel-5" Target="old"/></Relationships>'
  const updated = applyProjectAuxiliaryRelationships(source, true)
  assert.match(updated, /Auxiliaries\/.thumbnails\/thumbnail_3mf\.png/)
  assert.match(updated, /Auxiliaries\/.thumbnails\/thumbnail_middle\.png/)
  assert.match(updated, /Auxiliaries\/.thumbnails\/thumbnail_small\.png/)
})
