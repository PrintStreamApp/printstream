import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LicenseStatus } from '@printstream/shared'
import {
  computeLicenseMode,
  getFirstRunAt,
  licenseSatisfies,
  NATIVE_EVALUATION_DAYS,
  SELF_HOSTED_GRACE_DAYS
} from './license-enforcement.js'
import { rootPrisma } from './prisma.js'
import { usePrismaStubs } from '../test-utils/prisma-stubs.js'

const DAY_MS = 24 * 60 * 60 * 1000
const firstRunAt = new Date('2026-07-01T00:00:00Z')

function status(overrides: Partial<LicenseStatus> = {}): LicenseStatus {
  return {
    edition: 'commercial',
    licensee: 'Acme Corp',
    valid: true,
    expired: false,
    expiresAt: null,
    updatesExpired: false,
    updatesUntil: null,
    maxPrinters: null,
    metered: false,
    ...overrides
  }
}

test('the cloud is never enforced, however old the install', () => {
  const result = computeLicenseMode({
    enforced: false,
    native: false,
    licensed: false,
    firstRunAt,
    now: new Date(firstRunAt.getTime() + 400 * DAY_MS)
  })
  assert.deepEqual(result, { mode: 'unrestricted', graceEndsAt: null })
})

test('a satisfying license unlocks fully, regardless of age', () => {
  const result = computeLicenseMode({
    enforced: true,
    native: true,
    licensed: true,
    firstRunAt,
    now: new Date(firstRunAt.getTime() + 400 * DAY_MS)
  })
  assert.deepEqual(result, { mode: 'unrestricted', graceEndsAt: null })
})

test('native runs a 14-day evaluation window, then limits', () => {
  const insideGrace = computeLicenseMode({
    enforced: true,
    native: true,
    licensed: false,
    firstRunAt,
    now: new Date(firstRunAt.getTime() + (NATIVE_EVALUATION_DAYS - 1) * DAY_MS)
  })
  assert.equal(insideGrace.mode, 'evaluation')
  assert.equal(insideGrace.graceEndsAt?.getTime(), firstRunAt.getTime() + NATIVE_EVALUATION_DAYS * DAY_MS)

  const pastGrace = computeLicenseMode({
    enforced: true,
    native: true,
    licensed: false,
    firstRunAt,
    now: new Date(firstRunAt.getTime() + (NATIVE_EVALUATION_DAYS + 1) * DAY_MS)
  })
  assert.equal(pastGrace.mode, 'limited')
})

test('Docker/OSS gets the longer grace window: the requirement is new there', () => {
  const stillFine = computeLicenseMode({
    enforced: true,
    native: false,
    licensed: false,
    firstRunAt,
    now: new Date(firstRunAt.getTime() + (NATIVE_EVALUATION_DAYS + 1) * DAY_MS)
  })
  assert.equal(stillFine.mode, 'evaluation')
  assert.equal(stillFine.graceEndsAt?.getTime(), firstRunAt.getTime() + SELF_HOSTED_GRACE_DAYS * DAY_MS)

  const pastGrace = computeLicenseMode({
    enforced: true,
    native: false,
    licensed: false,
    firstRunAt,
    now: new Date(firstRunAt.getTime() + (SELF_HOSTED_GRACE_DAYS + 1) * DAY_MS)
  })
  assert.equal(pastGrace.mode, 'limited')
})

test('a community key clears Docker/OSS but not the native app', () => {
  const community = status({ edition: 'community' })
  assert.equal(licenseSatisfies(community, false), true)
  assert.equal(licenseSatisfies(community, true), false)
})

test('a commercial key clears both builds', () => {
  assert.equal(licenseSatisfies(status(), false), true)
  assert.equal(licenseSatisfies(status(), true), true)
})

test('an expired key satisfies nothing, a lapsed subscription must stop working', () => {
  const lapsed = status({ valid: false, expired: true, expiresAt: 1_700_000_000 })
  assert.equal(licenseSatisfies(lapsed, false), false)
  assert.equal(licenseSatisfies(lapsed, true), false)
})

test('lapsed updates do not affect the right to run', () => {
  const updatesLapsed = status({ updatesExpired: true, updatesUntil: 1_700_000_000 })
  assert.equal(licenseSatisfies(updatesLapsed, true), true)
})

test('an absent key satisfies nothing', () => {
  assert.equal(licenseSatisfies(status({ edition: null, valid: false }), false), false)
})

// --- The upgrade path: what happens to installs that already exist ---
//
// This is the release-risk half of enforcement. The grace math above is pure and
// easy; the question that decides whether a running self-hoster keeps working is
// which DATE the window is measured from, and that lives in a Setting row.

const stub = usePrismaStubs()

/** Records upserts so a test can assert what was stamped, not just what was returned. */
function stubSettings(rows: Record<string, string>) {
  const upserts: Array<{ key: string; value: string }> = []
  stub(rootPrisma.setting, 'findUnique', (async (args: { where: { key: string } }) =>
    rows[args.where.key] != null ? { key: args.where.key, value: rows[args.where.key] } : null) as never)
  stub(rootPrisma.setting, 'upsert', (async (args: { create: { key: string; value: string } }) => {
    upserts.push(args.create)
    rows[args.create.key] ??= args.create.value
    return args.create
  }) as never)
  return upserts
}

test('a Docker/OSS install upgrading into enforcement is dated from the upgrade', async () => {
  // Enforcement was native-only before, so this path never ran on Docker and no
  // stamp exists. If an absent stamp were treated as "long ago", every existing
  // self-hoster would land straight in `limited` on the release that introduces
  // the requirement: locked out before being told.
  const before = Date.now()
  const upserts = stubSettings({})
  const firstRun = await getFirstRunAt()

  assert.ok(firstRun.getTime() >= before, 'an unstamped install starts its window now')
  assert.equal(upserts.length, 1, 'the stamp is persisted so the window cannot restart on reboot')
  const { mode } = computeLicenseMode({
    enforced: true, native: false, licensed: false, firstRunAt: firstRun, now: new Date()
  })
  assert.equal(mode, 'evaluation', 'it upgrades into grace, never straight into limited')
})

test('an existing native install keeps its original clock across the rename', async () => {
  // The legacy key is adopted forward rather than re-stamped: a native install
  // months past its evaluation must not be handed a fresh 14 days by a rename.
  const legacy = '2026-01-01T00:00:00.000Z'
  const upserts = stubSettings({ [`platform:license.nativeFirstRunAt`]: legacy })

  assert.equal((await getFirstRunAt()).toISOString(), legacy)
  assert.deepEqual(upserts, [{ key: 'platform:license.firstRunAt', value: legacy }],
    'carried forward under the new key, preserving the original date')
})

test('the current stamp wins over the legacy one', async () => {
  const current = '2026-05-05T00:00:00.000Z'
  stubSettings({
    [`platform:license.firstRunAt`]: current,
    [`platform:license.nativeFirstRunAt`]: '2026-01-01T00:00:00.000Z'
  })
  assert.equal((await getFirstRunAt()).toISOString(), current)
})
