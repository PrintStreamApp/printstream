/**
 * Fully prepares a linked worktree before tests or application code can create partial data dirs.
 *
 * `devkit prepare` owns ignored config and checkout-local dependencies. Its development preflight
 * owns the paired database and filesystem baseline. Both must run here, in that order: tests create
 * `data/library/_bridge-cache`, and if that happens first Devkit can mistake the partial directory
 * for a restored baseline and leave bridge identity/library files behind.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

/** Prepare dependencies, isolated infrastructure, and every configured baseline path. */
export async function prepareWorktree({
  repoRoot,
  environment = process.env,
  run = spawnSync,
  pathExists = existsSync,
  loadDevkit = () => import('@ryanewen/devkit')
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

  let runtime
  try {
    const { preflight } = await loadDevkit()
    runtime = await preflight({ repoRoot, checkDependencies: false })
  } catch (error) {
    return { state: 'failed', detail: error instanceof Error ? error.message : String(error) }
  }
  if (!runtime) {
    return { state: 'failed', detail: 'Devkit is not enabled for this checkout; run `npm run dev:bootstrap` first.' }
  }

  if (!runtime.identity.isPrimary) {
    const missing = runtime.project.baselinePaths.filter(
      (relativePath) => !pathExists(path.join(repoRoot, relativePath))
    )
    if (missing.length > 0) {
      return {
        state: 'failed',
        detail: [
          `Devkit did not restore the complete worktree data baseline: ${missing.join(', ')}.`,
          'Refresh it with `npm run dev:host -- snapshot` from the primary checkout, then run `npm run dev:host -- reset` here.'
        ].join(' ')
      }
    }
  }

  return {
    state: 'prepared',
    repoRoot,
    baselinePathCount: runtime.project.baselinePaths.length,
    lines: runtime.lines
  }
}
