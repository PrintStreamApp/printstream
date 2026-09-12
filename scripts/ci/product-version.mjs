/**
 * Owns the product SemVer shared by the root and every JavaScript workspace.
 *
 * Home Assistant remains independently versioned because HACS publishes and
 * installs it on its own cadence. Build fingerprints and schema/protocol
 * versions are identities, not product versions, and are deliberately outside
 * this check.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const NUMERIC_IDENTIFIER = '(?:0|[1-9][0-9]*)'
const PRERELEASE_IDENTIFIER = `(?:${NUMERIC_IDENTIFIER}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`
const BUILD_IDENTIFIER = '[0-9A-Za-z-]+'
const SEMVER_PATTERN = new RegExp(
  `^${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}`
  + `(?:-${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*)?`
  + `(?:\\+${BUILD_IDENTIFIER}(?:\\.${BUILD_IDENTIFIER})*)?$`
)

function readManifest(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

/** Returns the validated product SemVer, failing if a workspace has drifted. */
export function readProductVersion(root = process.cwd()) {
  const version = readManifest(path.join(root, 'package.json')).version
  if (typeof version !== 'string' || !SEMVER_PATTERN.test(version)) {
    throw new Error(`Root package version is not valid SemVer: ${String(version)}`)
  }
  if (version.includes('+')) {
    throw new Error(`Root package version cannot use SemVer build metadata because Docker tags cannot contain "+": ${version}`)
  }

  const mismatches = []
  for (const workspaceRoot of ['apps', 'packages']) {
    const parent = path.join(root, workspaceRoot)
    if (!existsSync(parent)) continue
    for (const name of readdirSync(parent)) {
      const manifestPath = path.join(parent, name, 'package.json')
      if (!existsSync(manifestPath)) continue
      const manifest = readManifest(manifestPath)
      const workspaceVersion = manifest.version
      if (workspaceVersion !== version) {
        mismatches.push(`${path.relative(root, manifestPath)} (${String(workspaceVersion)})`)
      }
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
          if (dependency.startsWith('@printstream/') && range !== version) {
            mismatches.push(`${path.relative(root, manifestPath)} ${field}.${dependency} (${String(range)})`)
          }
        }
      }
    }
  }

  if (mismatches.length > 0) {
    throw new Error(`Product version ${version} is not shared by: ${mismatches.join(', ')}`)
  }
  return version
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  console.log(readProductVersion())
}
