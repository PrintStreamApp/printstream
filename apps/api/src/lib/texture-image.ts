/**
 * Server-side texture decoding for model imports.
 *
 * The shared sampler accepts only decoded RGBA pixels. This host adapter recognizes the same PNG
 * and JPEG resources the browser path accepts, rejects implausible dimensions before PNG decoding,
 * and caps jpeg-js's allocator so an authenticated import cannot turn a small compressed image into
 * unbounded process memory.
 */
import jpeg from 'jpeg-js'
import { PNG } from 'pngjs'

import { MAX_MODEL_TEXTURE_PIXELS, ModelImportError, type DecodedTextureImage } from '@printstream/shared/three-mf'

/** Decode one supported texture resource into row-major RGBA pixels. */
export function decodeTextureImage(name: string, bytes: Uint8Array): DecodedTextureImage {
  const extension = name.toLowerCase().split('.').pop()
  if (extension === 'png') {
    assertPngDimensions(bytes)
    const decoded = PNG.sync.read(Buffer.from(bytes))
    assertPixelCount(decoded.width, decoded.height)
    return { width: decoded.width, height: decoded.height, rgba: new Uint8Array(decoded.data) }
  }
  if (extension === 'jpg' || extension === 'jpeg') {
    try {
      const decoded = jpeg.decode(bytes, {
        useTArray: true,
        formatAsRGBA: true,
        maxMemoryUsageInMB: 192,
        maxResolutionInMP: MAX_MODEL_TEXTURE_PIXELS / 1_000_000
      })
      assertPixelCount(decoded.width, decoded.height)
      return { width: decoded.width, height: decoded.height, rgba: new Uint8Array(decoded.data) }
    } catch (error) {
      if (error instanceof ModelImportError) throw error
      throw new ModelImportError(`Texture ${name} could not be decoded`)
    }
  }
  throw new ModelImportError(`Texture ${name} must be PNG or JPEG`)
}

function assertPngDimensions(bytes: Uint8Array): void {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    throw new ModelImportError('Texture is not a readable PNG')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  assertPixelCount(view.getUint32(16), view.getUint32(20))
}

function assertPixelCount(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_MODEL_TEXTURE_PIXELS) {
    throw new ModelImportError('Texture dimensions are too large to import')
  }
}
