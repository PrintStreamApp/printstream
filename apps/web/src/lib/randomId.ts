/**
 * UUID generation that works outside secure contexts.
 *
 * `crypto.randomUUID` only exists in secure contexts (HTTPS or localhost), so
 * on a self-hosted install served over plain HTTP on a LAN IP it is simply
 * absent and calling it throws "crypto.randomUUID is not a function".
 * `crypto.getRandomValues` has no such restriction, so fall back to
 * assembling an RFC 4122 v4 UUID from it. The last-resort Math.random path
 * only exists for exotic environments with no WebCrypto at all — these ids
 * key client-side drafts and editor instances, not anything security-bearing.
 */
export function randomUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join('')
  ].join('-')
}
