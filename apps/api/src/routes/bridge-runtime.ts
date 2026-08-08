/**
 * Bridge runtime bootstrap routes.
 *
 * Bridges register themselves before they are connected to a workspace so
 * the cloud can issue a durable machine credential and a short pairing code.
 */
import path from 'node:path'
import { sendFileFromDir } from '../lib/request-helpers.js'
import express from 'express'
import type { Prisma } from '@prisma/client'
import {
  bridgeRuntimeRegistrationRequestSchema,
  bridgeRuntimeRegistrationResponseSchema,
  type BridgeRuntimeRegistrationRequest
} from '@printstream/shared'
import { unauthorized } from '../lib/http-error.js'
import { rootPrisma } from '../lib/prisma.js'
import {
  bridgeRuntimeTokenMatches,
  createBridgeConnectCode,
  createBridgeRuntimeToken,
  hashBridgeRuntimeToken
} from '../lib/bridge-runtime-auth.js'
import { bridgeSessionManager } from '../lib/bridge-session-manager.js'
import { getBridgeDebugCaptureStatus } from '../lib/bridge-debug-capture.js'
import { readRequestOrigin } from '../lib/request-helpers.js'
import { buildBridgeUpdateSummary, getBridgeReleaseManifest, resolveBridgeAssetOrigin } from '../lib/bridge-update-policy.js'
import { resolveBridgeReleaseAsset } from '../lib/bridge-release-assets.js'
import { pairBridgeToWorkspace } from '../lib/bridge-pairing.js'
import { ensureManagedBridgeToken, isManagedBridgeMode, managedBridgeSecretMatches } from '../lib/managed-bridge.js'
import { resolveSoleWorkspace } from '../lib/workspace-resolution.js'
import { env } from '../lib/env.js'

const BRIDGE_RUNTIME_CONNECT_PATH = '/api/bridge-runtime/connect'
const BRIDGE_RUNTIME_HEARTBEAT_SECONDS = 15

export const bridgeRuntimeRouter = express.Router()

/**
 * Managed-bridge auto-pairing. When this server runs in managed-bridge mode and
 * a still-unpaired bridge presents a matching provisioning secret at
 * registration, attach it to the sole workspace immediately so the operator
 * never sees the connect-code step. A no-op when the mode is off; in managed
 * mode a missing/wrong secret or an ambiguous target workspace leaves the bridge
 * unpaired and logs loudly, since no UI will surface a stranded bridge.
 */
async function attemptManagedAutoPair(bridgeId: string, provisionSecret: string | undefined): Promise<boolean> {
  if (!isManagedBridgeMode()) return false
  if (!provisionSecret || !managedBridgeSecretMatches(provisionSecret, ensureManagedBridgeToken())) {
    console.warn(`[managed-bridge] bridge ${bridgeId} did not present a matching provisioning token; leaving it unpaired`)
    return false
  }
  const workspace = await resolveSoleWorkspace()
  if (!workspace) {
    console.warn(`[managed-bridge] bridge ${bridgeId} presented a valid secret but the target workspace is ambiguous; leaving it unpaired`)
    return false
  }
  await pairBridgeToWorkspace({ bridgeId, workspaceId: workspace.id })
  console.info(`[managed-bridge] auto-paired bridge ${bridgeId} into workspace ${workspace.slug}`)
  return true
}

bridgeRuntimeRouter.get('/releases', (request, response) => {
  response.json(getBridgeReleaseManifest(undefined, { assetOrigin: resolveBridgeAssetOrigin(readRequestOrigin(request)) }))
})

// Legacy path from versioned bridges; the channel segment is ignored.
bridgeRuntimeRouter.get('/releases/:channel', (request, response) => {
  response.json(getBridgeReleaseManifest(undefined, { assetOrigin: resolveBridgeAssetOrigin(readRequestOrigin(request)) }))
})

