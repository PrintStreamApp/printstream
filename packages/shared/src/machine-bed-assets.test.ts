import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearPortableMachineBedAsset,
  portableMachineBedAssetsEqual,
  portableMachineBedAssetBytes,
  readPortableMachineBedAsset,
  setPortableMachineBedAsset,
  stripPortableMachineBedAssetPayloads
} from './machine-bed-assets.js'

test('embeds, reads and strips a portable bed model', () => {
  const config = setPortableMachineBedAsset({}, 'model', {
    name: 'custom.stl',
    bytes: Uint8Array.from([0, 1, 2, 255])
  })

  assert.equal(config.bed_custom_model, 'custom.stl')
  assert.equal(readPortableMachineBedAsset(config, 'model')?.name, 'custom.stl')
  assert.deepEqual([...portableMachineBedAssetBytes(config, 'model')!.bytes], [0, 1, 2, 255])

  const stripped = stripPortableMachineBedAssetPayloads(config)
  assert.equal(stripped.bed_custom_model, 'custom.stl')
  assert.equal(stripped.printstream_bed_model_name, undefined)
  assert.equal(stripped.printstream_bed_model_content, undefined)
})

test('rejects unsafe names, unsupported formats and oversized assets', () => {
  assert.throws(() => setPortableMachineBedAsset({}, 'model', { name: '../bed.stl', bytes: new Uint8Array() }))
  assert.throws(() => setPortableMachineBedAsset({}, 'texture', { name: 'bed.jpg', bytes: new Uint8Array() }))
  assert.throws(() => setPortableMachineBedAsset({}, 'model', { name: 'bed.stl', bytes: new Uint8Array(1024 * 1024 + 1) }))
})

test('clearing removes both portable and standard asset fields', () => {
  const config = setPortableMachineBedAsset({}, 'texture', {
    name: 'bed.svg',
    bytes: new TextEncoder().encode('<svg/>')
  })

  assert.deepEqual(clearPortableMachineBedAsset(config, 'texture'), {})
})

test('asset equality includes payload replacements and explicit removal', () => {
  const first = setPortableMachineBedAsset({}, 'model', {
    name: 'bed.stl',
    bytes: Uint8Array.from([1])
  })
  assert.equal(portableMachineBedAssetsEqual(first, { ...first }), true)
  assert.equal(portableMachineBedAssetsEqual(first, setPortableMachineBedAsset({}, 'model', {
    name: 'bed.stl',
    bytes: Uint8Array.from([2])
  })), false)
  assert.equal(portableMachineBedAssetsEqual(first, clearPortableMachineBedAsset(first, 'model')), false)
})
