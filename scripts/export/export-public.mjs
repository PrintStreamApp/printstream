/**
 * Exports the public open-source snapshot of PrintStream.
 *
 * Copies every git-tracked file except the private (closed-source) surface
 * into a target tree with its own fresh git history, applying small
 * transforms so the public repo carries no dangling references.
 *
 * Excluded from the public repo:
 * - `apps/api/src/private`, `apps/web/src/private`, `packages/shared/src/private`
 *   (cloud marketing, tenant administration, and demo modules)
 * - `integrations/` (the Home Assistant integration ships from its own repo
 *   via `export-home-assistant.mjs`)
 * - demo machinery (bridge simulator entrypoints, seed library, compose demo
 *   services between `BEGIN/END PRIVATE DEMO` markers, demo npm scripts)
 * - `docs/private/`, marketing screenshot assets, and internal investigation docs
 *
 * Usage: node scripts/export/export-public.mjs [--target <dir>]
 * Default target: ../printstream-public (sibling of this repo).
 */
import { readFileSync, writeFileSync } from 'node:fs'
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
  'apps/web/public/marketing/',
  'data/',
  'docs/private/',
  'integrations/'
]

const EXCLUDED_FILES = new Set([
  'apps/bridge/src/demo-index.ts',
  'apps/bridge/src/demo-simulator.ts',
  'apps/bridge/src/demo-simulator.test.ts',
  'scripts/deploy/install-home-assistant-over-ssh.mjs',
  'scripts/dev/marketing-screenshot-receiver.mjs',
  '.claude/commands/install-ha.md',
  'docs/dialog-section-audit.md',
  'docs/slicer-cover-rendering-investigation.md'
])

const PRIVATE_BLOCK_START = /^\s*#\s*BEGIN PRIVATE DEMO/
const PRIVATE_BLOCK_END = /^\s*#\s*END PRIVATE DEMO/

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

transformPackageJson(target, 'package.json', ['capture:marketing:receive', 'deploy:ha:ssh', 'dev:demo', 'dev:demo:parallel'])
transformPackageJson(target, 'apps/api/package.json', ['demo:bootstrap'])
transformPackageJson(target, 'apps/bridge/package.json', ['dev:demo', 'start:demo'])
transformSharedPackageJson(target)
stripPrivateDemoBlocks(target)

console.log(`Copied ${copied} files (excluded ${skipped}) to ${target}.`)
commitSnapshot(target, `Public snapshot from ${headShortSha()}`)

/** Drops npm scripts that only make sense with the private/integration trees. */
function transformPackageJson(targetRoot, manifestRelative, scriptsToDrop) {
  const manifestPath = path.join(targetRoot, manifestRelative)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const script of scriptsToDrop) {
    delete manifest.scripts[script]
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

/** Removes the private contracts subpath; the directory is not exported. */
function transformSharedPackageJson(targetRoot) {
  const manifestPath = path.join(targetRoot, 'packages/shared/package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  delete manifest.exports['./private']
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

/** Strips `BEGIN/END PRIVATE DEMO` marker blocks from exported templates. */
function stripPrivateDemoBlocks(targetRoot) {
  for (const relative of ['compose.server.example.yml', '.env.server.example']) {
    const filePath = path.join(targetRoot, relative)
    let source
    try {
      source = readFileSync(filePath, 'utf8')
    } catch {
      continue
    }
    const kept = []
    let inPrivateBlock = false
    for (const line of source.split('\n')) {
      if (PRIVATE_BLOCK_START.test(line)) {
        inPrivateBlock = true
        continue
      }
      if (PRIVATE_BLOCK_END.test(line)) {
        inPrivateBlock = false
        continue
      }
      if (!inPrivateBlock) kept.push(line)
    }
    writeFileSync(filePath, kept.join('\n').replace(/\n{3,}/g, '\n\n'))
  }
}
