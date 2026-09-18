#!/usr/bin/env node
/** Prepare checkout-local files and dependencies without starting development infrastructure. */
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
  console.log('[worktree-prepare] ready; development infrastructure remains stopped')
}
