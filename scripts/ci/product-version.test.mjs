import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { readProductVersion } from './product-version.mjs'

function fixture(rootVersion, workspaceVersion = rootVersion, dependencyVersion = rootVersion) {
  const root = mkdtempSync(path.join(tmpdir(), 'printstream-version-'))
  mkdirSync(path.join(root, 'apps', 'api'), { recursive: true })
  mkdirSync(path.join(root, 'packages', 'shared'), { recursive: true })
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: rootVersion }))
  writeFileSync(path.join(root, 'apps', 'api', 'package.json'), JSON.stringify({
    version: workspaceVersion,
    dependencies: { '@printstream/shared': dependencyVersion }
  }))
  writeFileSync(path.join(root, 'packages', 'shared', 'package.json'), JSON.stringify({ version: rootVersion }))
  return root
}

test('readProductVersion returns a shared SemVer', () => {
  assert.equal(readProductVersion(fixture('1.2.3')), '1.2.3')
})

test('readProductVersion rejects malformed and drifting versions', () => {
  assert.throws(() => readProductVersion(fixture('release-1')), /not valid SemVer/)
  assert.throws(() => readProductVersion(fixture('1.2.3-01')), /not valid SemVer/)
  assert.throws(() => readProductVersion(fixture('1.2.3+build.4')), /Docker tags cannot contain/)
  assert.throws(() => readProductVersion(fixture('1.2.3', '1.2.4')), /not shared/)
  assert.throws(() => readProductVersion(fixture('1.2.3', '1.2.3', '1.2.2')), /not shared/)
})

test('readProductVersion rejects a separate Windows package version', () => {
  const root = fixture('1.2.3')
  const projectDirectory = path.join(root, 'apps', 'desktop', 'PrintStream.Desktop')
  mkdirSync(projectDirectory, { recursive: true })
  writeFileSync(
    path.join(projectDirectory, 'PrintStream.Desktop.csproj'),
    '<Project><PropertyGroup><Version>1.2.3</Version></PropertyGroup></Project>'
  )

  assert.throws(() => readProductVersion(root), /declares a separate <Version>/)
})
