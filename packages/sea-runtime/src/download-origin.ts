/**
 * Which PrintStream server a downloaded single-file app came FROM.
 *
 * For a SEA distribution whose job is to CONNECT somewhere: one artifact is
 * served to every environment, so the binary carries a baked default that is
 * right for the cloud and wrong everywhere else, and nothing it receives later
 * can correct it. The bridge is that case, it registers with a server before
 * it holds anything signed.
 *
 * The self-hosted server app deliberately does NOT use this. Its equivalent
 * question (which deployment licenses this install) is answered by a signed
 * field inside the licence key itself, which beats any inference from where the
 * installer was fetched. Prefer that shape wherever an artifact exists to carry
 * it; this is the fallback for when none does.
 *
 * This half is Windows' Mark of the Web (`Zone.Identifier:HostUrl`), and it is
 * genuinely best-effort, notably NOT durable, because a guided install deletes
 * the mark before elevating (SmartScreen refuses to elevate a marked
 * executable), so it is gone by the second attempt. Callers read the stamped
 * FILENAME first, which survives that; the filename codec lives in
 * `@printstream/shared` because the SERVER side has to write what the app reads,
 * and this package deliberately has no dependencies.
 *
 * Null is the ordinary answer for a cloud download or a locally built binary.
 * The caller then keeps its baked default, which is the behaviour that predates
 * this module, so provenance can only ever add accuracy, never break an install.
 */
import { readFileSync } from 'node:fs'

/** Keys that carry a source URL in a Zone.Identifier stream, in order of trust. */
const URL_KEYS = ['HostUrl', 'ReferrerUrl'] as const

/**
 * The origin recorded in Windows' Mark of the Web, or null.
 *
 * Non-Windows returns null without touching the disk: the stream is an NTFS
 * feature, and those platforms install from a terminal where an explicit flag is
 * available anyway.
 */
export function readMarkOfTheWebOrigin(executablePath: string): string | null {
  if (process.platform !== 'win32') return null
  let raw: string
  try {
    // Reading the stream of a file that has none throws ENOENT; that is the
    // ordinary case for a locally-built or unblocked binary, not an error.
    raw = readFileSync(`${executablePath}:Zone.Identifier`, 'utf8')
  } catch {
    return null
  }
  return parseMarkOfTheWeb(raw)
}

/** Exported for tests: the parse half, with no filesystem involved. */
export function parseMarkOfTheWeb(zoneIdentifier: string): string | null {
  const values = new Map<string, string>()
  for (const line of zoneIdentifier.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z]+)\s*=\s*(.+?)\s*$/.exec(line)
    if (match?.[1] && match[2]) values.set(match[1], match[2])
  }
  for (const key of URL_KEYS) {
    const candidate = values.get(key)
    if (!candidate) continue
    const origin = toHttpOrigin(candidate)
    if (origin) return origin
  }
  return null
}

/**
 * The origin of an http(s) URL, or null for anything else.
 *
 * Schemes are filtered rather than trusted: the stream is written by whatever
 * fetched the file, so a `file:`/`about:` value is entirely possible, and
 * feeding one downstream would fail in a way that pointed at the wrong problem.
 */
function toHttpOrigin(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.origin
  } catch {
    return null
  }
}
