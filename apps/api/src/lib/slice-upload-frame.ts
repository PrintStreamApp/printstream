/**
 * Builds the streamed API-to-slicer upload body.
 *
 * The body is `PSL2`, a uint32 manifest length, the JSON manifest, raw custom-bed payloads in
 * descriptor order, then the source 3MF. Keeping the binary payloads outside the JSON avoids both
 * base64 expansion and the HTTP header ceiling while preserving one streaming request.
 */
import {
  MAX_SLICE_UPLOAD_MANIFEST_BYTES,
  portableMachineBedAssetBytes,
  SLICE_UPLOAD_FRAME_HEADER_BYTES,
  SLICE_UPLOAD_FRAME_MAGIC,
  sliceUploadManifestSchema,
  stripPortableMachineBedAssetPayloads,
  type ProcessConfig,
  type SliceEnvelope,
  type SliceUploadBedAsset,
  type SliceUploadManifest
} from '@printstream/shared'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'

export interface SliceUploadFrame {
  /** Complete request-body byte count, including the source project. */
  contentLength: number
  /** Stream the frame prefix, raw assets, and source project without buffering the project. */
  body: Readable
}

/** Extract portable payloads from custom machine profiles and construct one framed upload. */
export function buildSliceUploadFrame(
  envelope: SliceEnvelope,
  sourcePath: string,
  sourceSize: number
): SliceUploadFrame {
  const bedAssets: SliceUploadBedAsset[] = []
  const assetBytes: Buffer[] = []
  const profileFiles = (envelope.profileFiles ?? []).map((profile) => {
    if (profile.kind !== 'machine' || profile.source !== 'custom' || !profile.content) return profile

    let config: ProcessConfig
    try {
      config = JSON.parse(profile.content) as ProcessConfig
    } catch {
      // Profile materialization owns the user-facing malformed-JSON failure. Leave it untouched so
      // this transport layer does not invent a different validation contract.
      return profile
    }

    for (const kind of ['model', 'texture'] as const) {
      const asset = portableMachineBedAssetBytes(config, kind)
      if (!asset) continue
      const bytes = Buffer.from(asset.bytes)
      bedAssets.push({
        profileId: profile.id,
        kind,
        name: asset.name,
        byteLength: bytes.byteLength
      })
      assetBytes.push(bytes)
    }

    return bedAssets.some((asset) => asset.profileId === profile.id)
      ? { ...profile, content: JSON.stringify(stripPortableMachineBedAssetPayloads(config)) }
      : profile
  })

  const manifest: SliceUploadManifest = sliceUploadManifestSchema.parse({
    envelope: { ...envelope, profileFiles },
    bedAssets
  })
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8')
  if (manifestBytes.byteLength > MAX_SLICE_UPLOAD_MANIFEST_BYTES) {
    throw new Error('Slice request metadata exceeds the configured size limit')
  }

  const header = Buffer.alloc(SLICE_UPLOAD_FRAME_HEADER_BYTES)
  header.write(SLICE_UPLOAD_FRAME_MAGIC, 0, 'ascii')
  header.writeUInt32BE(manifestBytes.byteLength, 4)
  const prefixSize = header.byteLength
    + manifestBytes.byteLength
    + assetBytes.reduce((total, bytes) => total + bytes.byteLength, 0)

  async function* chunks(): AsyncGenerator<Buffer> {
    yield header
    yield manifestBytes
    for (const bytes of assetBytes) yield bytes
    for await (const chunk of createReadStream(sourcePath)) yield Buffer.from(chunk)
  }

  return {
    contentLength: prefixSize + sourceSize,
    body: Readable.from(chunks())
  }
}
