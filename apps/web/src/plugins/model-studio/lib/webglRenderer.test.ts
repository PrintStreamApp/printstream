/**
 * Every renderer in this plugin must come from `createWebglRenderer`.
 *
 * The factory exists to set `debug.checkShaderErrors` once (see its header: leaving it on costs a
 * synchronous driver stall per program link, measured at 5.2% of non-idle CPU during a heavy
 * project open). A sixth `new THREE.WebGLRenderer` would type-check, render correctly, and quietly
 * opt that surface out of the policy -- so the check has to be a source scan. The offscreen
 * thumbnail renderers are the ones that would hurt most, since a fresh context shares no program
 * cache and recompiles every material from scratch.
 *
 * This mirrors `paintChannelCoverage.test.ts`: an invariant the type checker cannot express.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { parseBrowserEnv } from '../../../lib/browserEnv'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : []
  })
}

test('no renderer is constructed outside the factory', () => {
  const offenders = sourceFiles(pluginRoot).filter((file) => (
    path.basename(file) !== 'webglRenderer.ts' && /new\s+THREE\.WebGLRenderer\s*\(/.test(readFileSync(file, 'utf8'))
  ))
  assert.deepEqual(
    offenders.map((file) => path.relative(pluginRoot, file)),
    [],
    'construct renderers with createWebglRenderer so they inherit the shared debug policy'
  )
})

test('shader error checking follows dev mode, not the other way round', () => {
  // Pins the direction of the flag. Inverting it would be invisible in dev (everything still
  // renders) and would ship the stall to every user, which is the whole thing being avoided.
  assert.equal(parseBrowserEnv({ DEV: true }).devMode, true)
  assert.equal(parseBrowserEnv({ MODE: 'production' }).devMode, false)
  assert.equal(parseBrowserEnv({}).devMode, false, 'an unknown env must not leave the check on for users')
})
