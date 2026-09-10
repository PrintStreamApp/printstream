/**
 * Bridge-to-server runtime protocol contracts shared by the API and the bridge:
 * registration/handshake, the WebSocket message union (RPC, heartbeats, printer
 * status/discovery, camera frames), the RPC params/results for printer storage,
 * library file access, 3MF inspection, and the Bambu cloud relay, and the
 * release/update manifest.
 */
import { z } from 'zod'
import { bambuCloudRequestSchema, bambuCloudResponseSchema } from './bambu-cloud.js'
import { threeMfSettingsRepairReasonSchema } from './printer-contracts.js'
import {
  bridgeBackupSnapshotSchema,
  bridgeBackupStatusSchema,
  bridgeDebugCaptureStatusSchema,
  bridgeSummarySchema,
  bridgeUpdateActionResponseSchema
} from './bridges.js'
import { logLevelSchema } from './logs.js'
import {
  discoveredPrinterSchema,
  printerConnectionValidationInputSchema,
  printerConnectionValidationSchema,
  printerModelSchema,
  printerSchema,
  printerStatusSchema
} from './printer.js'

export const bridgeRuntimeRegistrationRequestSchema = z.object({
  bridgeId: z.string().trim().min(1).optional(),
  runtimeToken: z.string().trim().min(1).optional(),
  /**
   * Durable per-install identity, generated once by the bridge and persisted
   * across credential resets (unlike `bridgeId`/`runtimeToken`, which the bridge
   * clears when a server rejects them). Lets the server recognize a returning
   * physical bridge whose runtime credentials were lost: e.g. after pointing it
   * at a different database, and re-bind it to its existing record (keeping its
   * printers and library) instead of minting a duplicate bridge. High-entropy and
   * treated as a secret: never logged or surfaced to the browser.
   */
  installationId: z.string().trim().min(1).max(200).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  version: z.string().trim().min(1).max(64).optional(),
  buildRevision: z.string().trim().min(1).max(120).optional(),
  sourceFingerprint: z.string().trim().min(1).max(120).optional(),
  protocolVersion: z.number().int().nonnegative().optional(),
  runnerAbiVersion: z.string().trim().min(1).max(120).optional(),
  releaseFingerprint: z.string().trim().min(1).max(120).optional(),
  /**
   * The host OS and CPU the bridge runs on (`process.platform` / `process.arch`, e.g. "win32" and
   * "x64"). Recorded because packaging-level behaviour differs by OS and nothing else in a Bridge
   * row says which one it is: when a Windows service-recovery defect turned up, there was no way to
   * ask how many Windows bridges were in the field, only to guess from install names. Optional, so
   * a bridge older than this field reads as "platform unknown" rather than being rejected.
   */
  platform: z.string().trim().min(1).max(40).optional(),
  arch: z.string().trim().min(1).max(40).optional(),
  /**
   * Managed-bridge provisioning token. When a self-hosted server runs in
   * managed-bridge mode and this matches the server-generated token, the bridge
   * is auto-paired into the sole workspace at registration so the operator never
   * sees the connect-code ceremony. The bundled bridge reads the token from a
   * file shared with the API. Absent in cloud and remote-bridge installs, which
   * keep manual pairing.
   */
  provisionSecret: z.string().trim().min(12).max(200).optional(),
  /** Legacy field from versioned bridges; ignored. */
  updateChannel: z.string().trim().optional()
})

export type BridgeRuntimeRegistrationRequest = z.infer<typeof bridgeRuntimeRegistrationRequestSchema>

export const bridgeRuntimeRegistrationResponseSchema = z.object({
  bridge: bridgeSummarySchema.extend({
    connectCode: z.string().min(1).max(120).nullable()
  }),
  runtimeToken: z.string().min(1),
  connectPath: z.string().min(1),
  heartbeatIntervalSeconds: z.number().int().positive()
})

export type BridgeRuntimeRegistrationResponse = z.infer<typeof bridgeRuntimeRegistrationResponseSchema>

export const bridgeRuntimeHelloMessageSchema = z.object({
  type: z.literal('bridge.hello'),
  bridgeId: z.string().min(1),
  runtimeToken: z.string().min(1),
  version: z.string().trim().min(1).max(64).optional(),
  buildRevision: z.string().trim().min(1).max(120).optional(),
  sourceFingerprint: z.string().trim().min(1).max(120).optional(),
  protocolVersion: z.number().int().nonnegative().optional(),
  runnerAbiVersion: z.string().trim().min(1).max(120).optional(),
  releaseFingerprint: z.string().trim().min(1).max(120).optional(),
  /**
   * The host OS and CPU the bridge runs on (`process.platform` / `process.arch`, e.g. "win32" and
   * "x64"). Recorded because packaging-level behaviour differs by OS and nothing else in a Bridge
   * row says which one it is: when a Windows service-recovery defect turned up, there was no way to
   * ask how many Windows bridges were in the field, only to guess from install names. Optional, so
   * a bridge older than this field reads as "platform unknown" rather than being rejected.
   */
  platform: z.string().trim().min(1).max(40).optional(),
  arch: z.string().trim().min(1).max(40).optional(),
  /** Legacy field from versioned bridges; ignored. */
  updateChannel: z.string().trim().optional()
})

export const bridgeRuntimeWelcomeMessageSchema = z.object({
  type: z.literal('bridge.welcome'),
  bridgeId: z.string().min(1),
  connected: z.boolean(),
  workspaceId: z.string().min(1).nullable(),
  heartbeatIntervalSeconds: z.number().int().positive()
})

export const bridgeRpcRequestMessageSchema = z.object({
  type: z.literal('bridge.rpc.request'),
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown()
})

