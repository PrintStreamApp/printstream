/**
 * Exports the Home Assistant integration as a standalone, HACS-compatible
 * repository snapshot: the contents of `integrations/home-assistant/`
 * (hacs.json + README + custom_components/printstream) at the repo root,
 * plus the project LICENSE, with its own fresh git history.
 *
 * Usage: node scripts/export/export-home-assistant.mjs [--target <dir>]
 * Default target: ../printstream-home-assistant (sibling of this repo).
 */
import {
  commitSnapshot,
  copyFile,
  headShortSha,
  listTrackedFiles,
  parseTargetArg,
  resetTargetTree
} from './lib.mjs'

const SOURCE_PREFIX = 'integrations/home-assistant/'

const target = parseTargetArg('printstream-home-assistant')
resetTargetTree(target)

let copied = 0
for (const file of listTrackedFiles()) {
  if (!file.startsWith(SOURCE_PREFIX)) continue
  copyFile(file, target, file.slice(SOURCE_PREFIX.length))
  copied += 1
}
copyFile('LICENSE', target)

console.log(`Copied ${copied + 1} files to ${target}.`)
commitSnapshot(target, `Home Assistant integration snapshot from ${headShortSha()}`)