bridgeRuntimeRouter.get('/release-assets/:fileName', async (request, response) => {
  const asset = await resolveBridgeReleaseAsset({
    releasesDir: env.BRIDGE_RELEASES_DIR,
    fileName: request.params.fileName
  })
  response.type(asset.contentType)
  // By name under the releases dir — an absolute path 404s when the install
  // lives under a dot-directory. `resolveBridgeReleaseAsset` has already
  // validated the name and confined it to that directory.
  sendFileFromDir(response, env.BRIDGE_RELEASES_DIR, path.basename(asset.filePath))
})

/** Bridge columns needed to build a registration response (never includes secrets). */
const BRIDGE_RESPONSE_SELECT = {
  id: true,
  name: true,
  connectCode: true,
  workspaceId: true,
  version: true,
  releaseFingerprint: true,
  buildRevision: true,
  sourceFingerprint: true,
  protocolVersion: true,
  runnerAbiVersion: true,
  updateChannel: true,
  updateStatus: true,
  latestAvailableVersion: true,
  lastUpdateCheckAt: true,
  lastUpdateError: true,
  lastSeenAt: true,
  lastCrashAt: true,
  lastCrashReason: true,
  recentCrashCount: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { printers: true } }
} as const

type RegisteredBridgeRow = Prisma.BridgeGetPayload<{ select: typeof BRIDGE_RESPONSE_SELECT }>

function buildRegistrationResponse(bridge: RegisteredBridgeRow, runtimeToken: string, autoPaired: boolean) {
  return bridgeRuntimeRegistrationResponseSchema.parse({
    bridge: {
      id: bridge.id,
      name: bridge.name,
      // A managed auto-pair attaches the bridge already, so the connect code is
      // moot — withhold it so the bridge skips the pairing lifecycle.
      connectCode: autoPaired ? null : bridge.connectCode,
      printerCount: bridge._count.printers,
      lastSeenAt: bridge.lastSeenAt?.toISOString() ?? null,
      createdAt: bridge.createdAt.toISOString(),
      updatedAt: bridge.updatedAt.toISOString(),
      connectionStats: bridgeSessionManager.getConnectionStats(bridge.id),
      update: buildBridgeUpdateSummary(bridge),
      debugCapture: getBridgeDebugCaptureStatus(bridge.id),
      crash: {
        lastCrashAt: bridge.lastCrashAt?.toISOString() ?? null,
        recentCrashCount: bridge.recentCrashCount ?? 0,
        lastReason: bridge.lastCrashReason ?? null
      }
    },
    runtimeToken,
    connectPath: BRIDGE_RUNTIME_CONNECT_PATH,
    heartbeatIntervalSeconds: BRIDGE_RUNTIME_HEARTBEAT_SECONDS
  })
}

/** The metadata refresh applied on every (re)registration of a known bridge. */
function buildBridgeMetadataRefresh(parsed: BridgeRuntimeRegistrationRequest, now: Date, options: { allowRename: boolean }) {
  return {
    ...(parsed.name && options.allowRename ? { name: parsed.name } : {}),
    ...(parsed.version ? { version: parsed.version } : {}),
    ...(parsed.releaseFingerprint ? { releaseFingerprint: parsed.releaseFingerprint } : {}),
    ...(parsed.buildRevision ? { buildRevision: parsed.buildRevision } : {}),
    // "Don't know" must not preserve a stale value (see the hello handler in
    // bridge-session-server.ts).
    sourceFingerprint: parsed.sourceFingerprint ?? null,
    ...(parsed.protocolVersion != null ? { protocolVersion: parsed.protocolVersion } : {}),
    ...(parsed.runnerAbiVersion ? { runnerAbiVersion: parsed.runnerAbiVersion } : {}),
    updateChannel: parsed.updateChannel,
    updateStatus: null,
    latestAvailableVersion: null,
    lastUpdateCheckAt: now,
    lastUpdateError: null,
    lastSeenAt: now
  }
}

