/**
 * Owns the full validation gate's runtime prerequisites before entering the existing lock and
 * low-priority wrappers. PostgreSQL coverage is mandatory here even though direct targeted test
 * runs remain usable without a database.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkoutDependencyIssue } from './lib/checkout-dependencies.mjs'

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dependencyIssue = checkoutDependencyIssue(workspaceRoot)
if (dependencyIssue) {
  console.error(
    `[validate] ${dependencyIssue}. Run \`devkit prepare\` from this worktree before validation; ` +
    'do not link dependencies from another checkout.'
  )
  process.exit(1)
}

// Keep installed-package imports behind the dependency check so a fresh agent worktree receives
// the actionable preparation command instead of an unrelated ERR_MODULE_NOT_FOUND stack trace.
const { prepareValidationDatabase } = await import('./lib/validation-database.mjs')

let prepared
try {
  prepared = await prepareValidationDatabase({ repoRoot: workspaceRoot })
} catch (error) {
  console.error(`[validate] ${error.message}`)
  process.exit(1)
}

console.error(`[validate] PostgreSQL coverage ready (${prepared.source}).`)

const child = spawn(
  process.execPath,
  [
    path.join(workspaceRoot, 'scripts/dev/run-exclusive.mjs'),
    process.execPath,
    path.join(workspaceRoot, 'scripts/dev/run-low-priority.mjs'),
    'npm',
    'run',
    'validate:stages'
  ],
  {
    cwd: workspaceRoot,
    env: prepared.environment,
    stdio: 'inherit'
  }
)

let receivedSignal
const signalExitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }
for (const signal of Object.keys(signalExitCodes)) {
  process.once(signal, () => {
    receivedSignal ??= signal
    if (child.exitCode === null && child.signalCode === null) child.kill(signal)
  })
}

child.on('error', (error) => {
  console.error(`[validate] could not start validation: ${error.message}`)
  process.exit(1)
})
child.on('close', (code, signal) => {
  process.exit(receivedSignal ? signalExitCodes[receivedSignal] : signal ? 1 : code ?? 1)
})
