/** Auxiliaries are explicit complete state only after the editor changes them. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeProjectAuxiliaryBase64, type SceneEdit } from '../index.js'
import { emptyThreeMfBakeSource, planEditedThreeMf, type ThreeMfBakeSource } from './bake.js'

const edit = {
  plates: [{ index: 1 }],
  instances: [],
  projectAuxiliaries: {
    files: [{
      category: 'Model Pictures',
      name: 'cover.png',
      contentBase64: encodeProjectAuxiliaryBase64(Uint8Array.from([9, 8, 7])),
      cover: true
    }],
    metadata: {
      modelName: 'Portable project',
      modelAuthor: '',
      modelDescription: '',
      modelId: '',
      profileName: '',
      profileAuthor: '',
      profileDescription: ''
    },
    coverThumbnails: {
      threeMf: encodeProjectAuxiliaryBase64(Uint8Array.from([1])),
      small: encodeProjectAuxiliaryBase64(Uint8Array.from([2])),
      middle: encodeProjectAuxiliaryBase64(Uint8Array.from([3]))
    }
  }
} as SceneEdit

const base: ThreeMfBakeSource = {
  modelXml: '<?xml version="1.0"?><model><resources/><build/></model>',
  modelSettingsXml: '<?xml version="1.0"?><config/>',
  projectSettingsJson: null,
  customGcodeXml: null,
  sliceInfoXml: null,
  modelRelsXml: null,
  subModelEntries: new Map(),
  hasBase: true
}

test('copy plans replace only the managed auxiliary folders and author cover pointers', () => {
  const plan = planEditedThreeMf(base, edit)
  assert.ok(plan.copy?.dropPrefixes.includes('Auxiliaries/Model Pictures/'))
  assert.ok(!plan.copy?.dropPrefixes.includes('Auxiliaries/Vendor Data/'))
  const cover = plan.copy?.appendEntries.find((entry) => entry.name === 'Auxiliaries/Model Pictures/cover.png')
  assert.ok(cover?.content instanceof Uint8Array)
  assert.deepEqual([...(cover!.content as Uint8Array)], [9, 8, 7])
  assert.match(plan.copy!.transforms.get('3D/3dmodel.model')!(''), /Portable project/)
  assert.match(
    plan.copy!.transforms.get('_rels/.rels')!('<Relationship Target="old" Id="rel-2"/>'),
    /thumbnail_3mf\.png/
  )
})

test('fresh plans include binary auxiliaries and point cover relationships at them', () => {
  const plan = planEditedThreeMf(emptyThreeMfBakeSource(), edit)
  const rels = plan.freshEntries?.find((entry) => entry.name === '_rels/.rels')?.content
  assert.equal(typeof rels, 'string')
  assert.match(rels as string, /Auxiliaries\/.thumbnails\/thumbnail_3mf\.png/)
  assert.ok(plan.freshEntries?.some((entry) => entry.name === 'Auxiliaries/.thumbnails/thumbnail_middle.png'))
})
