/**
 * Prepares a linked worktree for repository tooling without starting development infrastructure.
 *
 * `devkit prepare` owns ignored config and checkout-local dependencies. Database provisioning and
 * the paired filesystem baseline remain part of the first development preflight, so creating a
 * worktree cannot leave a PostgreSQL container running before anyone starts the application.
 */
import { spawnSync } from 'node:child_process'

/** Prepare checkout-local files and dependencies, propagating Devkit's actionable failure text. */
export async function prepareWorktree({
  repoRoot,
  environment = process.env,
  run = spawnSync
}) {
  const checkout = run('devkit', ['prepare'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: environment,
    timeout: 14 * 60 * 1000
  })
  if (checkout.error || checkout.status !== 0) {
    return {
      state: 'failed',
      detail: checkout.error?.message || checkout.stderr?.trim() || checkout.stdout?.trim() || 'devkit prepare failed'
    }
  }

  return {
    state: 'prepared',
    repoRoot,
    lines: checkout.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  }
}
