import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import {
  readPortableMachineBedAsset,
  SLICE_UPLOAD_FRAME_HEADER_BYTES,
  SLICE_UPLOAD_FRAME_MAGIC,
  type ProcessConfig,
  type SliceUploadManifest
} from '@printstream/shared'
import { readFramedSliceUpload } from './slice-upload-frame.js'

test('decodes fragmented manifests and restores raw assets before streaming the source', async () => {
  const model = Buffer.from([0, 1, 255])
  const source = Buffer.from('source-3mf')
  const manifest: SliceUploadManifest = {
    envelope: {
      jobId: 'job-1',
      sourceFileName: 'input.3mf',
      request: makeRequest(),
      profileFiles: [{
        id: 'custom:machine',
        source: 'custom',
        kind: 'machine',
        name: 'Machine',
        content: JSON.stringify({ bed_custom_model: 'bed.stl' })
      }]
    },
    bedAssets: [{
      profileId: 'custom:machine',
      kind: 'model',
      name: 'bed.stl',
      byteLength: model.byteLength
    }]
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8')
  const header = Buffer.alloc(SLICE_UPLOAD_FRAME_HEADER_BYTES)
  header.write(SLICE_UPLOAD_FRAME_MAGIC, 0, 'ascii')
  header.writeUInt32BE(manifestBytes.byteLength, 4)
  const body = Buffer.concat([header, manifestBytes, model, source])
  const chunks = [...body].map((byte) => Buffer.from([byte]))

  const decoded = await readFramedSliceUpload(Readable.from(chunks), body.byteLength)
  const restoredProfile = decoded.envelope.profileFiles?.[0]
  const restored = JSON.parse(restoredProfile?.content ?? '{}') as ProcessConfig
  const restoredModel = readPortableMachineBedAsset(restored, 'model')
  assert.ok(restoredModel)
  assert.equal(restoredModel.name, 'bed.stl')
  assert.equal(decoded.declaredSourceLength, source.byteLength)
  assert.deepEqual(await collect(decoded.source), source)
})

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function makeRequest() {
  return {
    sourceFileId: 'source-1',
    plate: 1,
    target: {
      mode: 'manualProfile' as const,
      printerModel: 'P1S',
      printerProfileId: 'project:machine:printer',
      processProfileId: 'project:process:process',
      filamentMappings: []
    }
  }
}
