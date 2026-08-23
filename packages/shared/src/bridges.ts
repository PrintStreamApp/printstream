/**
 * Bridge management contracts shared by the API and web client: the bridge
 * summary (connection stats and update status), update-status policy helpers,
 * standalone executable downloads, and the connect/update request shapes.
 */
import { z } from 'zod'

export const bridgeConnectionStatsSchema = z.object({
  connected: z.boolean(),
  connectedAt: z.string().datetime().nullable(),
  pendingRpcCount: z.number().int().nonnegative(),
  activeCameraWatchCount: z.number().int().nonnegative(),
  activePrinterFtpCount: z.number().int().nonnegative()
})

export type BridgeConnectionStats = z.infer<typeof bridgeConnectionStatsSchema>

export const bridgeUpdateStatusSchema = z.enum([
  'unknown',
  'current',
  'updateAvailable',
  // An automatic update to the server's current build failed its health check
  // and was rolled back; the bridge holds that build back until the server's
  // build changes or an operator forces a retry.
  'updateHeldBack',
  'updateRequired',
  'imageUpdateRequired',
  'runnerUpdateRequired',
  'unsupported'
])

export type BridgeUpdateStatus = z.infer<typeof bridgeUpdateStatusSchema>

/**
 * Bridge update-status policy helpers: the single source of truth shared by the API
 * (print guard) and the web (notices, gating, action buttons) so all three decisions
 * stay consistent.
 *
 * - `bridgeUpdateBlocksPrinting`: the bridge is too out-of-date / incompatible to be
 *   trusted with printer-affecting actions; printing must be prevented until it is
 *   updated.
 * - `bridgeUpdateNeedsAttention`: the bridge is not on the latest compatible release,
 *   so the user should be told (and offered an update), whether or not it blocks.
 * - `bridgeUpdateSupportsInAppUpdate`: the bridge can self-update its app bundle in
 *   place via `POST /api/bridges/:id/update/start`; image/runner updates instead need
 *   an operator image pull + restart and cannot be applied from the app.
 */
export function bridgeUpdateBlocksPrinting(status: BridgeUpdateStatus): boolean {
  // `imageUpdateRequired` does not block: the app code stays lockstep via
  // bundle self-updates, so a drifted runner image (stale node_modules /
  // base image) is a warning to rebuild, not an incompatibility. If the
  // image were truly missing something the code needs, the bridge would
  // fail visibly on its own.
  return status === 'updateRequired'
    || status === 'runnerUpdateRequired'
    || status === 'unsupported'
}

export function bridgeUpdateNeedsAttention(status: BridgeUpdateStatus): boolean {
  return status !== 'current' && status !== 'unknown'
}

export function bridgeUpdateSupportsInAppUpdate(status: BridgeUpdateStatus): boolean {
  return bridgeUpdateNeedsAttention(status)
    && status !== 'imageUpdateRequired'
    && status !== 'runnerUpdateRequired'
}

export const bridgeUpdateSummarySchema = z.object({
  status: bridgeUpdateStatusSchema,
  // Bridges have no release versions: builds are identified by the release
  // fingerprint (content hash) and described to humans by build revision/date.
  currentReleaseFingerprint: z.string().nullable(),
  latestReleaseFingerprint: z.string().nullable(),
  currentBuildRevision: z.string().nullable(),
  latestBuildRevision: z.string().nullable(),
  latestReleasedAt: z.string().datetime().nullable(),
  protocolVersion: z.number().int().nonnegative().nullable(),
  runnerAbiVersion: z.string().nullable(),
  lastCheckedAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
  manualUpdateCommand: z.string().nullable()
})

export type BridgeUpdateSummary = z.infer<typeof bridgeUpdateSummarySchema>

