/**
 * Turns a picked preset file into the `UploadSlicingProfile` body.
 *
 * `.json` presets go up as text so the server sees them exactly as BambuStudio wrote them;
 * everything else (`.bbscfg`, `.bbsflmt`, `.zip`) is binary and is base64-encoded.
 */
import type { UploadSlicingProfile } from '@printstream/shared'

export async function buildSlicingProfileUpload(file: File, overwrite = false): Promise<UploadSlicingProfile> {
  if (file.name.toLowerCase().endsWith('.json')) {
    return { fileName: file.name, encoding: 'utf8', content: await file.text(), overwrite }
  }
  return {
    fileName: file.name,
    encoding: 'base64',
    content: encodeFileBase64(new Uint8Array(await file.arrayBuffer())),
    overwrite
  }
}

function encodeFileBase64(bytes: Uint8Array): string {
  let binary = ''
  // Chunked because String.fromCharCode is applied to the whole slice at once and blows the
  // argument limit on a multi-megabyte preset zip.
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return btoa(binary)
}
