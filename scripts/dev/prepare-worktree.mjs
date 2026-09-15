#!/usr/bin/env node
/** Fully bootstrap this checkout for tests and development. */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { prepareWorktree } from './lib/worktree-preparation.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const result = await prepareWorktree({ repoRoot })

if (result.state === 'failed') {
  console.error(`[worktree-prepare] ${result.detail}`)
  process.exitCode = 1
} else {
  for (const line of result.lines) console.log(`[worktree-prepare] ${line}`)
  console.log(`[worktree-prepare] ready, verified ${result.baselinePathCount} baseline path(s)`)
}