bridgeRuntimeRouter.post('/register', async (request, response) => {
  const parsed = bridgeRuntimeRegistrationRequestSchema.parse(request.body)
  const now = new Date()

  if (parsed.bridgeId || parsed.runtimeToken) {
    if (!parsed.bridgeId || !parsed.runtimeToken) {
      throw unauthorized('Bridge runtime credentials are incomplete.')
    }

    const existing = await rootPrisma.bridge.findUnique({
      where: { id: parsed.bridgeId },
      select: { id: true, workspaceId: true, installationId: true, runtimeTokenHash: true }
    })

    if (!existing || !bridgeRuntimeTokenMatches(parsed.runtimeToken, existing.runtimeTokenHash)) {
      throw unauthorized('Bridge runtime credentials are invalid.')
    }

    const updated = await rootPrisma.bridge.update({
      where: { id: existing.id },
      data: {
        ...buildBridgeMetadataRefresh(parsed, now, { allowRename: !existing.workspaceId }),
        // Backfill the durable install identity for bridges that registered before
        // it existed, so a future credential reset re-binds instead of duplicating.
        ...(parsed.installationId && !existing.installationId ? { installationId: parsed.installationId } : {})
      },
      select: BRIDGE_RESPONSE_SELECT
    })

    const autoPaired = existing.workspaceId
      ? false
      : await attemptManagedAutoPair(existing.id, parsed.provisionSecret)

    response.json(buildRegistrationResponse(updated, parsed.runtimeToken, autoPaired))
    return
  }

  // No valid credentials were presented. Before minting a new bridge, see whether
  // this physical install is already known by its durable installationId — if so,
  // re-bind it to that existing record (re-issuing a runtime token) so it keeps its
  // printers and library instead of stranding them under a duplicate. This is what
  // lets a bridge whose credentials were reset (e.g. pointed at a different
  // database and back) reconnect fully, even without removing the old entry first.
  if (parsed.installationId) {
    const known = await rootPrisma.bridge.findUnique({
      where: { installationId: parsed.installationId },
      select: { id: true, workspaceId: true }
    })
    if (known) {
      const reboundToken = createBridgeRuntimeToken()
      const rebound = await rootPrisma.bridge.update({
        where: { id: known.id },
        data: {
          ...buildBridgeMetadataRefresh(parsed, now, { allowRename: !known.workspaceId }),
          runtimeTokenHash: hashBridgeRuntimeToken(reboundToken)
        },
        select: BRIDGE_RESPONSE_SELECT
      })
      const reboundAutoPaired = known.workspaceId
        ? false
        : await attemptManagedAutoPair(known.id, parsed.provisionSecret)
      console.info(`[bridge-runtime] re-bound returning bridge ${known.id} from installation id (no duplicate created)`)
      response.json(buildRegistrationResponse(rebound, reboundToken, reboundAutoPaired))
      return
    }
  }

  const runtimeToken = createBridgeRuntimeToken()
  const created = await rootPrisma.bridge.create({
    data: {
      name: parsed.name ?? 'Unconnected bridge',
      connectCode: createBridgeConnectCode(),
      runtimeTokenHash: hashBridgeRuntimeToken(runtimeToken),
      installationId: parsed.installationId ?? null,
      version: parsed.version,
      releaseFingerprint: parsed.releaseFingerprint,
      buildRevision: parsed.buildRevision,
      sourceFingerprint: parsed.sourceFingerprint,
      protocolVersion: parsed.protocolVersion,
      runnerAbiVersion: parsed.runnerAbiVersion,
      updateChannel: parsed.updateChannel,
      lastUpdateCheckAt: now,
      lastSeenAt: now
    },
    select: BRIDGE_RESPONSE_SELECT
  })

  const autoPaired = await attemptManagedAutoPair(created.id, parsed.provisionSecret)

  response.status(201).json(buildRegistrationResponse(created, runtimeToken, autoPaired))
})