#!/usr/bin/env node
/** Guarded entry point shared by the land-worktree and cancel-worktree workflows. */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { removeCurrentWorktree } from './lib/worktree-removal.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const result = removeCurrentWorktree({
  repoRoot,
  discardChanges: process.argv.includes('--discard-changes')
})

if (result.state === 'failed') {
  console.error(`[worktree-remove] ${result.detail}`)
  process.exitCode = 1
} else {
  const volumes = result.removedVolumes.length > 0
    ? result.removedVolumes.join(', ')
    : 'none existed'
  console.log(`[worktree-remove] removed ${result.repoRoot}`)
  console.log(`[worktree-remove] removed private volumes: ${volumes}`)
  console.log(`[worktree-remove] local branch retained for the invoking workflow: ${result.branch}`)
}
