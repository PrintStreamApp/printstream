/**
 * Empty means unset, for every variable.
 *
 * The bug this pins: `PLATFORM_ADMIN_EMAIL` was declared as a plain
 * `.email().optional()`, so an EMPTY value reached the email check and failed —
 * and env parsing runs at module load, so the failure killed the API process
 * before it could log anything useful. Empty is not a hypothetical input here:
 * the compose files map env as `VAR: ${VAR:-}`, which passes an empty string
 * when the `.env` line is missing, so the most likely operator mistake on a
 * fresh cloud deploy crash-looped the container instead of reaching the
 * deployment's own "set this to claim the platform admin" refusal.
 *
 * These assert the RULE rather than one variable, because the rule is what has
 * to hold for the tenth one somebody adds.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'

/** Mirrors `trimmedEnv` in `env.ts`; kept here so the rule can be asserted in isolation. */
function trimmedEnv<Schema extends z.ZodTypeAny>(schema: Schema) {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value
    const trimmed = value.trim()
    return trimmed.length === 0 ? undefined : trimmed
  }, schema)
}

test('an empty or whitespace value reads as unset, not as an invalid one', () => {
  const email = trimmedEnv(z.string().email().optional())
  for (const value of ['', '   ', '\t\n']) {
    const parsed = email.safeParse(value)
    assert.equal(parsed.success, true, `${JSON.stringify(value)} must parse`)
    assert.equal(parsed.success && parsed.data, undefined)
  }
})

test('a real value still has to be valid', () => {
  const email = trimmedEnv(z.string().email().optional())
  assert.equal(email.safeParse('not-an-email').success, false)
  assert.equal(email.safeParse('  admin@example.com  ').success && email.parse('  admin@example.com  '), 'admin@example.com')
})

test('the rule holds for defaulted values too — empty falls back to the default', () => {
  const origin = trimmedEnv(z.string().default('http://localhost:5173'))
  assert.equal(origin.parse(''), 'http://localhost:5173')
  assert.equal(origin.parse(undefined), 'http://localhost:5173')
  assert.equal(origin.parse('https://app.example.com'), 'https://app.example.com')
})

test('the real PLATFORM_ADMIN_EMAIL declaration accepts an empty value', async () => {
  // The control: proves the module under test is wired the way the unit rule
  // above describes, rather than the rule passing in isolation while the real
  // schema still crashes.
  process.env.PLATFORM_ADMIN_EMAIL = ''
  const { env } = await import('./env.js')
  assert.equal(env.PLATFORM_ADMIN_EMAIL, undefined)
})
