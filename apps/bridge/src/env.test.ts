import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { resolveWorkspacePath } from './env.js'

test('resolveWorkspacePath resolves repo-relative bridge paths from the workspace root', () => {
  assert.equal(
    resolveWorkspacePath('./apps/bridge/data/bridge-state.json'),
    path.resolve('/workspace/printstream', './apps/bridge/data/bridge-state.json')
  )
  assert.equal(
    resolveWorkspacePath('./apps/bridge/data/bridge-library'),
    path.resolve('/workspace/printstream', './apps/bridge/data/bridge-library')
  )
})

test('resolveWorkspacePath preserves absolute paths', () => {
  assert.equal(resolveWorkspacePath('/tmp/bridge-state.json'), '/tmp/bridge-state.json')
})