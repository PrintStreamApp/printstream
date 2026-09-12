/**
 * Identity of the running app image, baked at Docker build time, plus the pure
 * logic that turns it into the `/api/app/version` payload.
 *
 * `app-build-metadata.json` is written by the Dockerfile from build ARGs:
 *  - `version`: the product SemVer shared by the release and its images.
 *  - `revision`: the git commit the image was built from.
 *  - `published`: "true" only for the open-core image published to GHCR (the
 *    public `docker-publish` workflow sets `PRINTSTREAM_IMAGE_PUBLISHED=true`).
 *    That image, and only that image, has a registry update channel.
 *
 * When Docker metadata is absent, native builds supply their baked identity
 * through env and source runs read the root package version. This keeps the
 * product version visible everywhere without exposing cloud revisions.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from './env.js'
import {
  EMPTY_APP_VERSION_RESPONSE,
  type AppUpdateInfo,
  type AppVersionResponse
} from '@printstream/shared'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const workspaceRoot = path.resolve(moduleDir, '../../../../')

export interface AppBuildInfo {
  /** Product SemVer, or null on legacy builds without product-version metadata. */
  version?: string | null
  /** Full git revision, or null when running from source / no baked identity. */
  revision: string | null
  /** Short form of `revision` for display, or null. */
  shortRevision: string | null
  /** True when this is the published open-core image (has an update channel). */
  published: boolean
}

const SHORT_REVISION_LENGTH = 7

export function shortenRevision(revision: string | null): string | null {
  if (!revision) return null
  return revision.slice(0, SHORT_REVISION_LENGTH)
}

interface AppBuildMetadataFile {
  version?: unknown
  revision?: unknown
  published?: unknown
}

function readBakedRevision(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed === 'unknown') return null
  return trimmed
}

let cachedBuildInfo: AppBuildInfo | undefined

/** Reads (and memoizes) the baked app-image identity. */
export function getAppBuildInfo(): AppBuildInfo {
  if (cachedBuildInfo) return cachedBuildInfo
  let version: string | null = null
  let revision: string | null = null
  let published = false
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(workspaceRoot, 'app-build-metadata.json'), 'utf8')
    ) as AppBuildMetadataFile
    version = readBakedRevision(parsed.version)
    revision = readBakedRevision(parsed.revision)
    published = parsed.published === 'true' || parsed.published === true
  } catch {
    // No metadata file. The native single-file app has no Docker build ARGs to
    // write one, so its host publishes the revision baked into the binary as
    // env instead (apps/server/src/run.ts), without this fallback the native
    // footer renders nothing at all, update notice included. `published` stays
    // false: that flag means the GHCR image channel specifically.
    version = readBakedRevision(env.PRINTSTREAM_SERVER_VERSION)
    revision = readBakedRevision(env.PRINTSTREAM_SERVER_BUILD_REVISION)
    if (!version) {
      try {
        const packageJson = JSON.parse(readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8')) as { version?: unknown }
        version = readBakedRevision(packageJson.version)
      } catch {
        // A bundled host supplies the version through env; a source checkout
        // supplies package.json. A legacy host can have neither.
      }
    }
  }
  // "published" is only meaningful alongside a real revision.
  cachedBuildInfo = {
    version,
    revision,
    shortRevision: shortenRevision(revision),
    published: published && revision != null
  }
  return cachedBuildInfo
}

/** Test seam: drop the memoized identity so a test can re-read the file. */
export function resetAppBuildInfoCache(): void {
  cachedBuildInfo = undefined
}

/**
 * Applies visibility and assembles the `/api/app/version` payload.
 *
 * Visibility:
 * Product SemVer is public to every viewer. Exact revisions remain scoped:
 * published and native installs show them to everyone, while cloud builds show
 * them only to platform users.
 *
 * `update` is included only for the published image, since only it has a
 * registry update channel.
 */
export function resolveAppVersionPayload(input: {
  build: AppBuildInfo
  isPlatformUser: boolean
  update: AppUpdateInfo | null
  /**
   * The native single-file app. It has its own update channel (the live
   * server's release manifest) and, like the published image, is a
   * single-operator install where the running build is not privileged
   * information.
   */
  native?: boolean
  /**
   * Whether THIS VIEWER may trigger the native in-place update. The route
   * computes it (permission + platform binary present); this only clamps it to
   * the cases where an update is actually on offer.
   */
  canApplyUpdate?: boolean
}): AppVersionResponse {
  const { build, isPlatformUser, update, native = false, canApplyUpdate = false } = input
  const revisionVisible = build.revision != null && (build.published || native || isPlatformUser)
  if (!build.version && !revisionVisible) return EMPTY_APP_VERSION_RESPONSE
  // Only a build with somewhere to get a newer one reports `update`; the cloud
  // image has no channel and its operators deploy it themselves.
  const hasUpdateChannel = build.published || native
  const shownUpdate = hasUpdateChannel ? update : null
  return {
    version: build.version ?? null,
    revision: revisionVisible ? build.revision : null,
    shortRevision: revisionVisible ? build.shortRevision : null,
    published: build.published,
    update: shownUpdate,
    canApplyUpdate: canApplyUpdate && native && shownUpdate?.status === 'updateAvailable' && shownUpdate.downloadUrl != null
  }
}