/**
 * Live state of a bridge's debug traffic capture. A capture is an
 * operator-triggered, time-bounded recording of the bridge↔printer transport
 * (MQTT/FTPS/camera/log frames) used to diagnose connectivity issues without
 * shell access to the bridge host. The bridge owns the capture and reports this
 * status to the API, which surfaces it here (for the "capture active" banner and
 * the settings controls) and broadcasts changes over the `bridge.debug.capture`
 * WS event. `hasCapture` stays true after a capture stops while its frames remain
 * buffered and downloadable.
 */
export const bridgeDebugCaptureStatusSchema = z.object({
  active: z.boolean(),
  startedAt: z.string().datetime().nullable(),
  stoppedAt: z.string().datetime().nullable(),
  frameCount: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  droppedFrames: z.number().int().nonnegative(),
  truncated: z.boolean(),
  hasCapture: z.boolean()
})

export type BridgeDebugCaptureStatus = z.infer<typeof bridgeDebugCaptureStatusSchema>

/** A bridge with no capture running and nothing buffered. */
export const inactiveBridgeDebugCaptureStatus: BridgeDebugCaptureStatus = {
  active: false,
  startedAt: null,
  stoppedAt: null,
  frameCount: 0,
  bytes: 0,
  droppedFrames: 0,
  truncated: false,
  hasCapture: false
}

/**
 * The bridge's self-reported crash health. A bridge reports a crash when it
 * detects on startup that its previous run died without a clean shutdown; the
 * API records the latest into these fields. Used to surface "unstable" /
 * "crash-looping" health in the UI.
 */
export const bridgeCrashHealthSchema = z.object({
  /** ISO timestamp of the most recent crash the bridge reported, or null if none. */
  lastCrashAt: z.string().datetime().nullable(),
  /** Crashes the bridge counted within its rolling window as of the last report. */
  recentCrashCount: z.number().int().nonnegative(),
  /** Short reason for the most recent crash (truncated), or null for a hard kill / unknown cause. */
  lastReason: z.string().nullable()
})
export type BridgeCrashHealth = z.infer<typeof bridgeCrashHealthSchema>

/** A bridge with no reported crashes. */
export const healthyBridgeCrashHealth: BridgeCrashHealth = {
  lastCrashAt: null,
  recentCrashCount: 0,
  lastReason: null
}

/** Rolling window over which bridge crashes are counted and treated as "recent". */
export const BRIDGE_CRASH_WINDOW_SECONDS = 3600
/** At or above this many crashes within the window, a bridge is treated as crash-looping. */
export const BRIDGE_CRASH_LOOP_THRESHOLD = 3

export type BridgeCrashState = 'healthy' | 'unstable' | 'looping'

/**
 * Derive a bridge's crash state from its reported crash health. A crash only
 * counts while it is inside the rolling window, a bridge that crashed once and
 * has been stable since reads as healthy again, so a stale count never pins the
 * UI to "unstable" forever.
 */
export function deriveBridgeCrashState(crash: BridgeCrashHealth, nowMs: number): BridgeCrashState {
  if (!crash.lastCrashAt) return 'healthy'
  const lastMs = Date.parse(crash.lastCrashAt)
  if (!Number.isFinite(lastMs)) return 'healthy'
  if (nowMs - lastMs > BRIDGE_CRASH_WINDOW_SECONDS * 1000) return 'healthy'
  return crash.recentCrashCount >= BRIDGE_CRASH_LOOP_THRESHOLD ? 'looping' : 'unstable'
}

/**
 * Live state of a bridge's on-disk backups. The bridge owns the backups
 * (snapshots of its identity file + library written to `BRIDGE_BACKUP_DIR`, a
 * directory outside its own data dir) and reports this status to the API, which
 * mirrors it into the bridge summary and broadcasts changes over the
 * `bridge.backup` WS event: same delivery shape as the debug-capture status.
 * `configured` is false when the bridge has no backup directory set (or the
 * bridge predates the feature and never reports).
 */
