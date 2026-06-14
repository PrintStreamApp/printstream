/**
 * Bridge runtime bootstrap routes.
 *
 * Bridges register themselves before they are connected to a workspace so
 * the cloud can issue a durable machine credential and a short pairing code.
 */
import express from 'express'
import {
  bridgeRuntimeRegistrationRequestSchema,
  bridgeRuntimeRegistrationResponseSchema
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
import { readRequestOrigin } from '../lib/request-helpers.js'
import { buildBridgeUpdateSummary, getBridgeReleaseManifest, resolveBridgeAssetOrigin } from '../lib/bridge-update-policy.js'
import { resolveBridgeReleaseAsset } from '../lib/bridge-release-assets.js'
import { pairBridgeToTenant } from '../lib/bridge-pairing.js'
import { ensureManagedBridgeToken, isManagedBridgeMode, managedBridgeSecretMatches } from '../lib/managed-bridge.js'
import { resolveSoleTenant } from '../lib/default-tenant.js'
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
  const tenant = await resolveSoleTenant()
  if (!tenant) {
    console.warn(`[managed-bridge] bridge ${bridgeId} presented a valid secret but the target workspace is ambiguous; leaving it unpaired`)
    return false
  }
  await pairBridgeToTenant({ bridgeId, tenantId: tenant.id })
  console.info(`[managed-bridge] auto-paired bridge ${bridgeId} into workspace ${tenant.slug}`)
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
  response.sendFile(asset.filePath)
})

bridgeRuntimeRouter.post('/register', async (request, response) => {
  const parsed = bridgeRuntimeRegistrationRequestSchema.parse(request.body)
  const now = new Date()

  if (parsed.bridgeId || parsed.runtimeToken) {
    if (!parsed.bridgeId || !parsed.runtimeToken) {
      throw unauthorized('Bridge runtime credentials are incomplete.')
    }

    const existing = await rootPrisma.bridge.findUnique({
      where: { id: parsed.bridgeId },
      select: {
        id: true,
        name: true,
        connectCode: true,
        tenantId: true,
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
        runtimeTokenHash: true,
        lastSeenAt: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            printers: true
          }
        }
      }
    })

    if (!existing || !bridgeRuntimeTokenMatches(parsed.runtimeToken, existing.runtimeTokenHash)) {
      throw unauthorized('Bridge runtime credentials are invalid.')
    }

    const updated = await rootPrisma.bridge.update({
      where: { id: existing.id },
      data: {
        ...(parsed.name && !existing.tenantId ? { name: parsed.name } : {}),
        ...(parsed.version ? { version: parsed.version } : {}),
        ...(parsed.releaseFingerprint ? { releaseFingerprint: parsed.releaseFingerprint } : {}),
        ...(parsed.buildRevision ? { buildRevision: parsed.buildRevision } : {}),
        // "Don't know" must not preserve a stale value (see the hello
        // handler in bridge-session-server.ts).
        sourceFingerprint: parsed.sourceFingerprint ?? null,
        ...(parsed.protocolVersion != null ? { protocolVersion: parsed.protocolVersion } : {}),
        ...(parsed.runnerAbiVersion ? { runnerAbiVersion: parsed.runnerAbiVersion } : {}),
        updateChannel: parsed.updateChannel,
        updateStatus: null,
        latestAvailableVersion: null,
        lastUpdateCheckAt: now,
        lastUpdateError: null,
        lastSeenAt: now
      },
      select: {
        id: true,
        name: true,
        connectCode: true,
        tenantId: true,
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
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            printers: true
          }
        }
      }
    })

    const autoPaired = existing.tenantId
      ? false
      : await attemptManagedAutoPair(existing.id, parsed.provisionSecret)

    response.json(bridgeRuntimeRegistrationResponseSchema.parse({
      bridge: {
        id: updated.id,
        name: updated.name,
        // A managed auto-pair attaches the bridge to its workspace already, so
        // the connect code is moot — withhold it so the bridge skips the
        // pairing lifecycle and connects straight through.
        connectCode: autoPaired ? null : updated.connectCode,
        printerCount: updated._count.printers,
        lastSeenAt: updated.lastSeenAt?.toISOString() ?? null,
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
        connectionStats: bridgeSessionManager.getConnectionStats(updated.id),
        update: buildBridgeUpdateSummary(updated)
      },
      runtimeToken: parsed.runtimeToken,
      connectPath: BRIDGE_RUNTIME_CONNECT_PATH,
      heartbeatIntervalSeconds: BRIDGE_RUNTIME_HEARTBEAT_SECONDS
    }))
    return
  }

  const runtimeToken = createBridgeRuntimeToken()
  const created = await rootPrisma.bridge.create({
    data: {
      name: parsed.name ?? 'Unconnected bridge',
      connectCode: createBridgeConnectCode(),
      runtimeTokenHash: hashBridgeRuntimeToken(runtimeToken),
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
    select: {
      id: true,
      name: true,
      connectCode: true,
      tenantId: true,
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
      createdAt: true,
      updatedAt: true,
      _count: {
        select: {
          printers: true
        }
      }
    }
  })

  const autoPaired = await attemptManagedAutoPair(created.id, parsed.provisionSecret)

  response.status(201).json(bridgeRuntimeRegistrationResponseSchema.parse({
    bridge: {
      id: created.id,
      name: created.name,
      connectCode: autoPaired ? null : created.connectCode,
      printerCount: created._count.printers,
      lastSeenAt: created.lastSeenAt?.toISOString() ?? null,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
      connectionStats: bridgeSessionManager.getConnectionStats(created.id),
      update: buildBridgeUpdateSummary(created)
    },
    runtimeToken,
    connectPath: BRIDGE_RUNTIME_CONNECT_PATH,
    heartbeatIntervalSeconds: BRIDGE_RUNTIME_HEARTBEAT_SECONDS
  }))
})