export const bridgeRpcCancelMessageSchema = z.object({
  type: z.literal('bridge.rpc.cancel'),
  id: z.string().min(1)
})

export const bridgeRpcSuccessMessageSchema = z.object({
  type: z.literal('bridge.rpc.success'),
  id: z.string().min(1),
  result: z.unknown()
})

export const bridgeRpcProgressMessageSchema = z.object({
  type: z.literal('bridge.rpc.progress'),
  id: z.string().min(1),
  bytesSent: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative().nullable().optional()
})

export const bridgeRpcErrorMessageSchema = z.object({
  type: z.literal('bridge.rpc.error'),
  id: z.string().min(1),
  error: z.string().min(1)
})

export const bridgeCommandMessageSchema = z.object({
  type: z.literal('bridge.command'),
  printer: printerSchema,
  payload: z.record(z.unknown())
})

export const bridgePrintersConfigMessageSchema = z.object({
  type: z.literal('bridge.printers.config'),
  printers: z.array(printerSchema)
})

export const bridgeHeartbeatMessageSchema = z.object({
  type: z.literal('bridge.heartbeat')
})

/**
 * A point-in-time reading of bridge-local metrics. The bridge ships plain
 * numbers (no telemetry runtime of its own); the API re-exposes them on its
 * Prometheus endpoint labelled by bridge/workspace. Gauges are instantaneous;
 * `apiReconnectsTotal` is cumulative since the bridge process started (it may
 * reset to 0 on bridge restart: Prometheus handles counter resets).
 */
export const bridgeMetricsSnapshotSchema = z.object({
  printersMonitored: z.number().int().nonnegative(),
  printersConnected: z.number().int().nonnegative(),
  eventLoopLagSeconds: z.number().nonnegative(),
  memoryRssBytes: z.number().nonnegative(),
  apiReconnectsTotal: z.number().int().nonnegative()
})

export type BridgeMetricsSnapshot = z.infer<typeof bridgeMetricsSnapshotSchema>

export const bridgeMetricsMessageSchema = z.object({
  type: z.literal('bridge.metrics'),
  metrics: bridgeMetricsSnapshotSchema
})

/**
 * A crash the bridge detected about *itself*: it noticed on startup that its
 * previous run terminated without a clean shutdown. The bridge reports this once
 * per surviving run (on session (re)connect); a crash-loop therefore produces one
 * report per restart, and the API rate-limits the user-facing notification.
 */
export const bridgeCrashReportSchema = z.object({
  /**
   * Error message + truncated stack captured by the crashing run's fatal handler,
   * or null when the crash left no JS-level reason (hard kill: OOM / SIGKILL /
   * native fault).
   */
  reason: z.string().max(4000).nullable(),
  /** ISO timestamp of when the crashed run had started. */
  crashedRunStartedAt: z.string(),
  /** ISO timestamp of when the surviving run detected the crash (≈ crash time). */
  detectedAt: z.string(),
  /** Crashes within the rolling window, including the one being reported (≥ 1). */
  recentCrashCount: z.number().int().positive(),
  /** Length of the rolling window `recentCrashCount` is measured over. */
  windowSeconds: z.number().int().positive()
})

export type BridgeCrashReport = z.infer<typeof bridgeCrashReportSchema>

export const bridgeCrashReportMessageSchema = z.object({
  type: z.literal('bridge.crash.report'),
  report: bridgeCrashReportSchema
})

export const bridgePrinterStatusMessageSchema = z.object({
  type: z.literal('bridge.printer.status'),
  printer: printerStatusSchema
})

export const bridgePrinterReportMessageSchema = z.object({
  type: z.literal('bridge.printer.report'),
  printerId: z.string().min(1),
  report: z.unknown()
})

export const bridgePrinterOfflineMessageSchema = z.object({
  type: z.literal('bridge.printer.offline'),
  printerId: z.string().min(1)
})

export const bridgePrinterRemovedMessageSchema = z.object({
  type: z.literal('bridge.printer.removed'),
  printerId: z.string().min(1)
})

export const bridgePrinterDiscoveredMessageSchema = z.object({
  type: z.literal('bridge.printer.discovered'),
  printers: z.array(discoveredPrinterSchema)
})

/**
 * Result of the bridge's periodic per-printer LAN connection probe, pushed
 * unsolicited so the API can surface a "not in LAN/developer mode" warning on
 * the printer card without the operator opening the edit dialog.
 */
export const bridgePrinterConnectionMessageSchema = z.object({
  type: z.literal('bridge.printer.connection'),
  printerId: z.string().min(1),
  validation: printerConnectionValidationSchema
})

export type BridgePrinterConnectionMessage = z.infer<typeof bridgePrinterConnectionMessageSchema>

export const bridgePrinterValidationParamsSchema = printerConnectionValidationInputSchema

export type BridgePrinterValidationParams = z.infer<typeof bridgePrinterValidationParamsSchema>

export const bridgePrinterValidationResultSchema = printerConnectionValidationSchema

export type BridgePrinterValidationResult = z.infer<typeof bridgePrinterValidationResultSchema>

export const bridgePingParamsSchema = z.object({
  requestedAt: z.string().datetime().optional()
})

export type BridgePingParams = z.infer<typeof bridgePingParamsSchema>

export const bridgePingResultSchema = z.object({
  respondedAt: z.string().datetime()
})

export type BridgePingResult = z.infer<typeof bridgePingResultSchema>

/**
 * One captured bridge console line. The bridge logs to stdout/stderr, which the
 * Docker runner exposes via `docker logs` but the standalone (native) build
 * redirects to an on-disk file the operator can't easily reach. To make bridge
 * diagnostics visible in the web app regardless of packaging, the bridge keeps a
 * bounded in-memory ring buffer and serves it over the `system.logs` RPC.
 */
