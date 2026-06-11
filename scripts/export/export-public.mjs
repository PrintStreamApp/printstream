/**
 * Exports the public open-source snapshot of PrintStream.
 *
 * Copies every git-tracked file except the private (closed-source) surface
 * into a target tree with its own fresh git history, applying small
 * manifest transforms so the public repo carries no dangling references.
 *
 * Excluded from the public repo:
 * - `apps/api/src/private`, `apps/web/src/private`, `packages/shared/src/private`
 *   (the cloud marketing + tenant-administration modules)
 * - `integrations/` (the Home Assistant integration ships from its own repo
 *   via `export-home-assistant.mjs`)
 * - cloud-deployment helper scripts and env examples
 *
 * Usage: node scripts/export/export-public.mjs [--target <dir>]
 * Default target: ../printstream-public (sibling of this repo).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  commitSnapshot,
  copyFile,
  headShortSha,
  listTrackedFiles,
  parseTargetArg,
  resetTargetTree
} from './lib.mjs'

const EXCLUDED_PREFIXES = [
  'apps/api/src/private/',
  'apps/web/src/private/',
  'packages/shared/src/private/',
  'integrations/'
]

const EXCLUDED_FILES = new Set([
  'scripts/deploy/install-home-assistant-over-ssh.mjs',
  'scripts/dev/marketing-screenshot-receiver.mjs',
  '.env.cloud.example',
  '.claude/commands/install-ha.md'
])

const target = parseTargetArg('printstream-public')
resetTargetTree(target)

let copied = 0
let skipped = 0
for (const file of listTrackedFiles()) {
  if (EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix)) || EXCLUDED_FILES.has(file)) {
    skipped += 1
    continue
  }
  copyFile(file, target)
  copied += 1
}

transformRootPackageJson(target)
transformSharedPackageJson(target)

console.log(`Copied ${copied} files (excluded ${skipped}) to ${target}.`)
commitSnapshot(target, `Public snapshot from ${headShortSha()}`)

/** Drops scripts that only make sense with the private/integration trees. */
function transformRootPackageJson(targetRoot) {
  const manifestPath = path.join(targetRoot, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  delete manifest.scripts['capture:marketing:receive']
  delete manifest.scripts['deploy:ha:ssh']
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

/** Removes the private contracts subpath; the directory is not exported. */
function transformSharedPackageJson(targetRoot) {
  const manifestPath = path.join(targetRoot, 'packages/shared/package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  delete manifest.exports['./private']
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  mkdirSync(path.join(targetRoot, 'packages/shared/src'), { recursive: true })
}