export const bridgeBackupStatusSchema = z.object({
  configured: z.boolean(),
  /** Backup directory as the bridge sees it (an operator path, not a secret). */
  directory: z.string().nullable(),
  /** Scheduled cadence in hours; 0 = manual backups only. Null when unconfigured. */
  intervalHours: z.number().nonnegative().nullable(),
  running: z.boolean(),
  snapshotCount: z.number().int().nonnegative(),
  lastBackupAt: z.string().datetime().nullable(),
  /** When the next scheduled backup becomes due; null when unconfigured or manual-only. */
  nextDueAt: z.string().datetime().nullable(),
  /** Why the most recent backup attempt failed, or null when it succeeded. */
  lastError: z.string().nullable()
})

export type BridgeBackupStatus = z.infer<typeof bridgeBackupStatusSchema>

/** A bridge with no backup directory configured (or one that never reported). */
export const unconfiguredBridgeBackupStatus: BridgeBackupStatus = {
  configured: false,
  directory: null,
  intervalHours: null,
  running: false,
  snapshotCount: 0,
  lastBackupAt: null,
  nextDueAt: null,
  lastError: null
}

/** One completed backup snapshot on the bridge's disk, as listed to the web. */
export const bridgeBackupSnapshotSchema = z.object({
  /** Snapshot directory name inside the backup dir (`backup-<timestamp>`). */
  name: z.string().min(1),
  createdAt: z.string().datetime(),
  trigger: z.enum(['scheduled', 'manual']),
  fileCount: z.number().int().nonnegative(),
  /** Logical size of the snapshot's files (hardlinked files count in full). */
  totalBytes: z.number().int().nonnegative(),
  /** Bytes physically copied by this run (the rest was hardlinked, unchanged). */
  copiedBytes: z.number().int().nonnegative(),
  /** Files skipped because they were still being written; picked up next run. */
  skippedInFlightCount: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative()
})

export type BridgeBackupSnapshot = z.infer<typeof bridgeBackupSnapshotSchema>

export const bridgeBackupListResponseSchema = z.object({
  status: bridgeBackupStatusSchema,
  snapshots: z.array(bridgeBackupSnapshotSchema)
})

export type BridgeBackupListResponse = z.infer<typeof bridgeBackupListResponseSchema>

export const bridgeSummarySchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  printerCount: z.number().int().nonnegative(),
  lastSeenAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  connectionStats: bridgeConnectionStatsSchema,
  update: bridgeUpdateSummarySchema,
  debugCapture: bridgeDebugCaptureStatusSchema,
  backup: bridgeBackupStatusSchema,
  crash: bridgeCrashHealthSchema
})

export type BridgeSummary = z.infer<typeof bridgeSummarySchema>

export const bridgeListResponseSchema = z.object({
  bridges: z.array(bridgeSummarySchema)
})

export type BridgeListResponse = z.infer<typeof bridgeListResponseSchema>

export const bridgeResponseSchema = z.object({
  bridge: bridgeSummarySchema
})

export type BridgeResponse = z.infer<typeof bridgeResponseSchema>

export const bridgeTestResponseSchema = z.object({
  respondedAt: z.string().datetime(),
  responseTimeMs: z.number().int().nonnegative()
})

export type BridgeTestResponse = z.infer<typeof bridgeTestResponseSchema>

export const bridgeUpdateActionResponseSchema = z.object({
  accepted: z.boolean(),
  status: bridgeUpdateStatusSchema,
  message: z.string().min(1)
})

export type BridgeUpdateActionResponse = z.infer<typeof bridgeUpdateActionResponseSchema>

export const bridgeStandaloneDownloadSchema = z.object({
  /** `${platform}-${arch}` of the packaged executable, e.g. `win32-x64`. */
  platformKey: z.string().min(1),
  buildRevision: z.string().nullable(),
  releasedAt: z.string().datetime(),
  url: z.string().min(1),
  fileName: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().min(1)
})

