/**
 * Password hashing for the `auth-password` provider.
 *
 * Hashes are algorithm-tagged so multiple backends coexist and upgrade in place:
 * - **argon2id** (preferred) via `@node-rs/argon2` — OWASP-recommended params.
 *   Produces the standard `$argon2id$v=19$m=...` PHC string.
 * - **scrypt** (`node:crypto`) fallback for environments where the native argon2
 *   addon can't load (notably the single-file SEA build, where a `.node` binary
 *   can't be embedded). Encoded as `scrypt$N=..,r=..,p=..$<saltB64>$<hashB64>`.
 *
 * On sign-in, `needsRehash` lets the caller transparently re-hash a credential
 * with the preferred backend. Verification is always constant-time and never
 * throws — any parse/format error returns `false`.
 */
import crypto from 'node:crypto'
import { promisify } from 'node:util'

// Bind the options-taking overload of scrypt (the bare promisify picks the
// 3-argument signature, which would reject our cost parameters).
const scryptAsync = promisify<crypto.BinaryLike, crypto.BinaryLike, number, crypto.ScryptOptions, Buffer>(crypto.scrypt)

// OWASP argon2id baseline (19 MiB, 2 iterations, single lane).
const ARGON2_MEMORY_COST = 19456
const ARGON2_TIME_COST = 2
const ARGON2_PARALLELISM = 1

// scrypt fallback parameters. Memory use is ~128 * N * r bytes (= 32 MiB here);
// maxmem is set well above that so the derivation never trips Node's default cap.
const SCRYPT_PREFIX = 'scrypt'
const SCRYPT_N = 32768
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEYLEN = 64
const SCRYPT_SALT_BYTES = 16
const SCRYPT_MAXMEM = 256 * 1024 * 1024

type Argon2Module = typeof import('@node-rs/argon2')

let argon2Promise: Promise<Argon2Module | null> | undefined

/** Loads the optional native argon2 addon once; resolves null when unavailable. */
async function loadArgon2(): Promise<Argon2Module | null> {
  if (!argon2Promise) {
    argon2Promise = import('@node-rs/argon2').catch(() => null)
  }
  return argon2Promise
}

/** Hashes a plaintext password with the preferred available backend. */
export async function hashPassword(plain: string): Promise<string> {
  const argon2 = await loadArgon2()
  if (argon2) {
    // `@node-rs/argon2` defaults to Argon2id; the const-enum member can't be
    // referenced under isolatedModules, so we rely on that default.
    return await argon2.hash(plain, {
      memoryCost: ARGON2_MEMORY_COST,
      timeCost: ARGON2_TIME_COST,
      parallelism: ARGON2_PARALLELISM
    })
  }
  return await hashPasswordWithScrypt(plain)
}

/** Constant-time verification of a plaintext password against a stored hash. */
export async function verifyPassword(stored: string, plain: string): Promise<boolean> {
  try {
    if (stored.startsWith('$argon2')) {
      const argon2 = await loadArgon2()
      if (!argon2) return false
      return await argon2.verify(stored, plain)
    }
    if (stored.startsWith(`${SCRYPT_PREFIX}$`)) {
      return await scryptVerify(stored, plain)
    }
    return false
  } catch {
    return false
  }
}

/**
 * Whether a stored hash should be re-hashed with the preferred backend on the
 * next successful sign-in. We upgrade scrypt → argon2id when the native addon is
 * available; an existing argon2id hash is never downgraded to scrypt.
 */
export async function needsRehash(stored: string): Promise<boolean> {
  const argon2 = await loadArgon2()
  if (argon2) return !stored.startsWith('$argon2')
  return false
}

/** Exposed for tests so the SEA fallback path can be exercised directly. */
export async function hashPasswordWithScrypt(plain: string): Promise<string> {
  const salt = crypto.randomBytes(SCRYPT_SALT_BYTES)
  const derived = (await scryptAsync(plain, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM
  })) as Buffer
  return `${SCRYPT_PREFIX}$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${salt.toString('base64')}$${derived.toString('base64')}`
}

async function scryptVerify(stored: string, plain: string): Promise<boolean> {
  const parsed = parseScrypt(stored)
  if (!parsed) return false
  const derived = (await scryptAsync(plain, parsed.salt, parsed.hash.length, {
    N: parsed.n,
    r: parsed.r,
    p: parsed.p,
    maxmem: SCRYPT_MAXMEM
  })) as Buffer
  return derived.length === parsed.hash.length && crypto.timingSafeEqual(derived, parsed.hash)
}

interface ParsedScrypt {
  n: number
  r: number
  p: number
  salt: Buffer
  hash: Buffer
}

function parseScrypt(stored: string): ParsedScrypt | null {
  const [prefix, paramString, saltB64, hashB64] = stored.split('$')
  if (prefix !== SCRYPT_PREFIX || !paramString || !saltB64 || !hashB64) return null
  const params = new Map(
    paramString.split(',').map((pair) => {
      const [key, value] = pair.split('=')
      return [key, Number.parseInt(value ?? '', 10)] as const
    })
  )
  const n = params.get('N')
  const r = params.get('r')
  const p = params.get('p')
  if (!n || !r || !p) return null
  return {
    n,
    r,
    p,
    salt: Buffer.from(saltB64, 'base64'),
    hash: Buffer.from(hashB64, 'base64')
  }
}
