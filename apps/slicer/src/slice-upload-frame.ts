/**
 * Reads the framed API-to-slicer upload without buffering the source 3MF.
 *
 * The manifest is bounded and parsed first, followed by at most two bounded custom-bed assets.
 * Any bytes already read beyond those fields are replayed before the remainder of the request, so
 * the caller receives an exact stream of the source project.
 */
import {
  MAX_SLICE_UPLOAD_MANIFEST_BYTES,
  SLICE_UPLOAD_FRAME_HEADER_BYTES,
  SLICE_UPLOAD_FRAME_MAGIC,
  setPortableMachineBedAsset,
  sliceUploadManifestSchema,
  type ProcessConfig,
  type SliceEnvelope,
  type SliceUploadManifest
} from '@printstream/shared'
import { Readable } from 'node:stream'

export class SliceUploadFrameError extends Error {}

export interface FramedSliceUpload {
  envelope: SliceEnvelope
  source: Readable
  /** Source-project length derived from Content-Length, or null for chunked uploads. */
  declaredSourceLength: number | null
}

/** Decode a PSL2 request body and restore raw assets into their custom machine profile. */
export async function readFramedSliceUpload(
  request: Readable,
  declaredBodyLength: number | null
): Promise<FramedSliceUpload> {
  const iterator = request[Symbol.asyncIterator]()
  let buffered = Buffer.alloc(0)

  const take = async (length: number): Promise<Buffer> => {
    while (buffered.byteLength < length) {
      const next = await iterator.next()
      if (next.done) throw new SliceUploadFrameError('Slice upload ended before its declared frame was complete')
      buffered = Buffer.concat([buffered, Buffer.from(next.value)])
    }
    const value = buffered.subarray(0, length)
    buffered = buffered.subarray(length)
    return value
  }

  const header = await take(SLICE_UPLOAD_FRAME_HEADER_BYTES)
  if (header.subarray(0, 4).toString('ascii') !== SLICE_UPLOAD_FRAME_MAGIC) {
    throw new SliceUploadFrameError('Slice upload has an unsupported framing format')
  }
  const manifestLength = header.readUInt32BE(4)
  if (manifestLength <= 0 || manifestLength > MAX_SLICE_UPLOAD_MANIFEST_BYTES) {
    throw new SliceUploadFrameError('Slice upload manifest exceeds the configured size limit')
  }

  let manifestInput: unknown
  try {
    manifestInput = JSON.parse((await take(manifestLength)).toString('utf8'))
  } catch {
    throw new SliceUploadFrameError('Slice upload manifest is not valid JSON')
  }
  const parsed = sliceUploadManifestSchema.safeParse(manifestInput)
  if (!parsed.success) {
    throw new SliceUploadFrameError(parsed.error.issues[0]?.message ?? 'Slice upload manifest is invalid')
  }

  const assetPayloads: Buffer[] = []
  for (const descriptor of parsed.data.bedAssets) {
    assetPayloads.push(await take(descriptor.byteLength))
  }
  const envelope = restorePortableBedAssets(parsed.data, assetPayloads)
  const prefixLength = SLICE_UPLOAD_FRAME_HEADER_BYTES
    + manifestLength
    + parsed.data.bedAssets.reduce((total, asset) => total + asset.byteLength, 0)
  const declaredSourceLength = declaredBodyLength == null ? null : declaredBodyLength - prefixLength
  if (declaredSourceLength !== null && declaredSourceLength < 0) {
    throw new SliceUploadFrameError('Slice upload Content-Length is smaller than its declared frame')
  }

  async function* sourceChunks(): AsyncGenerator<Buffer> {
    if (buffered.byteLength > 0) yield buffered
    while (true) {
      const next = await iterator.next()
      if (next.done) return
      yield Buffer.from(next.value)
    }
  }

  return {
    envelope,
    source: Readable.from(sourceChunks()),
    declaredSourceLength
  }
}

/** Put raw transfer payloads back into the in-memory preset shape the materializer already owns. */
function restorePortableBedAssets(manifest: SliceUploadManifest, payloads: Buffer[]): SliceEnvelope {
  const configs = new Map<string, ProcessConfig>()
  const profiles = [...(manifest.envelope.profileFiles ?? [])]

  manifest.bedAssets.forEach((descriptor, index) => {
    const profileIndex = profiles.findIndex((profile) => (
      profile.id === descriptor.profileId
      && profile.kind === 'machine'
      && profile.source === 'custom'
      && typeof profile.content === 'string'
    ))
    if (profileIndex < 0) {
      throw new SliceUploadFrameError('Slice upload references a missing custom machine profile')
    }
    const profile = profiles[profileIndex]!
    let config = configs.get(profile.id)
    if (!config) {
      try {
        config = JSON.parse(profile.content!) as ProcessConfig
      } catch {
        throw new SliceUploadFrameError('Slice upload contains malformed machine profile JSON')
      }
    }
    config = setPortableMachineBedAsset(config, descriptor.kind, {
      name: descriptor.name,
      bytes: payloads[index]!
    })
    configs.set(profile.id, config)
    profiles[profileIndex] = { ...profile, content: JSON.stringify(config) }
  })

  return { ...manifest.envelope, profileFiles: profiles }
}