export type BridgeStandaloneDownload = z.infer<typeof bridgeStandaloneDownloadSchema>

/**
 * The origin a packaged bridge assumes when its config file names none.
 *
 * Baked into the standalone executable, so it cannot be varied per download:
 * the artifact is content-addressed and signed by CI, and rewriting it would
 * break the fingerprint the update mechanism compares. Shared so the server can
 * tell whether ITS origin is the one the binary would pick on its own.
 */
export const STANDALONE_BRIDGE_DEFAULT_SERVER_URL = 'https://printstream.app'

export const bridgeStandaloneDownloadsResponseSchema = z.object({
  downloads: z.array(bridgeStandaloneDownloadSchema),
  /**
   * The `BRIDGE_SERVER_URL` this server needs written into `bridge.env`, or
   * null when the executable's built-in default already points here.
   *
   * Null is the ordinary cloud case and renders NO extra step: a customer
   * downloading from printstream.app gets a binary that is already correct, and
   * an instruction to configure what is already configured invites them to
   * mistype it. Non-null is every other deployment, a staging host, and any
   * self-hosted server, whose bridges would otherwise register with the cloud.
   */
  serverUrlOverride: z.string().url().nullable().default(null),
  /**
   * Why the list is empty, when it is empty for a REASON rather than because
   * this deployment simply has no standalone bridge.
   *
   * Those two look identical on screen and mean very different things, and the
   * silent version is the dangerous one: a server whose promoted bridge does not
   * match it would otherwise present as a product without native installers.
   */
  unavailableReason: z.string().nullable().default(null)
})

export type BridgeStandaloneDownloadsResponse = z.infer<typeof bridgeStandaloneDownloadsResponseSchema>

export const connectBridgeRequestSchema = z.object({
  connectCode: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(120).optional()
})

export type ConnectBridgeRequest = z.infer<typeof connectBridgeRequestSchema>

export const updateBridgeRequestSchema = z.object({
  name: z.string().trim().min(1).max(120)
})

export type UpdateBridgeRequest = z.infer<typeof updateBridgeRequestSchema>
/**
 * Marker separating a bridge filename from the origin it was downloaded from.
 *
 * Deliberately unmistakable: the rest of the name is a fingerprint and a
 * platform key, both of which contain hyphens, so a shorter separator could be
 * produced by an ordinary name and misread as an origin.
 */
const FILE_NAME_ORIGIN_MARKER = '--from--'

/**
 * Encodes an origin into something legal in a filename.
 *
 * `:` and `/` are illegal or awkward on Windows and in shells, so `://` becomes
 * `--` and a port's `:` becomes `_`.
 *
 * **`https` is implied and omitted; `http` is spelled out.** These names are
 * long and the user is told to keep them, so the scheme is dead weight in the
 * case that covers every cloud, staging, and TLS-terminated self-host. It
 * cannot be dropped outright, though: a self-hosted server on plain http is
 * normal on a LAN, and assuming https there yields a bridge that cannot reach
 * its own server. Keeping the marker only for the exception buys the shorter
 * name without that failure, and, incidentally, still decodes the older
 * `https--` names, which are on disks already.
 *
 * **A subdomain of the default host is written as its label alone**, so
 * `https://staging.printstream.app` stamps as `staging`. That covers every
 * deployment of ours that is not production (production is the baked default and
 * is never stamped at all), which is the only case these names are routinely
 * read in. The suffix is DERIVED from the default server URL rather than written
 * out again, so the two cannot disagree, and anything that is not such a
 * subdomain, notably a self-hoster's own domain, still carries its full host.
 * Without that fallback the short form would silently resolve
 * `printstream.acme.com` to `acme.printstream.app`.
 */
const IMPLIED_FILE_NAME_SCHEME = 'https://'
const DEFAULT_FILE_NAME_HOST = new URL(STANDALONE_BRIDGE_DEFAULT_SERVER_URL).host