export const bridgeSystemLogEntrySchema = z.object({
  timestamp: z.string().datetime(),
  level: logLevelSchema,
  message: z.string()
})

export type BridgeSystemLogEntry = z.infer<typeof bridgeSystemLogEntrySchema>

export const bridgeSystemLogsParamsSchema = z.object({
  limit: z.number().int().positive().max(1000).optional()
})

export type BridgeSystemLogsParams = z.infer<typeof bridgeSystemLogsParamsSchema>

export const bridgeSystemLogsResultSchema = z.object({
  entries: z.array(bridgeSystemLogEntrySchema)
})

export type BridgeSystemLogsResult = z.infer<typeof bridgeSystemLogsResultSchema>

/**
 * One recorded frame of bridge↔printer transport during a debug capture. The
 * bridge taps every MQTT send/receive, FTPS activity toggle, camera lifecycle
 * event, connection transition, and its own console log, tags each with a
 * monotonic `seq` + timestamp, and buffers them for download. `payload` carries
 * the parsed MQTT JSON or event detail; it never includes the LAN access code or
 * other connection secrets (see the capture redaction rules on the bridge).
 */
export const bridgeDebugCaptureFrameSchema = z.object({
  seq: z.number().int().nonnegative(),
  at: z.string().datetime(),
  kind: z.enum(['mqtt', 'ftps', 'camera', 'log', 'connection']),
  direction: z.enum(['rx', 'tx']).optional(),
  printerId: z.string().optional(),
  printerName: z.string().optional(),
  topic: z.string().optional(),
  summary: z.string().optional(),
  payload: z.unknown().optional()
})

export type BridgeDebugCaptureFrame = z.infer<typeof bridgeDebugCaptureFrameSchema>

export const bridgeDebugCaptureStartParamsSchema = z.object({
  maxDurationMs: z.number().int().positive().optional(),
  maxFrames: z.number().int().positive().optional(),
  maxBytes: z.number().int().positive().optional()
})

export type BridgeDebugCaptureStartParams = z.infer<typeof bridgeDebugCaptureStartParamsSchema>

export const bridgeDebugCaptureStopParamsSchema = z.object({})

export type BridgeDebugCaptureStopParams = z.infer<typeof bridgeDebugCaptureStopParamsSchema>

export const bridgeDebugCaptureReadParamsSchema = z.object({})

export type BridgeDebugCaptureReadParams = z.infer<typeof bridgeDebugCaptureReadParamsSchema>

/** Result of start/stop/status RPCs: the bridge's current capture status. */
export const bridgeDebugCaptureStatusResultSchema = bridgeDebugCaptureStatusSchema

export type BridgeDebugCaptureStatusResult = z.infer<typeof bridgeDebugCaptureStatusResultSchema>

export const bridgeDebugCaptureReadResultSchema = z.object({
  startedAt: z.string().datetime().nullable(),
  stoppedAt: z.string().datetime().nullable(),
  frames: z.array(bridgeDebugCaptureFrameSchema),
  droppedFrames: z.number().int().nonnegative(),
  truncated: z.boolean()
})

export type BridgeDebugCaptureReadResult = z.infer<typeof bridgeDebugCaptureReadResultSchema>

/** Pushed bridge→API whenever capture starts, stops, or auto-stops. */
export const bridgeDebugCaptureStatusMessageSchema = z.object({
  type: z.literal('bridge.debug.capture.status'),
  status: bridgeDebugCaptureStatusSchema
})

export type BridgeDebugCaptureStatusMessage = z.infer<typeof bridgeDebugCaptureStatusMessageSchema>

/**
 * On-disk backup RPCs (`bridge.backup.*`), mirroring the debug-capture trio.
 * `run` only STARTS a backup (a first full copy can take minutes, far past the
 * RPC timeout) and returns the status snapshot with `running: true`; completion
 * arrives as a pushed `bridge.backup.status` message. Counterparts:
 * `apps/bridge/src/backup-manager.ts` and `apps/api/src/routes/bridges.ts`.
 */
export const bridgeBackupRunParamsSchema = z.object({})

export type BridgeBackupRunParams = z.infer<typeof bridgeBackupRunParamsSchema>

export const bridgeBackupListParamsSchema = z.object({})

export type BridgeBackupListParams = z.infer<typeof bridgeBackupListParamsSchema>

export const bridgeBackupStatusResultSchema = bridgeBackupStatusSchema

export type BridgeBackupStatusResult = z.infer<typeof bridgeBackupStatusResultSchema>

export const bridgeBackupListResultSchema = z.object({
  snapshots: z.array(bridgeBackupSnapshotSchema)
})

export type BridgeBackupListResult = z.infer<typeof bridgeBackupListResultSchema>

/** Pushed bridge→API when a backup starts, finishes, or fails (and on connect). */
export const bridgeBackupStatusMessageSchema = z.object({
  type: z.literal('bridge.backup.status'),
  status: bridgeBackupStatusSchema
})

export type BridgeBackupStatusMessage = z.infer<typeof bridgeBackupStatusMessageSchema>

export const bridgeReleaseBinarySchema = z.object({
  url: z.string().url(),
  sha256: z.string().min(1),
  signature: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  /**
   * Transfer encoding of the asset at `url`. `sha256`, `signature`, and
   * `sizeBytes` always describe the decompressed executable.
   */
  compression: z.enum(['gzip']).optional(),
  /** Uncompressed, browser-friendly download URL for humans installing a bridge. */
  downloadUrl: z.string().url().optional(),
  /**
   * Minimum runner ABI this binary's installer must speak. One merged build
   * describes two runner families (Docker bundle + standalone binaries), so
   * compatibility coordinates live on the artifact; the build's top-level
   * coordinates describe the Docker runner family for legacy readers.
   */
  minimumRunnerAbiVersion: z.string().min(1).optional()
})

