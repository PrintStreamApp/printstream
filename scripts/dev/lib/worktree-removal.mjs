/**
 * Removes one linked worktree and every private development resource derived from its identity.
 *
 * The caller supplies the checkout where the command is running. This module resolves `dev` from
 * Git metadata, tears the target stack down before removing its directory, and deletes only the
 * target's database, slicer-data, and slicer-work volumes. The content-addressed slicer engine
 * volume is shared across checkouts and must never be included.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'

import { checkoutIdentity } from '@ryanewen/devkit'

/** Parse the path and checked-out branch for every registered worktree. */
export function parseWorktreeList(output) {
  const worktrees = []
  let current = null

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { root: line.slice('worktree '.length).trim(), branch: null }
      worktrees.push(current)
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim()
    }
  }

  return worktrees
}

/** Names the checkout-private volumes that become useless when its worktree is removed. */
export function privateWorktreeVolumes(composeProject) {
  return [
    `${composeProject}-database`,
    `${composeProject}_slicer-data`,
    `${composeProject}_slicer-work`
  ]
}

/**
 * Tear down and remove the current linked worktree, then delete its private Docker volumes.
 *
 * Dirty worktrees fail closed unless `discardChanges` records the caller's explicit authorization.
 * The local branch is deliberately left for the invoking land/cancel workflow to handle according
 * to whether its commits were merged or abandoned.
 */
export function removeCurrentWorktree({
  repoRoot,
  discardChanges = false,
  environment = process.env,
  run = spawnSync,
  resolveIdentity = checkoutIdentity
}) {
  const identity = resolveIdentity(repoRoot)
  if (!identity || identity.isPrimary) {
    return { state: 'failed', detail: 'refusing to remove the primary checkout' }
  }

  const listed = run('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: environment
  })
  if (listed.error || listed.status !== 0) return failedCommand('could not list worktrees', listed)

  const worktrees = parseWorktreeList(listed.stdout)
  const target = worktrees.find((worktree) => path.resolve(worktree.root) === path.resolve(repoRoot))
  const dev = worktrees.find((worktree) => worktree.branch === 'refs/heads/dev')
  if (!target) return { state: 'failed', detail: `${repoRoot} is not a registered worktree` }
  if (!target.branch) return { state: 'failed', detail: 'refusing to remove a detached worktree' }
  if (target.branch === 'refs/heads/dev' || !dev || path.resolve(dev.root) === path.resolve(repoRoot)) {
    return { state: 'failed', detail: 'refusing to remove the worktree holding dev' }
  }

  const status = run('git', ['status', '--short'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: environment
  })
  if (status.error || status.status !== 0) return failedCommand('could not inspect the worktree', status)
  const dirty = status.stdout.trim().length > 0
  if (dirty && !discardChanges) {
    return {
      state: 'failed',
      detail: 'the worktree has uncommitted or untracked changes; explicit discard authorization is required'
    }
  }

  const teardown = run('npm', ['run', 'dev:down'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: environment,
    stdio: 'inherit'
  })
  if (teardown.error || teardown.status !== 0) return failedCommand('checkout teardown failed', teardown)

  const removeArgs = ['worktree', 'remove']
  if (dirty) removeArgs.push('--force')
  removeArgs.push(repoRoot)
  const removed = run('git', removeArgs, {
    cwd: dev.root,
    encoding: 'utf8',
    env: environment
  })
  if (removed.error || removed.status !== 0) return failedCommand('could not remove the worktree', removed)

  const volumes = privateWorktreeVolumes(identity.composeProject)
  const existing = run('docker', ['volume', 'ls', '--format', '{{.Name}}'], {
    cwd: dev.root,
    encoding: 'utf8',
    env: environment
  })
  if (existing.error || existing.status !== 0) return failedCommand('could not list Docker volumes', existing)

  const available = new Set(existing.stdout.split('\n').map((line) => line.trim()).filter(Boolean))
  const present = volumes.filter((volume) => available.has(volume))
  if (present.length > 0) {
    const pruned = run('docker', ['volume', 'rm', ...present], {
      cwd: dev.root,
      encoding: 'utf8',
      env: environment
    })
    if (pruned.error || pruned.status !== 0) return failedCommand('could not remove worktree volumes', pruned)
  }

  return {
    state: 'removed',
    branch: target.branch.slice('refs/heads/'.length),
    devRoot: dev.root,
    repoRoot,
    removedVolumes: present
  }
}

/** Preserve the useful subprocess diagnostic while keeping callers on a structured result. */
function failedCommand(prefix, result) {
  const detail = result.error?.message || result.stderr?.trim() || result.stdout?.trim() || 'command failed'
  return { state: 'failed', detail: `${prefix}: ${detail}` }
}
