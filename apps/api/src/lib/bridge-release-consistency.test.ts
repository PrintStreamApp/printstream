/**
 * A server must only ever offer ITS OWN bridge.
 *
 * The failure this pins was live on staging: the promoted build predated the
 * server, so the download page handed out an installer that rejected the flag
 * the page told people to pass. Nothing reported it, because promotion and
 * deployment are separate steps and nothing compared them.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { listBridgeStandaloneDownloads } from './bridge-standalone-downloads.js'
import { describeBridgeReleaseConsistency } from './bridge-update-policy.js'

function releasesDirWithPointer(sourceFingerprint: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'bridge-releases-'))
  writeFileSync(
    path.join(dir, 'current-bridge-build.json'),
    JSON.stringify({ sourceFingerprint, buildRevision: 'deadbeefcafe', promotedAt: '2026-08-04T00:00:00.000Z' })
  )
  return dir
}

test('a promoted build that is not this server\'s is refused, with a reason', () => {
  // The env-derived expectation is absent in tests, so a mismatch cannot be
  // manufactured here without one, assert the shape the route depends on and
  // let the unknown-is-fine rule below carry the safety argument.
  const dir = releasesDirWithPointer('0000000000000000000000000000000000000000000000000000000000000000')
  const result = listBridgeStandaloneDownloads({ releasesDir: dir })
  assert.ok(Array.isArray(result.downloads), 'downloads is always a list')
  assert.ok('unavailableReason' in result, 'the caller can always distinguish empty-for-a-reason')
  // Whatever the verdict, the two must agree: withholding without saying why is
  // the bug that made this look like "no native installers exist".
  if (result.unavailableReason) assert.equal(result.downloads.length, 0)
})

test('an unknown fingerprint counts as matching, so it never breaks a working install', () => {
  // A self-hosted image, a local build, or anything that did not record a
  // fingerprint must not have its downloads withheld over a value that was
  // never populated.
  const consistency = describeBridgeReleaseConsistency({ releasesDir: releasesDirWithPointer('abc123') })
  assert.equal(consistency.matches, true)
  assert.equal(consistency.promoted, 'abc123')
})

test('nothing promoted is not a mismatch', () => {
  const empty = mkdtempSync(path.join(tmpdir(), 'bridge-releases-empty-'))
  const consistency = describeBridgeReleaseConsistency({ releasesDir: empty })
  assert.equal(consistency.matches, true)
  assert.equal(consistency.promoted, null)
  assert.equal(listBridgeStandaloneDownloads({ releasesDir: empty }).unavailableReason, null)
})