export type BridgeReleaseBinary = z.infer<typeof bridgeReleaseBinarySchema>

/**
 * A publishable bridge build, identified by its release fingerprint (a content
 * hash over the bridge-relevant sources) rather than a version number. Bridges
 * stay lockstep with their server: the manifest announces the server's current
 * build and every bridge whose fingerprint differs updates to it (including
 * downgrades after a server rollback).
 */
export const bridgeBuildSchema = z.object({
  sourceFingerprint: z.string().min(1),
  buildRevision: z.string().min(1).nullable(),
  protocolVersion: z.number().int().nonnegative(),
  runnerAbiVersion: z.string().min(1),
  minimumRunnerAbiVersion: z.string().min(1),
  releasedAt: z.string().datetime(),
  notesUrl: z.string().url().nullable(),
  /**
   * Docker app bundle: the slim bridge image's single esbuild-bundled runner
   * file, published gzipped. `sha256`/`sizeBytes`/`signature` describe the
   * DECOMPRESSED file (same convention as `binaries`). The slim image's
   * launcher activates it in place; `null` when no bundle is published (older
   * manifests, or builds that only shipped standalone binaries).
   */
  bundle: z.object({
    url: z.string().url(),
    sha256: z.string().min(1),
    signature: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    /**
     * Docker runner ABI this bundle requires, an EXACT match with the
     * image-baked `BRIDGE_RUNNER_ABI_VERSION` (which embeds the pinned Node
     * version), so a bundle never runs on a different runtime than it was
     * built for.
     */
    minimumRunnerAbiVersion: z.string().min(1).optional()
  }).nullable(),
  /**
   * Standalone single-executable builds keyed by
   * `${process.platform}-${process.arch}` (e.g. `linux-x64`, `win32-x64`).
   */
  binaries: z.record(bridgeReleaseBinarySchema).optional()
})

export type BridgeBuild = z.infer<typeof bridgeBuildSchema>

export const bridgeReleaseManifestSchema = z.object({
  schemaVersion: z.literal(2),
  generatedAt: z.string().datetime(),
  minimumSupportedProtocol: z.number().int().nonnegative(),
  /** The build the server runs; null until a build has been promoted. */
  current: bridgeBuildSchema.nullable()
})

export type BridgeReleaseManifest = z.infer<typeof bridgeReleaseManifestSchema>

export const bridgeUpdateCheckParamsSchema = z.object({
  requestedAt: z.string().datetime().optional()
})

export type BridgeUpdateCheckParams = z.infer<typeof bridgeUpdateCheckParamsSchema>

export const bridgeUpdateInstallParamsSchema = z.object({
  requestedAt: z.string().datetime().optional()
})

export type BridgeUpdateInstallParams = z.infer<typeof bridgeUpdateInstallParamsSchema>

export const bridgeUpdateActionResultSchema = bridgeUpdateActionResponseSchema

export type BridgeUpdateActionResult = z.infer<typeof bridgeUpdateActionResultSchema>

export const bridgeCameraSnapshotParamsSchema = z.object({
  printer: printerSchema
})

export type BridgeCameraSnapshotParams = z.infer<typeof bridgeCameraSnapshotParamsSchema>

export const bridgeCameraSnapshotResultSchema = z.object({
  jpegBase64: z.string().min(1)
})

export type BridgeCameraSnapshotResult = z.infer<typeof bridgeCameraSnapshotResultSchema>

export const bridgeCameraWatchMessageSchema = z.object({
  type: z.literal('bridge.camera.watch'),
  printerId: z.string().min(1)
})

export type BridgeCameraWatchMessage = z.infer<typeof bridgeCameraWatchMessageSchema>

export const bridgeCameraUnwatchMessageSchema = z.object({
  type: z.literal('bridge.camera.unwatch'),
  printerId: z.string().min(1)
})

export type BridgeCameraUnwatchMessage = z.infer<typeof bridgeCameraUnwatchMessageSchema>

export const bridgeCameraFrameMessageSchema = z.object({
  type: z.literal('bridge.camera.frame'),
  printerId: z.string().min(1),
  jpegBase64: z.string().min(1)
})

export type BridgeCameraFrameMessage = z.infer<typeof bridgeCameraFrameMessageSchema>

export const bridgePrinterFtpActivityMessageSchema = z.object({
  type: z.literal('bridge.printer.ftps.active'),
  printerId: z.string().min(1),
  active: z.boolean()
})

export type BridgePrinterFtpActivityMessage = z.infer<typeof bridgePrinterFtpActivityMessageSchema>

export const bridgePrinterStorageEntrySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1).optional(),
  type: z.enum(['file', 'directory']),
  sizeBytes: z.number().int().nonnegative(),
  modifiedAt: z.string().datetime().nullable()
})

export type BridgePrinterStorageEntry = z.infer<typeof bridgePrinterStorageEntrySchema>

export const bridgeStorageListParamsSchema = z.object({
  printer: printerSchema,
  path: z.string().min(1),
  recursive: z.boolean().default(false),
  maxDepth: z.number().int().positive().default(4)
})

export type BridgeStorageListParams = z.infer<typeof bridgeStorageListParamsSchema>

export const bridgeStorageListResultSchema = z.object({
  entries: z.array(bridgePrinterStorageEntrySchema)
})

export type BridgeStorageListResult = z.infer<typeof bridgeStorageListResultSchema>

