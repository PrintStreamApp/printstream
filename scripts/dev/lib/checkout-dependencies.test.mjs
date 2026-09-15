import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'

import { checkoutDependencyIssue } from './checkout-dependencies.mjs'

const sandboxes = []

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) {
    rmSync(sandbox, { recursive: true, force: true })
  }
})

function checkout() {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'printstream-dependencies-'))
  sandboxes.push(repoRoot)
  return repoRoot
}

test('a checkout-local dependency directory is ready', () => {
  const repoRoot = checkout()
  mkdirSync(path.join(repoRoot, 'node_modules'))

  assert.equal(checkoutDependencyIssue(repoRoot), null)
})

test('missing and linked dependency trees name the preparation problem', () => {
  const missingRoot = checkout()
  assert.equal(checkoutDependencyIssue(missingRoot), 'node_modules is missing')

  const linkedRoot = checkout()
  const external = path.join(checkout(), 'external-node-modules')
  mkdirSync(external)
  symlinkSync(external, path.join(linkedRoot, 'node_modules'), 'dir')
  assert.equal(
    checkoutDependencyIssue(linkedRoot),
    'node_modules is a symlink to another checkout'
  )
})

test('a non-directory dependency path is rejected', () => {
  const repoRoot = checkout()
  writeFileSync(path.join(repoRoot, 'node_modules'), 'not a directory\n')

  assert.equal(checkoutDependencyIssue(repoRoot), 'node_modules is not a directory')
})
