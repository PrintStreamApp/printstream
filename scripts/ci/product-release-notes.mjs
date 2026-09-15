/**
 * Renders the approved product changelog entry as Markdown for the public GitHub Release.
 * The publishing workflow adds image instructions, GitHub's technical change list, and the
 * outward-facing disclosure around this canonical user-facing section.
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readProductChangelog } from './product-changelog.mjs'

/** Returns the exact approved changes for one product version as GitHub-flavoured Markdown. */
export function renderProductReleaseNotes(version, root = process.cwd()) {
  const release = readProductChangelog(root).find((candidate) => candidate.version === version)
  if (!release) {
    throw new Error(`Product changelog has no approved entry for ${version}.`)
  }

  return [
    '## What\'s new',
    '',
    ...release.changes.map((change) => `- ${change}`),
    ''
  ].join('\n')
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  const version = process.argv[2]
  if (!version) throw new Error('Usage: node scripts/ci/product-release-notes.mjs <version>')
  process.stdout.write(renderProductReleaseNotes(version))
}
