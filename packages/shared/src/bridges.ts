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
 * Bridge update-status policy helpers — the single source of truth shared by the API
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

export const bridgeSummarySchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  printerCount: z.number().int().nonnegative(),
  lastSeenAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  connectionStats: bridgeConnectionStatsSchema,
  update: bridgeUpdateSummarySchema
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

export const bridgeStandaloneDownloadsResponseSchema = z.object({
  downloads: z.array(bridgeStandaloneDownloadSchema)
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