export const bridgeStorageUploadParamsSchema = z.object({
  printer: printerSchema,
  remotePath: z.string().min(1),
  fileBase64: z.string().min(1)
})

export type BridgeStorageUploadParams = z.infer<typeof bridgeStorageUploadParamsSchema>

export const bridgeStorageUploadResultSchema = z.object({
  path: z.string().min(1),
  sizeBytes: z.number().int().nonnegative().nullable().optional()
})

export type BridgeStorageUploadResult = z.infer<typeof bridgeStorageUploadResultSchema>

export const bridgeStorageUploadLibraryParamsSchema = z.object({
  printer: printerSchema,
  remotePath: z.string().min(1),
  storedPath: z.string().min(1)
})

export type BridgeStorageUploadLibraryParams = z.infer<typeof bridgeStorageUploadLibraryParamsSchema>

export const bridgeStorageUploadLibraryPlateParamsSchema = z.object({
  printer: printerSchema,
  remotePath: z.string().min(1),
  storedPath: z.string().min(1),
  plate: z.number().int().positive()
})

export type BridgeStorageUploadLibraryPlateParams = z.infer<typeof bridgeStorageUploadLibraryPlateParamsSchema>

export const bridgeStorageDownloadParamsSchema = z.object({
  printer: printerSchema,
  candidates: z.array(z.string().min(1)).optional(),
  remotePath: z.string().min(1).optional(),
  startAt: z.number().int().nonnegative().optional(),
  maxBytes: z.number().int().positive().optional(),
  truncateAtMaxBytes: z.boolean().optional()
})

export type BridgeStorageDownloadParams = z.infer<typeof bridgeStorageDownloadParamsSchema>

export const bridgeStorageDownloadResultSchema = z.object({
  bufferBase64: z.string().nullable()
})

export type BridgeStorageDownloadResult = z.infer<typeof bridgeStorageDownloadResultSchema>

export const bridgeStorageFileSizeParamsSchema = z.object({
  printer: printerSchema,
  remotePath: z.string().min(1)
})

export type BridgeStorageFileSizeParams = z.infer<typeof bridgeStorageFileSizeParamsSchema>

export const bridgeStorageFileSizeResultSchema = z.object({
  sizeBytes: z.number().int().nonnegative()
})

export type BridgeStorageFileSizeResult = z.infer<typeof bridgeStorageFileSizeResultSchema>

export const bridgeStorageRenameParamsSchema = z.object({
  printer: printerSchema,
  fromPath: z.string().min(1),
  toPath: z.string().min(1)
})

export type BridgeStorageRenameParams = z.infer<typeof bridgeStorageRenameParamsSchema>

export const bridgeStorageDeleteParamsSchema = z.object({
  printer: printerSchema,
  path: z.string().min(1),
  type: z.enum(['file', 'directory'])
})

export type BridgeStorageDeleteParams = z.infer<typeof bridgeStorageDeleteParamsSchema>

export const bridgeStorageReadZipEntriesParamsSchema = z.object({
  printer: printerSchema,
  remotePath: z.string().min(1),
  entryPaths: z.array(z.string().min(1)).min(1),
  tailScanBytes: z.number().int().positive().default(256 * 1024),
  maxSuffixBytes: z.number().int().positive().default(8 * 1024 * 1024)
})

export type BridgeStorageReadZipEntriesParams = z.infer<typeof bridgeStorageReadZipEntriesParamsSchema>

export const bridgeStorageReadZipEntriesResultSchema = z.object({
  /** Extracted entries keyed by path, values are base64-encoded. */
  entries: z.record(z.string(), z.string()),
  /** Remote file size in bytes. */
  remoteSize: z.number().int().nonnegative(),
  /** Total bytes read from the printer. */
  bytesRead: z.number().int().nonnegative()
})

export type BridgeStorageReadZipEntriesResult = z.infer<typeof bridgeStorageReadZipEntriesResultSchema>

export const bridgeLibraryStoreParamsSchema = z.object({
  storedPath: z.string().min(1),
  fileBase64: z.string().min(1)
})

export type BridgeLibraryStoreParams = z.infer<typeof bridgeLibraryStoreParamsSchema>

export const bridgeLibraryStoreStartParamsSchema = z.object({
  storedPath: z.string().min(1)
})

export type BridgeLibraryStoreStartParams = z.infer<typeof bridgeLibraryStoreStartParamsSchema>

export const bridgeLibraryStoreChunkParamsSchema = z.object({
  storedPath: z.string().min(1),
  chunkBase64: z.string()
})

export type BridgeLibraryStoreChunkParams = z.infer<typeof bridgeLibraryStoreChunkParamsSchema>

export const bridgeLibraryReadParamsSchema = z.object({
  storedPath: z.string().min(1)
})

export type BridgeLibraryReadParams = z.infer<typeof bridgeLibraryReadParamsSchema>

export const bridgeLibraryReadChunkParamsSchema = z.object({
  storedPath: z.string().min(1),
  offset: z.number().int().nonnegative(),
  maxBytes: z.number().int().positive()
})

export type BridgeLibraryReadChunkParams = z.infer<typeof bridgeLibraryReadChunkParamsSchema>

export const bridgeLibraryReadResultSchema = z.object({
  bufferBase64: z.string().nullable()
})

export type BridgeLibraryReadResult = z.infer<typeof bridgeLibraryReadResultSchema>

export const bridgeLibraryReadChunkResultSchema = z.object({
  bufferBase64: z.string().nullable(),
  eof: z.boolean(),
  sizeBytes: z.number().int().nonnegative().optional()
})

export type BridgeLibraryReadChunkResult = z.infer<typeof bridgeLibraryReadChunkResultSchema>

