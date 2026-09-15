/**
 * Dependency-free inspection used before validation imports installed packages.
 *
 * Devkit owns installing and fingerprinting dependencies. This module only recognizes states that
 * cannot safely reach that preflight from an agent sandbox: an absent dependency tree, a root
 * symlink to another checkout, or a non-directory occupying `node_modules`.
 */
import { lstatSync } from 'node:fs'
import path from 'node:path'

/** Returns null for a local directory, otherwise a concise reason it cannot be used. */
export function checkoutDependencyIssue(repoRoot) {
  const dependencyPath = path.join(repoRoot, 'node_modules')
  let stats
  try {
    stats = lstatSync(dependencyPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return 'node_modules is missing'
    throw error
  }

  if (stats.isSymbolicLink()) return 'node_modules is a symlink to another checkout'
  if (!stats.isDirectory()) return 'node_modules is not a directory'
  return null
}
