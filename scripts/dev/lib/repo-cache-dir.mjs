/**
 * Where per-clone developer caches live, shared across every git worktree of that clone.
 *
 * Owns one decision the repo lock (`repo-lock.mjs`) and the test-result cache (`result-cache.mjs`)
 * must agree on: the cache is keyed on the git COMMON dir, not the working directory. Every
 * worktree of a clone reports the same common dir, so a sibling worktree shares a cache with the
 * main checkout and with the other worktrees. That sharing is the point: a worktree that only
 * touched `apps/web` inherits the api/shared/bridge test results another checkout already proved
 * green.
 *
 * It lives OUTSIDE the repo (under XDG_CACHE_HOME) on purpose. Inside the tree it would be
 * per-worktree (defeating the sharing), would need gitignoring in every worktree, and would be
 * swept by `git clean`. Nothing here is precious: deleting the directory costs one slow run.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'

const CACHE_NAMESPACE = 'printstream-validate'

/**
 * Memoised per directory, not globally: callers pass an explicit root (the test suite points it at
 * a sandbox), and a single global memo would hand the second caller the first caller's clone.
 */
const bucketsByDirectory = new Map()

/**
 * Absolute path of this clone's cache directory. Not created; callers `mkdirSync(..., {recursive})`.
 *
 * `root` must be the directory whose clone the cache belongs to. Falls back to a fixed bucket when
 * git is unavailable (a tarball checkout, a sandbox without git), which is still correct, just not
 * shared between worktrees.
 */
export function repoCacheDir(root = process.cwd()) {
  return path.join(cacheRoot(), CACHE_NAMESPACE, repoBucket(root))
}

function cacheRoot() {
  return process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache')
}

function repoBucket(root) {
  if (bucketsByDirectory.has(root)) return bucketsByDirectory.get(root)
  let bucket
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    bucket = createHash('sha256').update(path.resolve(root, common)).digest('hex').slice(0, 16)
  } catch {
    bucket = 'no-git'
  }
  bucketsByDirectory.set(root, bucket)
  return bucket
}
