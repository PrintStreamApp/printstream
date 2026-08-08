/**
 * The one parser for `CLIENT_ORIGIN` (comma-separated browser origins). Owns
 * the two readings every consumer needs — the full allow-list and the single
 * canonical origin — so "primary" means the same thing everywhere: the FIRST
 * entry, matching the precedence the WebAuthn relying party derives its id
 * from. Do not split `env.CLIENT_ORIGIN` inline elsewhere.
 */
import { env } from './env.js'

/** All configured browser origins, trimmed, in declaration order. */
export function clientOrigins(): string[] {
  return env.CLIENT_ORIGIN.split(',').map((value) => value.trim()).filter(Boolean)
}

/**
 * The deployment's canonical browser origin (the first `CLIENT_ORIGIN` entry).
 * Throws when none is configured — every caller needs a real origin (WebAuthn
 * relying party, OAuth redirects, checkout URLs), so a loud failure beats a
 * silently wrong `localhost`.
 */
export function primaryClientOrigin(): string {
  const first = clientOrigins()[0]
  if (!first) throw new Error('CLIENT_ORIGIN must include at least one origin.')
  return first
}
