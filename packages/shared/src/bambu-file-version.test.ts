import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatBambuVersion, isProjectNewerThanSlicer, parseBambuMajorMinor } from './bambu-file-version.js'

test('parses both the zero-padded 3MF form and the plain target form', () => {
  assert.deepEqual(parseBambuMajorMinor('02.08.00.50'), { major: 2, minor: 8 })
  assert.deepEqual(parseBambuMajorMinor('2.7.1.62'), { major: 2, minor: 7 })
  assert.equal(parseBambuMajorMinor('not a version'), null)
  assert.equal(parseBambuMajorMinor(null), null)
})

test('compares major.minor only, exactly as BambuStudio does', () => {
  // The real case: a 2.8.0.50 project refused by a 2.7.1.62 engine (exit 232).
  assert.equal(isProjectNewerThanSlicer('02.08.00.50', '2.7.1.62'), true)
  // Patch and build are IGNORED by the engine's check, so a higher patch is not "newer".
  assert.equal(isProjectNewerThanSlicer('02.07.09.99', '2.7.1.62'), false)
  assert.equal(isProjectNewerThanSlicer('02.07.01.62', '2.7.1.62'), false)
  // Older projects are always fine.
  assert.equal(isProjectNewerThanSlicer('01.09.05.51', '2.7.1.62'), false)
  // Major dominates minor.
  assert.equal(isProjectNewerThanSlicer('03.00.00.00', '2.9.9.9'), true)
  assert.equal(isProjectNewerThanSlicer('02.09.00.00', '3.0.0.0'), false)
})

test('an unknown version on either side never blocks a slice', () => {
  // Reporting "newer" from a version we could not read would refuse work that would succeed.
  assert.equal(isProjectNewerThanSlicer(null, '2.7.1.62'), false)
  assert.equal(isProjectNewerThanSlicer('02.08.00.50', null), false)
  assert.equal(isProjectNewerThanSlicer('garbage', '2.7.1.62'), false)
})

test('formats a padded version for display beside plain target versions', () => {
  assert.equal(formatBambuVersion('02.08.00.50'), '2.8.0.50')
  assert.equal(formatBambuVersion('2.7.1.62'), '2.7.1.62')
  assert.equal(formatBambuVersion('nope'), null)
  assert.equal(formatBambuVersion(null), null)
})
