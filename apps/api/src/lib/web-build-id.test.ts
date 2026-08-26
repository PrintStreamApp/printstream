/**
 * Reading the served bundle's identity off disk.
 *
 * The property under test is the failure direction: every way of not knowing must answer
 * null, never a guess. A wrong id here does not degrade gracefully, it tells every
 * connected browser to reload toward a build that is not there, and the client-side loop
 * guard is the only thing that would stop that becoming a fleet-wide refresh loop.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { readWebBuildIdFrom } from './web-build-id.js'

const staged: string[] = []

/** A directory standing in for a served `dist`, optionally holding a `build-id.json`. */
function stageWebDir(contents: string | null): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'printstream-web-build-'))
  staged.push(dir)
  if (contents !== null) writeFileSync(path.join(dir, 'build-id.json'), contents, 'utf8')
  return dir
}

after(() => {
  for (const dir of staged) rmSync(dir, { recursive: true, force: true })
})

test('reads the id the web build wrote', () => {
  const dir = stageWebDir(JSON.stringify({ buildId: '2c41c442d2eb02dc' }))
  assert.equal(readWebBuildIdFrom(dir), '2c41c442d2eb02dc')
})

test('reports nothing when no web directory is served', () => {
  // The split topology: this API serves /api and /ws only, and something else serves the
  // SPA, so it genuinely has no idea what bundle the browser is running.
  assert.equal(readWebBuildIdFrom(undefined), null)
  assert.equal(readWebBuildIdFrom(''), null)
})

test('reports nothing when the bundle predates the build stamp', () => {
  assert.equal(readWebBuildIdFrom(stageWebDir(null)), null)
})

test('reports nothing rather than a guess when the file is unusable', () => {
  assert.equal(readWebBuildIdFrom(stageWebDir('not json at all')), null)
  assert.equal(readWebBuildIdFrom(stageWebDir('{}')), null)
  assert.equal(readWebBuildIdFrom(stageWebDir(JSON.stringify({ buildId: 42 }))), null)
})

test('an empty id is unknown, not an id', () => {
  // A blank value shipped as though it were real is how the native update channel sat
  // dead for two weeks. Absent and empty must reach the same answer.
  assert.equal(readWebBuildIdFrom(stageWebDir(JSON.stringify({ buildId: '' }))), null)
  assert.equal(readWebBuildIdFrom(stageWebDir(JSON.stringify({ buildId: '   ' }))), null)
})
