import assert from 'node:assert/strict'
import test from 'node:test'
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import type { SceneEdit } from '@printstream/shared'
import { bakeClientThreeMf } from './clientThreeMfBake'
import { openThreeMfArchive } from './threeMfArchive'

/**
 * These cover the browser's half of the bake: the ZIP layer and the copy pass. What the output
 * CONTAINS is decided by the shared plan, which the api's 124-test bake suite already exercises;
 * what is unproven here is that applying that plan with fflate produces a valid, complete archive.
 */

const MODEL_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<model unit="millimeter"><resources></resources><build></build></model>'
].join('\n')

const MODEL_SETTINGS_XML = ['<?xml version="1.0" encoding="UTF-8"?>', '<config>', '</config>'].join('\n')

const EMPTY_EDIT: SceneEdit = { plates: [{ index: 1 }], instances: [] }

/** A Blob over a synthetic 3MF, since `openThreeMfArchive` takes what a file picker hands it. */
function sourceArchive(extra: Record<string, string> = {}): Blob {
  const entries: Record<string, Uint8Array> = {
    '3D/3dmodel.model': strToU8(MODEL_XML),
    'Metadata/model_settings.config': strToU8(MODEL_SETTINGS_XML)
  }
  for (const [name, content] of Object.entries(extra)) entries[name] = strToU8(content)
  return new Blob([new Uint8Array(zipSync(entries))])
}

test('a from-scratch bake produces an archive the parser can open', async () => {
  const { bytes } = await bakeClientThreeMf(null, EMPTY_EDIT)
  const entries = unzipSync(bytes)

  // The four entries a 3MF needs to be a 3MF at all.
  assert.ok(entries['[Content_Types].xml'], 'content types')
  assert.ok(entries['_rels/.rels'], 'package relationships')
  assert.ok(entries['3D/3dmodel.model'], 'root model')
  assert.ok(entries['Metadata/model_settings.config'], 'model settings')

  // And it round-trips: the archive reader accepts what we just wrote.
  const reopened = await openThreeMfArchive(new Blob([new Uint8Array(bytes)]))
  assert.ok(reopened.entryText('3D/3dmodel.model')?.includes('<model'))
})

test('the copy pass carries through every entry the bake does not rewrite', async () => {
  // A 3MF holds far more than the editor models. Anything not transformed must survive verbatim,
  // or saving would quietly strip the parts of the project we do not understand.
  const vendorBlob = '<?xml version="1.0"?><vendor-thing keep="yes"/>'
  const archive = await openThreeMfArchive(sourceArchive({
    'Metadata/vendor_specific.xml': vendorBlob,
    'Metadata/plate_1.png': 'not-really-a-png-but-opaque-bytes'
  }))

  const { bytes } = await bakeClientThreeMf(archive, EMPTY_EDIT)
  const entries = unzipSync(bytes)

  assert.equal(strFromU8(entries['Metadata/vendor_specific.xml']!), vendorBlob)
  assert.equal(strFromU8(entries['Metadata/plate_1.png']!), 'not-really-a-png-but-opaque-bytes')
  // The model itself is rewritten (the build section is regenerated), so it is present but need
  // not match byte-for-byte.
  assert.ok(entries['3D/3dmodel.model'])
})

test('bakeClientThreeMf reports the baked ids the caller needs to re-key overrides', async () => {
  const { result } = await bakeClientThreeMf(null, EMPTY_EDIT)
  assert.deepEqual(result.replacedObjectIds, [])
  assert.deepEqual(result.importObjectIds, [])
  assert.deepEqual(result.clonedObjectIds, [])
})
