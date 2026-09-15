import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { readProductChangelog } from './product-changelog.mjs'

function fixture(version, releases) {
  const root = mkdtempSync(path.join(tmpdir(), 'printstream-changelog-'))
  mkdirSync(path.join(root, 'apps', 'web', 'src'), { recursive: true })
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }))
  writeFileSync(path.join(root, 'apps', 'web', 'package.json'), JSON.stringify({ version }))
  writeFileSync(path.join(root, 'apps', 'web', 'src', 'product-changelog.json'), JSON.stringify({ releases }))
  return root
}

const RELEASE = {
  version: '1.2.3',
  releasedOn: '2026-09-13',
  changes: ['Added release notes.']
}

test('accepts a current release entry in release mode', () => {
  assert.deepEqual(readProductChangelog(fixture('1.2.3', [RELEASE]), { requireCurrent: true }), [RELEASE])
})

test('permits the initial empty catalogue outside a release', () => {
  assert.deepEqual(readProductChangelog(fixture('1.2.3', [])), [])
})

test('release mode requires the newest entry to match the product version', () => {
  assert.throws(
    () => readProductChangelog(fixture('1.2.4', [RELEASE]), { requireCurrent: true }),
    /must start with the release being published, 1\.2\.4/
  )
})

test('rejects malformed entries', () => {
  assert.throws(() => readProductChangelog(fixture('1.2.3', [{ ...RELEASE, releasedOn: '2026-02-30' }])), /invalid releasedOn/)
  assert.throws(() => readProductChangelog(fixture('1.2.3', [{ ...RELEASE, changes: [] }])), /at least one/)
  assert.throws(() => readProductChangelog(fixture('1.2.3', [RELEASE, RELEASE])), /repeats version/)
  assert.throws(
    () => readProductChangelog(fixture('1.2.3', [
      { ...RELEASE, version: '1.2.2' },
      RELEASE
    ])),
    /newest first/
  )
  assert.throws(
    () => readProductChangelog(fixture('1.2.3', [{ ...RELEASE, version: '1.2.3-01' }])),
    /invalid SemVer/
  )
  assert.throws(
    () => readProductChangelog(fixture('1.2.3', [{ ...RELEASE, changes: ['First line\nsecond line'] }])),
    /fit on one line/
  )
})