export const bridgeLibraryStatParamsSchema = z.object({
  storedPath: z.string().min(1)
})

export type BridgeLibraryStatParams = z.infer<typeof bridgeLibraryStatParamsSchema>

export const bridgeLibraryStatResultSchema = z.object({
  sizeBytes: z.number().int().nonnegative(),
  contentSha256: z.string().length(64)
})

export type BridgeLibraryStatResult = z.infer<typeof bridgeLibraryStatResultSchema>

export const bridgeLibraryCopyParamsSchema = z.object({
  sourceStoredPath: z.string().min(1),
  targetStoredPath: z.string().min(1)
})

export type BridgeLibraryCopyParams = z.infer<typeof bridgeLibraryCopyParamsSchema>

export const bridgeLibraryDeleteParamsSchema = z.object({
  storedPath: z.string().min(1)
})

export type BridgeLibraryDeleteParams = z.infer<typeof bridgeLibraryDeleteParamsSchema>

export const bridgeLibraryThreeMfObjectSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  /**
   * `identify_id`s of this object's `model_instance`s on the plate: the per-instance
   * handles Bambu firmware keys `skip_objects` on. From `model_settings.config` when the
   * index is model-settings derived (one per instance), or the entry's own slice_info
   * `identify_id` when slice_info supplied the objects. Empty when the file carries none.
   * Defaulted so payloads from older bridges still parse.
   */
  identifyIds: z.array(z.number().int()).default([]),
  /**
   * This object's per-object PROCESS overrides from `model_settings.config`, so a surface that
   * never loads the scene (the prepare-print dialog) can both SHOW them and re-send them intact.
   * Sending a partial set is not a display bug: the slice-time transform is authoritative per
   * object and drops whatever the map omits. Defaulted so payloads from older bridges still parse.
   */
  processOverrides: z.record(z.string().min(1), z.string()).default({})
})

export type BridgeLibraryThreeMfObject = z.infer<typeof bridgeLibraryThreeMfObjectSchema>

export const bridgeLibraryThreeMfFilamentSchema = z.object({
  id: z.number().int().positive(),
  filamentType: z.string().nullable(),
  filamentName: z.string().nullable(),
  color: z.string().nullable(),
  usedGrams: z.number().nullable(),
  usedMeters: z.number().nullable(),
  nozzleId: z.number().int().nonnegative().nullable(),
  nozzleDiameter: z.string().nullable(),
  chamberTemperature: z.number().nullable()
})

export type BridgeLibraryThreeMfFilament = z.infer<typeof bridgeLibraryThreeMfFilamentSchema>

export const bridgeLibraryThreeMfProjectFilamentSchema = z.object({
  id: z.number().int().positive(),
  filamentType: z.string().nullable(),
  filamentName: z.string().nullable(),
  /**
   * The slot's raw `filament_settings_id`: the name BambuStudio looks a preset up by. Optional
   * because a bridge on an older parser sends none; treat absent as "identity unknown" and fall
   * back to `filamentName`, which is a DISPLAY value and cannot identify a preset on its own.
   */
  filamentPresetName: z.string().nullable().optional(),
  /**
   * The slot's `filament_vendor`, verbatim. A preset's BRAND is not derivable from its name (a
   * Polymaker preset is called "PolyLite PLA"), so without this a project preset brands itself
   * differently from the installed preset of the same name and the two stop comparing equal.
   * Optional: absent from a bridge on an older parser, which reads as "vendor unknown".
   */
  filamentVendor: z.string().nullable().optional(),
  color: z.string().nullable(),
  nozzleId: z.number().int().nonnegative().nullable(),
  chamberTemperature: z.number().nullable(),
  /**
   * The project's `filament_is_support` / `filament_soluble` flags for this slot. Null when the
   * 3MF (or a bridge running an older parser) carried neither, which consumers must treat as
   * "unknown" and not as false: see `support-recommendations.ts`.
   */
  isSupport: z.boolean().nullable().optional(),
  isSoluble: z.boolean().nullable().optional(),
  /**
   * The slot's `filament_cost`: price per KILOGRAM, with no currency attached.
   *
   * BambuStudio labels it "money/kg" and stores no currency anywhere, so a consumer that shows it
   * supplies its own symbol. Optional so a bridge running an older parser still validates.
   */
  costPerKg: z.number().nullable().optional()
})

export type BridgeLibraryThreeMfProjectFilament = z.infer<typeof bridgeLibraryThreeMfProjectFilamentSchema>

