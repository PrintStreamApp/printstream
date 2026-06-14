/**
 * Bridge runtime credentials.
 *
 * Connect codes are short-lived pairing secrets shown to tenant admins.
 * Runtime tokens are long-lived machine credentials stored hashed in
 * the database and presented by the bridge process on reconnect.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const CONNECT_CODE_BYTES = 6
const RUNTIME_TOKEN_BYTES = 24

export function createBridgeConnectCode(): string {
  return randomBytes(CONNECT_CODE_BYTES).toString('hex')
}

export function createBridgeRuntimeToken(): string {
  return randomBytes(RUNTIME_TOKEN_BYTES).toString('base64url')
}

export function hashBridgeRuntimeToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function bridgeRuntimeTokenMatches(token: string, expectedHash: string | null | undefined): boolean {
  if (!expectedHash) return false
  const candidate = Buffer.from(hashBridgeRuntimeToken(token), 'utf8')
  const expected = Buffer.from(expectedHash, 'utf8')
  if (candidate.length !== expected.length) return false
  return timingSafeEqual(candidate, expected)
}