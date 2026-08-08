/**
 * Derives the standalone bridge download list served to the web app from the
 * promoted bridge build. Installs without a promoted build or published
 * standalone fragments (e.g. self-hosted, Docker-bridge-only) yield an empty
 * list, which the web UI treats as "no download section".
 *
 * A server only ever offers ITS OWN bridge: the promoted build must be the one
 * this server's commit expects, or nothing is offered. See
 * `describeBridgeReleaseConsistency`.
 */
import { stampDownloadFileNameWithOrigin, type BridgeStandaloneDownload } from '@printstream/shared'
import { describeBridgeReleaseConsistency, getBridgeReleaseManifest } from './bridge-update-policy.js'

/**
 * Why there is nothing to download, when the reason is not simply "no build".
 *
 * Returned alongside the list rather than left to the caller to infer: an empty
 * download section reads as "this deployment has no standalone bridge", which is
 * a different and much less alarming statement than "this server's bridge build
 * is missing". Distinguishing them is the whole point of withholding.
 */
export interface BridgeStandaloneDownloadsResult {
  downloads: BridgeStandaloneDownload[]
  unavailableReason: string | null
}

export function listBridgeStandaloneDownloads(
  options: { releasesDir?: string, assetOrigin?: string | null, serverUrlOverride?: string | null } = {}
): BridgeStandaloneDownloadsResult {
  // Checked BEFORE the manifest is read, so a mismatched build is never
  // formatted into a link — an offered download is an installed bridge.
  const consistency = describeBridgeReleaseConsistency(
    options.releasesDir ? { releasesDir: options.releasesDir } : {}
  )
  if (!consistency.matches) {
    return {
      downloads: [],
      unavailableReason:
        'The bridge build published here does not match this server. It will reappear once a deploy promotes the matching build.'
    }
  }

  const manifest = getBridgeReleaseManifest(undefined, {
    ...(options.releasesDir ? { releasesDir: options.releasesDir } : {}),
    assetOrigin: options.assetOrigin ?? null
  })
  const build = manifest.current
  if (!build) return { downloads: [], unavailableReason: null }

  const downloads: BridgeStandaloneDownload[] = []
  for (const [platformKey, binary] of Object.entries(build.binaries ?? {})) {
    // Browsers need the uncompressed artifact; gzip-published entries without
    // a downloadUrl have nothing suitable to link.
    const url = binary.compression ? binary.downloadUrl : (binary.downloadUrl ?? binary.url)
    if (!url) continue
    downloads.push({
      platformKey,
      buildRevision: build.buildRevision,
      releasedAt: build.releasedAt,
      url,
      // Stamped only when this server is NOT the origin baked into the binary:
      // a cloud download keeps its plain name, since the default is already
      // right and a decorated filename would be noise on every customer's disk.
      fileName: options.serverUrlOverride
        ? stampDownloadFileNameWithOrigin(fileNameFromUrl(url, platformKey, build.sourceFingerprint), options.serverUrlOverride)
        : fileNameFromUrl(url, platformKey, build.sourceFingerprint),
      sizeBytes: binary.sizeBytes,
      sha256: binary.sha256
    })
  }
  downloads.sort((left, right) => left.platformKey.localeCompare(right.platformKey))
  return { downloads, unavailableReason: null }
}

function fileNameFromUrl(url: string, platformKey: string, sourceFingerprint: string): string {
  try {
    const segments = new URL(url).pathname.split('/')
    const last = segments[segments.length - 1]
    if (last) return decodeURIComponent(last)
  } catch {
    // Fall through to the synthesized name.
  }
  return `printstream-bridge-${sourceFingerprint.slice(0, 12)}-${platformKey}`
}
