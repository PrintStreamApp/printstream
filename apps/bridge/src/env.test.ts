import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { resolveWorkspacePath } from './env.js'

// Derive the workspace root the same way env.ts does (three levels above this
// directory) instead of hardcoding an absolute checkout path — the suite must
// pass from any checkout location (CI, git worktrees).
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

test('resolveWorkspacePath resolves repo-relative bridge paths from the workspace root', () => {
  assert.equal(
    resolveWorkspacePath('./apps/bridge/data/bridge-state.json'),
    path.resolve(workspaceRoot, './apps/bridge/data/bridge-state.json')
  )
  assert.equal(
    resolveWorkspacePath('./apps/bridge/data/bridge-library'),
    path.resolve(workspaceRoot, './apps/bridge/data/bridge-library')
  )
})

test('resolveWorkspacePath preserves absolute paths', () => {
  assert.equal(resolveWorkspacePath('/tmp/bridge-state.json'), '/tmp/bridge-state.json')
})