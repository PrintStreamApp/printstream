/**
 * Derives the standalone bridge download list served to the web app from the
 * promoted bridge build. Installs without a promoted build or published
 * standalone fragments (e.g. self-hosted, Docker-bridge-only) yield an empty
 * list, which the web UI treats as "no download section".
 */
import type { BridgeStandaloneDownload } from '@printstream/shared'
import { getBridgeReleaseManifest } from './bridge-update-policy.js'

export function listBridgeStandaloneDownloads(
  options: { releasesDir?: string, assetOrigin?: string | null } = {}
): BridgeStandaloneDownload[] {
  const manifest = getBridgeReleaseManifest(undefined, {
    ...(options.releasesDir ? { releasesDir: options.releasesDir } : {}),
    assetOrigin: options.assetOrigin ?? null
  })
  const build = manifest.current
  if (!build) return []

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
      fileName: fileNameFromUrl(url, platformKey, build.sourceFingerprint),
      sizeBytes: binary.sizeBytes,
      sha256: binary.sha256
    })
  }
  return downloads.sort((left, right) => left.platformKey.localeCompare(right.platformKey))
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
