/**
 * Validates the committed product changelog consumed by the web footer. Ordinary validation permits
 * the initial empty catalogue; release validation additionally requires notes for the product
 * version being published.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readProductVersion } from './product-version.mjs'

const NUMERIC_IDENTIFIER = '(?:0|[1-9][0-9]*)'
const PRERELEASE_IDENTIFIER = `(?:${NUMERIC_IDENTIFIER}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`
const SEMVER_PATTERN = new RegExp(
  `^${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}`
  + `(?:-${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*)?$`
)
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** Returns the validated release list, failing with an actionable catalogue error. */
export function readProductChangelog(root = process.cwd(), { requireCurrent = false } = {}) {
  const changelogPath = path.join(root, 'apps', 'web', 'src', 'product-changelog.json')
  const parsed = JSON.parse(readFileSync(changelogPath, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.releases)) {
    throw new Error('Product changelog must contain a releases array.')
  }

  const versions = new Set()
  for (const [index, release] of parsed.releases.entries()) {
    const label = `Product changelog release ${index + 1}`
    if (!release || typeof release !== 'object') throw new Error(`${label} must be an object.`)
    if (typeof release.version !== 'string' || !SEMVER_PATTERN.test(release.version)) {
      throw new Error(`${label} has an invalid SemVer.`)
    }
    if (versions.has(release.version)) throw new Error(`Product changelog repeats version ${release.version}.`)
    versions.add(release.version)
    const previousRelease = parsed.releases[index - 1]
    if (previousRelease && compareSemver(previousRelease.version, release.version) <= 0) {
      throw new Error('Product changelog releases must be ordered newest first.')
    }
    if (typeof release.releasedOn !== 'string' || !isCalendarDate(release.releasedOn)) {
      throw new Error(`${label} has an invalid releasedOn date; use YYYY-MM-DD.`)
    }
    if (!Array.isArray(release.changes) || release.changes.length === 0
      || release.changes.some((change) => typeof change !== 'string' || change.trim() === '')) {
      throw new Error(`${label} must contain at least one non-empty change.`)
    }
    if (release.changes.some((change) => change.includes('\n') || change.includes('\r'))) {
      throw new Error(`${label} changes must each fit on one line.`)
    }
  }

  if (requireCurrent) {
    const currentVersion = readProductVersion(root)
    if (parsed.releases[0]?.version !== currentVersion) {
      throw new Error(`Product changelog must start with the release being published, ${currentVersion}.`)
    }
  }
  return parsed.releases
}

function isCalendarDate(value) {
  if (!DATE_PATTERN.test(value)) return false
  const date = new Date(`${value}T12:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function compareSemver(left, right) {
  const [leftCore, leftPrerelease] = splitSemver(left)
  const [rightCore, rightPrerelease] = splitSemver(right)
  const leftParts = leftCore.split('.').map(Number)
  const rightParts = rightCore.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index]
    if (difference !== 0) return difference
  }
  if (leftPrerelease == null) return rightPrerelease == null ? 0 : 1
  if (rightPrerelease == null) return -1

  const leftIds = leftPrerelease.split('.')
  const rightIds = rightPrerelease.split('.')
  for (let index = 0; index < Math.max(leftIds.length, rightIds.length); index += 1) {
    const leftId = leftIds[index]
    const rightId = rightIds[index]
    if (leftId == null) return -1
    if (rightId == null) return 1
    if (leftId === rightId) continue
    const leftNumeric = /^\d+$/.test(leftId)
    const rightNumeric = /^\d+$/.test(rightId)
    if (leftNumeric && rightNumeric) return Number(leftId) - Number(rightId)
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftId.localeCompare(rightId)
  }
  return 0
}

function splitSemver(version) {
  const prereleaseIndex = version.indexOf('-')
  return prereleaseIndex < 0
    ? [version, undefined]
    : [version.slice(0, prereleaseIndex), version.slice(prereleaseIndex + 1)]
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  const releases = readProductChangelog(process.cwd(), {
    requireCurrent: process.argv.includes('--require-current')
  })
  console.log(`Validated ${releases.length} product changelog release${releases.length === 1 ? '' : 's'}.`)
}
