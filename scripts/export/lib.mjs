/**
 * Shared helpers for the public-repo export scripts. Exports are snapshot
 * based: tracked files are copied from this monorepo (the private source of
 * truth) into a target working tree with its own fresh git history, so the
 * published repos never contain this repo's commit history.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'

export const repoRoot = path.resolve(new URL('../..', import.meta.url).pathname)

export function git(args, cwd = repoRoot) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

export function listTrackedFiles() {
  return git(['ls-files', '-z']).split('\0').filter(Boolean)
}

export function headShortSha() {
  return git(['rev-parse', '--short', 'HEAD']).trim()
}

/** Empties the target directory while preserving its .git directory. */
export function resetTargetTree(target) {
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(target)) {
    if (entry === '.git') continue
    rmSync(path.join(target, entry), { recursive: true, force: true })
  }
}

export function copyFile(sourceRelative, targetRoot, targetRelative = sourceRelative) {
  const destination = path.join(targetRoot, targetRelative)
  mkdirSync(path.dirname(destination), { recursive: true })
  cpSync(path.join(repoRoot, sourceRelative), destination)
}

/** Initializes a fresh repo if needed, then commits the snapshot. */
export function commitSnapshot(target, message) {
  if (!existsSync(path.join(target, '.git'))) {
    git(['init', '-b', 'main'], target)
  }
  // Snapshot repos may have no identity of their own; inherit the
  // monorepo's so the commit succeeds in clean environments.
  for (const key of ['user.name', 'user.email']) {
    let targetValue = ''
    try {
      targetValue = git(['config', '--get', key], target).trim()
    } catch {
      // unset in the target
    }
    if (targetValue) continue
    const value = git(['config', '--get', key]).trim()
    if (value) git(['config', key, value], target)
  }
  // Force-add: everything in the target tree was deliberately copied from the
  // monorepo's tracked files, so ignore rules (e.g. a root-scoped pattern that
  // happens to match a nested copy) must never silently drop a file from the
  // snapshot.
  git(['add', '-A', '-f'], target)
  const status = git(['status', '--porcelain'], target)
  if (!status.trim()) {
    console.log(`No changes to commit in ${target}.`)
    return
  }
  git(['commit', '-m', message], target)
  console.log(`Committed snapshot in ${target}.`)
}

export function parseTargetArg(defaultDirName) {
  const args = process.argv.slice(2)
  const targetFlagIndex = args.indexOf('--target')
  const target = targetFlagIndex >= 0 && args[targetFlagIndex + 1]
    ? path.resolve(args[targetFlagIndex + 1])
    : path.resolve(repoRoot, '..', defaultDirName)
  return target
}
