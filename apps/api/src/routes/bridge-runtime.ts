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
import { buildBridgeUpdateSummary, getBridgeReleaseManifest } from '../lib/bridge-update-policy.js'
import { resolveBridgeReleaseAssetPath } from '../lib/bridge-release-assets.js'
import { env } from '../lib/env.js'

const BRIDGE_RUNTIME_CONNECT_PATH = '/api/bridge-runtime/connect'
const BRIDGE_RUNTIME_HEARTBEAT_SECONDS = 15

export const bridgeRuntimeRouter = express.Router()

bridgeRuntimeRouter.get('/releases/:channel', (request, response) => {
  response.json(getBridgeReleaseManifest(request.params.channel))
})

bridgeRuntimeRouter.get('/release-assets/:fileName', async (request, response) => {
  const filePath = await resolveBridgeReleaseAssetPath({
    releasesDir: env.BRIDGE_RELEASES_DIR,
    fileName: request.params.fileName
  })
  response.type('application/zip')
  response.sendFile(filePath)
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
        ...(parsed.buildRevision ? { buildRevision: parsed.buildRevision } : {}),
        ...(parsed.sourceFingerprint ? { sourceFingerprint: parsed.sourceFingerprint } : {}),
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

    response.json(bridgeRuntimeRegistrationResponseSchema.parse({
      bridge: {
        id: updated.id,
        name: updated.name,
        connectCode: updated.connectCode,
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

  response.status(201).json(bridgeRuntimeRegistrationResponseSchema.parse({
    bridge: {
      id: created.id,
      name: created.name,
      connectCode: created.connectCode,
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