export const bridgeLibraryThreeMfPlateSchema = z.object({
  index: z.number().int().positive(),
  name: z.string().nullable(),
  gcodeFile: z.string().nullable(),
  pickFile: z.string().nullable(),
  thumbnailFile: z.string().nullable(),
  /**
   * The plate's EFFECTIVE bed type: its own `bed_type` where it states one, else the project-global
   * `curr_bed_type`. Resolved in the order the engine resolves it, so chips and temperature
   * estimates match what will be printed. Use {@link bedTypeOverride} to tell inherit from override.
   */
  plateType: z.string().nullable(),
  /**
   * The plate's OWN `bed_type`, null when it inherits the global. Absent from indexes built by a
   * parser older than the per-plate settings, which is why it is optional rather than nullable-only.
   */
  bedTypeOverride: z.string().nullable().optional(),
  /** The plate's own `print_sequence`, null when it inherits the global. Absent from older parsers. */
  printSequence: z.enum(['by layer', 'by object']).nullable().optional(),
  /** The plate's own `spiral_mode` (vase mode), null when it inherits. Absent from older parsers. */
  spiralMode: z.boolean().nullable().optional(),
  /** Locked against arrange. No global to inherit, so absent means unlocked. */
  locked: z.boolean().optional(),
  nozzleSizes: z.array(z.string()),
  filaments: z.array(bridgeLibraryThreeMfFilamentSchema),
  objects: z.array(bridgeLibraryThreeMfObjectSchema),
  /** Slicer-estimated print time (seconds) from slice_info's `prediction`, when sliced. */
  prediction: z.number().nullable().optional(),
  /** Slicer-estimated total filament weight (grams) from slice_info's `weight`. */
  weight: z.number().nullable().optional(),
  /**
   * Layer-based filament changes baked in `custom_gcode_per_layer.xml` (ToolChange entries),
   * keyed by print height in mm, for pre-slice display/editing (the prepare-print dialog seeds
   * its editable list from these). Absent from indexes built by older parsers.
   */
  filamentChanges: z.array(z.object({ z: z.number(), filamentId: z.number().int().positive() })).optional(),
  /** Layer pauses baked in `custom_gcode_per_layer.xml` (PausePrint entries), by print height (mm). */
  pauses: z.array(z.object({ z: z.number() })).optional(),
  /**
   * The slicer's two-group partition of this plate's filaments, from
   * `Metadata/filament_sequence.json`. Positional over the plate's filaments (entry `i` is
   * filament `i + 1`); the value is a group id, not an extruder or a tray.
   *
   * Only a Filament Track Switch machine's slice produces one, and only that feature reads it
   * (`filamentTrackSwitchArrangement`). Absent on every other project, and on indexes built by an
   * older parser, which the arrangement rule treats as "say nothing".
   */
  optimalAssignment: z.array(z.number().int()).optional()
})

export type BridgeLibraryThreeMfPlate = z.infer<typeof bridgeLibraryThreeMfPlateSchema>

export const bridgeLibraryThreeMfIndexSchema = z.object({
  plates: z.array(bridgeLibraryThreeMfPlateSchema),
  projectFilaments: z.array(bridgeLibraryThreeMfProjectFilamentSchema),
  compatiblePrinterModels: z.array(printerModelSchema),
  /**
   * The project-global `curr_bed_type` from `project_settings.config`, or null when it states none.
   *
   * Distinct from a plate's `plateType`, which RESOLVES the plate's own `bed_type` ahead of this.
   * Anything asking "what is the project set to" must read this: taking the first plate's resolved
   * type instead returns that plate's OVERRIDE whenever it has one, which then gets re-saved as the
   * project-wide value and changes every inheriting plate.
   */
  projectPlateType: z.string().nullable().optional(),
  /** Project filaments designated as support material (`support_filament`/`support_interface_filament`/`filament_is_support`). */
  supportFilamentIds: z.array(z.number().int().positive()).default([]),
  printerProfileName: z.string().nullable().default(null),
  processProfileName: z.string().nullable().default(null),
  /**
   * The system process preset the project's own process was derived from (`inherits_group[0]`).
   * This, not `processProfileName`, is what the engine judges process-vs-printer compatibility by,
   * so it is the only evidence a slice dialog has that a project preset was authored for another
   * machine. Null for a project whose process IS a system preset, and on an index from a bridge
   * older than parser v38 (which reads as "unknown", i.e. behaves as before).
   */
  processProfileInherits: z.string().nullable().default(null),
  /**
   * No Bambu project metadata (a vanilla/CAD-exported mesh container: see the shared
   * index parser): consumers treat the file like STL/STEP, never as an openable project.
   * Defaulted so an index from a not-yet-updated bridge parses as a project (the
   * pre-existing behavior).
   */
  geometryOnly: z.boolean().default(false),
  /**
   * The editor's single-object 3MF export (the `printstream_model_kind` marker in
   * project_settings.config): a full project by construction, but treated as a reusable
   * MODEL by default (preview on click) with slice/edit still reachable from menus.
   */
  objectExport: z.boolean().default(false),
  /**
   * The project's embedded settings contradict its own machine topology (today: a
   * `flush_volumes_matrix` that is not `filaments^2 x extruders`, which BambuStudio reads out of
   * bounds and dies on mid-slice). Advisory only, nothing repairs it automatically; the editor
   * and slice dialog offer the user an explicit Repair. Defaulted false so an index from a
   * not-yet-updated bridge keeps the pre-existing behavior.
   */
  needsSettingsRepair: z.boolean().default(false),
  /** Which invariants failed, so the repair prompt can name the user's actual problem. */
  settingsRepairReasons: z.array(threeMfSettingsRepairReasonSchema).default([]),
  /**
   * The subset of {@link settingsRepairReasons} whose repair would DECLINE: the value cannot be
   * derived with certainty, so the never-guess rule leaves it alone. A surface offering a Repair
   * action withholds it for these and names the manual remedy, instead of writing a new version
   * that changes nothing and brings the banner straight back. Absent from an older parser or
   * bridge, which must read as "unknown", i.e. behave as before and assume repairable.
   */
  unrepairableSettingsRepairReasons: z.array(threeMfSettingsRepairReasonSchema).optional(),
  /**
   * The Bambu Studio version that saved the project (zero-padded, e.g. `"02.08.00.50"`), or null
   * when unknown. BambuStudio refuses to open a project saved by a newer version than the engine
   * slicing it, so the slice dialog compares this against the chosen slicer target.
   */
  projectVersion: z.string().nullable().default(null),
  /**
   * Sliced for a machine with a Filament Track Switch (`has_filament_switcher`). A file must be
   * printed on the kind of machine it was sliced for, BambuStudio refuses the mismatch, so the
   * print dialogs compare this against the target printer. Defaulted false because an absent key
   * means "no switch" everywhere, including in BambuStudio's own CLI.
   */
  slicedWithFilamentTrackSwitch: z.boolean().default(false)
})

