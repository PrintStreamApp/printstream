/** Browser image decoding adapter for imported model textures. */
import { MAX_MODEL_TEXTURE_PIXELS, ModelImportError, type DecodedTextureImage } from '@printstream/shared/three-mf'

/** Decode PNG or JPEG bytes with the browser's native codec, in either a worker or the page. */
export async function decodeTextureImage(name: string, bytes: Uint8Array): Promise<DecodedTextureImage> {
  const extension = name.toLowerCase().split('.').pop()
  const mime = extension === 'png' ? 'image/png' : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : null
  if (!mime) throw new ModelImportError(`Texture ${name} must be PNG or JPEG`)

  let bitmap: ImageBitmap
  try {
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    bitmap = await createImageBitmap(new Blob([copy.buffer], { type: mime }), {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none'
    })
  } catch {
    throw new ModelImportError(`Texture ${name} could not be decoded`)
  }
  try {
    if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width * bitmap.height > MAX_MODEL_TEXTURE_PIXELS) {
      throw new ModelImportError('Texture dimensions are too large to import')
    }
    const canvas = makeCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d')
    if (!context) throw new ModelImportError(`Texture ${name} could not be decoded`)
    context.drawImage(bitmap, 0, 0)
    return {
      width: bitmap.width,
      height: bitmap.height,
      rgba: new Uint8Array(context.getImageData(0, 0, bitmap.width, bitmap.height).data)
    }
  } finally {
    bitmap.close()
  }
}

function makeCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height)
  if (typeof document === 'undefined') throw new ModelImportError('This browser cannot decode model textures')
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}
