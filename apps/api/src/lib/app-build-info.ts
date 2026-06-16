/**
 * Identity of the running app image, baked at Docker build time, plus the pure
 * logic that turns it into the `/api/app/version` payload.
 *
 * `app-build-metadata.json` is written by the Dockerfile from build ARGs:
 *  - `revision`: the git commit the image was built from.
 *  - `published`: "true" only for the open-core image published to GHCR (the
 *    public `docker-publish` workflow sets `PRINTSTREAM_IMAGE_PUBLISHED=true`).
 *    That image — and only that image — has a registry update channel.
 *
 * When the file is absent or carries the "unknown" placeholder (a source/dev
 * run, or a build that did not pass the ARGs) there is no baked identity and
 * nothing is shown in the footer.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EMPTY_APP_VERSION_RESPONSE,
  type AppUpdateInfo,
  type AppVersionResponse
} from '@printstream/shared'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const workspaceRoot = path.resolve(moduleDir, '../../../../')

export interface AppBuildInfo {
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
  let revision: string | null = null
  let published = false
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(workspaceRoot, 'app-build-metadata.json'), 'utf8')
    ) as AppBuildMetadataFile
    revision = readBakedRevision(parsed.revision)
    published = parsed.published === 'true' || parsed.published === true
  } catch {
    // No metadata file: source/dev run.
  }
  // "published" is only meaningful alongside a real revision.
  cachedBuildInfo = {
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
 *  - published image -> shown to everyone (typical OSS self-host is single-tenant);
 *  - any other image with a baked revision -> shown to platform users only (the
 *    cloud image: operators see the running build, members do not);
 *  - no baked revision -> nothing to show.
 *
 * `update` is included only for the published image, since only it has a
 * registry update channel.
 */
export function resolveAppVersionPayload(input: {
  build: AppBuildInfo
  isPlatformUser: boolean
  update: AppUpdateInfo | null
}): AppVersionResponse {
  const { build, isPlatformUser, update } = input
  const visible = build.revision != null && (build.published || isPlatformUser)
  if (!visible) return EMPTY_APP_VERSION_RESPONSE
  return {
    revision: build.revision,
    shortRevision: build.shortRevision,
    published: build.published,
    update: build.published ? update : null
  }
}