export type BridgeLibraryThreeMfIndex = z.infer<typeof bridgeLibraryThreeMfIndexSchema>

/**
 * `bambu.cloud.request`: relay one Bambu Lab cloud call through the bridge.
 *
 * Counterparts: `apps/bridge/src/bambu-cloud-relay.ts` performs the call;
 * `apps/api/src/plugins/bambu-cloud-sync/transport.ts` decides when to use it.
 *
 * The bridge is PREFERRED over the API for these calls because on a multi-workspace
 * deployment every workspace would otherwise reach Bambu from one shared egress IP,
 * which is what draws rate limiting and Cloudflare challenges for everyone at once. A
 * bridge sends a household's own traffic from that household's own connection. The
 * API keeps a direct path for workspaces with no bridge, or an offline/older one.
 *
 * The params carry a NAMED operation, never a URL: see `bambuCloudOperationSchema`
 * for why a URL-forwarding relay would be an SSRF proxy into the bridge's LAN.
 */
export const bridgeBambuCloudRequestParamsSchema = bambuCloudRequestSchema

export type BridgeBambuCloudRequestParams = z.infer<typeof bridgeBambuCloudRequestParamsSchema>

export const bridgeBambuCloudRequestResultSchema = bambuCloudResponseSchema

export type BridgeBambuCloudRequestResult = z.infer<typeof bridgeBambuCloudRequestResultSchema>

/**
 * Prefix a bridge uses to reject an RPC method it does not implement.
 *
 * Capability detection for bridge RPCs is by ASKING, not by version comparison:
 * bridges deploy separately from the API and update on a fingerprint rather than a
 * semver, so there is no version number to gate on. A caller that can degrade (like
 * the Bambu cloud relay, which falls back to a direct API-side call) matches this
 * prefix on the RPC error and takes its fallback path instead of failing.
 *
 * Shared so the two sides cannot drift: `apps/bridge/src/runtime.ts` builds the
 * message, `apps/api/src/plugins/bambu-cloud-sync/transport.ts` reads it.
 */
export const UNSUPPORTED_BRIDGE_RPC_ERROR_PREFIX = 'Unsupported bridge RPC method:'

/** Whether an RPC rejection means "this bridge is too old for that method". */
export function isUnsupportedBridgeRpcError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return message.startsWith(UNSUPPORTED_BRIDGE_RPC_ERROR_PREFIX)
}

export const bridgeLibraryInspect3mfParamsSchema = z.object({
  storedPath: z.string().min(1)
})

export type BridgeLibraryInspect3mfParams = z.infer<typeof bridgeLibraryInspect3mfParamsSchema>

export const bridgeLibraryInspect3mfResultSchema = z.object({
  index: bridgeLibraryThreeMfIndexSchema,
  /**
   * The `THREE_MF_INDEX_PARSER_VERSION` the bridge built this index with. The bridge deploys
   * separately from the API, so after a parser bump an un-upgraded bridge returns indexes that are
   * silently missing the new fields: Zod fills their defaults and nothing looks wrong. The API
   * compares this against its own parser version and re-parses the file locally when the bridge
   * lags, instead of caching (and version-stamping as current) an index that was never complete.
   * Defaults 0 so a bridge from before this field always reads as outdated.
   */
  parserVersion: z.number().int().nonnegative().default(0)
})

export type BridgeLibraryInspect3mfResult = z.infer<typeof bridgeLibraryInspect3mfResultSchema>

export const bridgeLibraryReadThumbnailParamsSchema = z.object({
  storedPath: z.string().min(1),
  plateIndex: z.number().int().positive().nullable().optional()
})

export type BridgeLibraryReadThumbnailParams = z.infer<typeof bridgeLibraryReadThumbnailParamsSchema>

export const bridgeLibraryReadThumbnailResultSchema = z.object({
  pngBase64: z.string().nullable()
})

export type BridgeLibraryReadThumbnailResult = z.infer<typeof bridgeLibraryReadThumbnailResultSchema>

export const bridgeRuntimeOutboundMessageSchema = z.discriminatedUnion('type', [
  bridgeRuntimeWelcomeMessageSchema,
  bridgeRpcRequestMessageSchema,
  bridgeRpcCancelMessageSchema,
  bridgeCameraWatchMessageSchema,
  bridgeCameraUnwatchMessageSchema,
  bridgeCommandMessageSchema,
  bridgePrintersConfigMessageSchema
])

export type BridgeRuntimeOutboundMessage = z.infer<typeof bridgeRuntimeOutboundMessageSchema>

export const bridgeRuntimeInboundMessageSchema = z.discriminatedUnion('type', [
  bridgeRuntimeHelloMessageSchema,
  bridgeRpcSuccessMessageSchema,
  bridgeRpcProgressMessageSchema,
  bridgeRpcErrorMessageSchema,
  bridgeCameraFrameMessageSchema,
  bridgePrinterFtpActivityMessageSchema,
  bridgeHeartbeatMessageSchema,
  bridgePrinterStatusMessageSchema,
  bridgePrinterReportMessageSchema,
  bridgePrinterDiscoveredMessageSchema,
  bridgePrinterOfflineMessageSchema,
  bridgePrinterRemovedMessageSchema,
  bridgeDebugCaptureStatusMessageSchema,
  bridgeBackupStatusMessageSchema,
  bridgePrinterConnectionMessageSchema,
  bridgeMetricsMessageSchema,
  bridgeCrashReportMessageSchema
])

export type BridgeRuntimeInboundMessage = z.infer<typeof bridgeRuntimeInboundMessageSchema>