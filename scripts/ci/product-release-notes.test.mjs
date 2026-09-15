import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { renderProductReleaseNotes } from './product-release-notes.mjs'

function fixture(releases) {
  const root = mkdtempSync(path.join(tmpdir(), 'printstream-release-notes-'))
  mkdirSync(path.join(root, 'apps', 'web', 'src'), { recursive: true })
  writeFileSync(path.join(root, 'apps', 'web', 'src', 'product-changelog.json'), JSON.stringify({ releases }))
  return root
}

test('renders the approved changes for the requested version', () => {
  const root = fixture([
    {
      version: '1.2.4',
      releasedOn: '2026-09-13',
      changes: ['Added release notes.', 'Improved printer controls.']
    },
    {
      version: '1.2.3',
      releasedOn: '2026-09-12',
      changes: ['Added another feature.']
    }
  ])

  assert.equal(
    renderProductReleaseNotes('1.2.3', root),
    "## What's new\n\n- Added another feature.\n"
  )
})

test('fails when the requested version has no approved entry', () => {
  const root = fixture([])
  assert.throws(
    () => renderProductReleaseNotes('1.2.3', root),
    /no approved entry for 1\.2\.3/
  )
})