export function encodeOriginForFileName(origin: string): string {
  try {
    const url = new URL(origin)
    const suffix = `.${DEFAULT_FILE_NAME_HOST}`
    if (url.protocol === 'https:' && !url.port && url.host.endsWith(suffix)) {
      const label = url.host.slice(0, -suffix.length)
      // One label only: `a.b.printstream.app` would decode back as the single
      // label `a.b`, and a dot in the token is what marks a full host.
      if (label && !label.includes('.')) return label
    }
  } catch {
    // Not parseable as a URL: fall through to the literal encoding, which the
    // decoder will reject rather than turning into a plausible wrong origin.
  }
  const encoded = origin.replace('://', '--').replaceAll(':', '_')
  return encoded.startsWith('https--') ? encoded.slice('https--'.length) : encoded
}

/** Inverse of {@link encodeOriginForFileName}; null when the token is not an origin. */
export function decodeOriginFromFileName(token: string): string | null {
  // Anchored, not a contains-check: `--` is legal INSIDE a hostname (every
  // punycode label carries one, e.g. `xn--bcher-kva.de`), so only a leading
  // `http--`/`https--` can be the scheme separator.
  const explicitScheme = /^https?--/.test(token)
  // A bare label, no scheme, no dot, no port, is a subdomain of the default
  // host. Checked before the full-host path because that path requires a dot,
  // which is exactly what distinguishes the two forms.
  const bareLabel = !explicitScheme && !token.includes('.') && !token.includes('_')
  const restored = explicitScheme
    ? token.replace('--', '://').replaceAll('_', ':')
    : bareLabel
      ? `${IMPLIED_FILE_NAME_SCHEME}${token}.${DEFAULT_FILE_NAME_HOST}`
      : `${IMPLIED_FILE_NAME_SCHEME}${token.replaceAll('_', ':')}`
  try {
    const url = new URL(restored)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    // A bare token used to be rejected by `new URL` for having no scheme; now
    // that one is supplied, any junk word parses as a host. Require a dot on
    // that path so garbage stays garbage. Safe for the origins that reach it:
    // no CA issues certificates for single-label names, so an https origin
    // always has one, and a single-label intranet host is necessarily http,
    // which takes the explicit branch above and is not checked here.
    if (!explicitScheme && !bareLabel && !url.hostname.includes('.')) return null
    return url.origin
  } catch {
    return null
  }
}

/**
 * Stamps a download's origin into its filename, before any extension.
 *
 * The filename is the one piece of provenance that survives everything the
 * installer does to the file: Windows' own Mark of the Web is deleted by setup
 * before it elevates (SmartScreen refuses to elevate a marked executable), so a
 * retry after a failed install has already lost it, and retrying is exactly
 * what someone does after a failed install.
 */
export function stampDownloadFileNameWithOrigin(fileName: string, origin: string): string {
  const extension = fileName.endsWith('.exe') ? '.exe' : ''
  const base = extension ? fileName.slice(0, -extension.length) : fileName
  return `${base}${FILE_NAME_ORIGIN_MARKER}${encodeOriginForFileName(origin)}${extension}`
}

/**
 * Recovers the origin a stamped bridge filename carries, or null.
 *
 * Tolerates the `(1)` a browser appends when the file already exists, because a
 * second download attempt is common and silently falling back to the cloud is
 * the failure this exists to prevent.
 */
export function readOriginFromDownloadFileName(fileName: string): string | null {
  const withoutExtension = fileName.endsWith('.exe') ? fileName.slice(0, -'.exe'.length) : fileName
  const deduped = withoutExtension.replace(/\s*\(\d+\)\s*$/u, '')
  const markerAt = deduped.lastIndexOf(FILE_NAME_ORIGIN_MARKER)
  if (markerAt === -1) return null
  return decodeOriginFromFileName(deduped.slice(markerAt + FILE_NAME_ORIGIN_MARKER.length))
}
