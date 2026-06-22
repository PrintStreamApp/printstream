/**
 * Outbound bridge session server.
 *
 * Handles the long-lived WebSocket connections initiated by bridge
 * runtimes. Each session authenticates with the bridge runtime token,
 * then carries RPC traffic and status snapshots back to the API.
 */
import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, WebSocket } from 'ws'
import {
  bridgeRuntimeInboundMessageSchema,
  type BridgeRuntimeInboundMessage
} from '@printstream/shared'
import { rootPrisma } from './prisma.js'
import { recoverBridgePrinterAssignments } from './bridge-assignment-recovery.js'
import { bridgeRuntimeTokenMatches } from './bridge-runtime-auth.js'
import { syncBridgePrinterConfig } from './bridge-printer-config.js'
import { bridgeSessionManager } from './bridge-session-manager.js'
import {
  clearBridgeDebugCaptureStatus,
  setBridgeDebugCaptureStatus
} from './bridge-debug-capture.js'
import { inactiveBridgeDebugCaptureStatus } from '@printstream/shared'
import { printerDiscovery } from './printer-discovery.js'
import { printerManager } from './printer-manager.js'
import { wsBroadcaster } from './ws-server.js'
import { recordBridgeMessageDropped, recordBridgeMetricsSnapshot, clearBridgeMetrics } from './metrics.js'
import { broadcastBridgesChanged, broadcastPrinterViewsChanged } from './ws-resource-events.js'

const CONNECT_PATH = '/api/bridge-runtime/connect'
const HELLO_TIMEOUT_MS = 5_000
const BRIDGE_LAST_SEEN_UPDATE_INTERVAL_MS = 60_000

/**
 * Server->bridge WebSocket ping cadence. Reverse proxies (Cloudflare, nginx)
 * idle-close a proxied WebSocket after ~100s with no traffic in the
 * server->client direction; the bridge's upstream `bridge.heartbeat` does not
 * reset that timer, so without a server-originated frame the session is reaped
 * roughly every 100s — flipping every printer on the bridge offline until it
 * reconnects. Pinging well inside that window keeps the session alive (and, as
 * with the /ws client heartbeat, reaps half-open bridge sockets). The bridge's
 * `ws` client auto-responds to these pings with pongs, so no bridge change is
 * needed for liveness to be observed.
 */
const HEARTBEAT_INTERVAL_MS = 30_000

export interface AttachedBridgeSessionServer {
  close(): Promise<void>
}

/** Liveness flag the bridge heartbeat sweep tracks on each session socket. */
type BridgeHeartbeatSocket = WebSocket & { isAlive?: boolean }

/**
 * One heartbeat pass over the connected bridge sockets: terminate any that did
 * not pong since the previous sweep (half-open / proxy-dropped), then ping the
 * rest. The ping doubles as the keepalive that stops an idle reverse proxy from
 * reaping an otherwise-healthy bridge session. Extracted for unit testing.
 */
export function sweepBridgeSessionHeartbeat(clients: Iterable<WebSocket>): void {
  for (const socket of clients) {
    const liveSocket = socket as BridgeHeartbeatSocket
    if (liveSocket.isAlive === false) {
      socket.terminate()
      continue
    }
    liveSocket.isAlive = false
    try {
      socket.ping()
    } catch {
      // Ping on an already-broken socket throws; the next sweep terminates it.
    }
  }
}

export function attachBridgeSessionServer(server: HttpServer): AttachedBridgeSessionServer {
  const wss = new WebSocketServer({ noServer: true })
  let closed = false

  // Keep proxied bridge sessions alive (and reap dead ones); see HEARTBEAT_INTERVAL_MS.
  const heartbeat = setInterval(() => sweepBridgeSessionHeartbeat(wss.clients), HEARTBEAT_INTERVAL_MS)
  heartbeat.unref()

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = request.url?.split('?')[0]
    if (url !== CONNECT_PATH) {
      return
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws)
    })
  }

  server.on('upgrade', handleUpgrade)

  wss.on('connection', (socket) => {
    // Heartbeat liveness: a pong to our periodic ping marks the socket alive;
    // the sweep terminates any that miss a round-trip (see HEARTBEAT_INTERVAL_MS).
    const liveSocket = socket as BridgeHeartbeatSocket
    liveSocket.isAlive = true
    socket.on('pong', () => { liveSocket.isAlive = true })

    let authenticatedBridgeId: string | null = null
    let authenticatedConnection: Parameters<typeof bridgeSessionManager.registerConnection>[0] | null = null
    // Set synchronously when the first hello is seen so a frame arriving before
    // the async authenticate resolves can't spawn a second authenticate/register
    // or get a spurious 4002 close while a valid hello is in flight.
    let authenticating = false
    let lastHeartbeatPersistedAtMs = 0
    // Surface contract drift (a bridge frame this server can't decode) once per
    // socket — enough to be observable without letting a noisy/pre-auth socket
    // flood the log buffer.
    let loggedParseFailure = false
    const helloTimer = setTimeout(() => {
      socket.close(4001, 'bridge hello timeout')
    }, HELLO_TIMEOUT_MS)
    const takeHeartbeatLastSeenAt = (): Date | null => {
      const now = Date.now()
      if (lastHeartbeatPersistedAtMs !== 0 && now - lastHeartbeatPersistedAtMs < BRIDGE_LAST_SEEN_UPDATE_INTERVAL_MS) {
        return null
      }
      lastHeartbeatPersistedAtMs = now
      return new Date(now)
    }

    socket.on('message', (data) => {
      const parsed = parseBridgeMessage(data)
      if (!parsed.ok) {
        recordBridgeMessageDropped(parsed.reason)
        if (!loggedParseFailure) {
          loggedParseFailure = true
          console.warn('[bridge-session] dropped malformed inbound message', {
            bridgeId: authenticatedBridgeId,
            reason: parsed.reason,
            type: parsed.type,
            issues: parsed.issues
          })
        }
        return
      }
      const message = parsed.message

      if (!authenticatedBridgeId) {
        if (authenticating) {
          // A hello is already being authenticated; drop further frames (a
          // duplicate hello or a pipelined message) until it resolves rather
          // than racing a second register or closing 4002 prematurely.
          return
        }
        if (message.type !== 'bridge.hello') {
          socket.close(4002, 'bridge hello required')
          return
        }

        authenticating = true
        void authenticateBridgeHello(socket, message).then((context) => {
          if (!context) return
          clearTimeout(helloTimer)
          lastHeartbeatPersistedAtMs = Date.now()
          authenticatedBridgeId = context.bridgeId
          authenticatedConnection = {
            bridgeId: context.bridgeId,
            tenantId: context.tenantId,
            send(outboundMessage) {
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify(outboundMessage))
              }
            },
            close(code, reason) {
              socket.close(code, reason)
            }
          }
          bridgeSessionManager.registerConnection(authenticatedConnection)
          socket.send(JSON.stringify({
            type: 'bridge.welcome',
            bridgeId: context.bridgeId,
            connected: context.tenantId != null,
            tenantId: context.tenantId,
            heartbeatIntervalSeconds: 15
          }))
          void recoverAndSyncBridgePrinters(context.bridgeId, context.tenantId)
        }).catch((error) => {
          console.warn('[bridge-session] hello handling failed', (error as Error).message)
          socket.close(4003, 'bridge authentication failed')
        }).finally(() => {
          authenticating = false
        })
        return
      }

      handleAuthenticatedMessage(
        authenticatedBridgeId,
        authenticatedConnection?.tenantId ?? null,
        message,
        takeHeartbeatLastSeenAt
      )
    })

    socket.on('close', () => {
      clearTimeout(helloTimer)
      if (authenticatedBridgeId) {
        // A reconnect/duplicate replaces the connection (registerConnection closes
        // the old socket) before this close fires. If a newer session already owns
        // this bridge id, skip all bridge-wide teardown — marking its printers
        // offline / clearing discovery here would clobber the live new session.
        if (!bridgeSessionManager.isActiveConnection(authenticatedBridgeId, authenticatedConnection ?? undefined)) {
          return
        }
        const tenantId = authenticatedConnection?.tenantId ?? null
        const clearedPrinterIds = bridgeSessionManager.clearBridgePrinterFtpActivity(authenticatedBridgeId)
        clearBridgeDebugCaptureStatus(authenticatedBridgeId)
        clearBridgeMetrics(authenticatedBridgeId)
        if (tenantId) {
          for (const printerId of clearedPrinterIds) {
            wsBroadcaster.broadcast({ type: 'printer.ftps.active', printerId, active: false }, tenantId)
          }
          // A disconnected bridge can no longer be controlled or report capture
          // progress; clear the banner. It re-announces on reconnect.
          wsBroadcaster.broadcast(
            { type: 'bridge.debug.capture', bridgeId: authenticatedBridgeId, status: inactiveBridgeDebugCaptureStatus },
            tenantId
          )
          broadcastBridgesChanged(tenantId)
        }
        bridgeSessionManager.unregisterConnection(authenticatedBridgeId, authenticatedConnection ?? undefined)
        printerDiscovery.clearBridge(authenticatedBridgeId)
        printerManager.markBridgeDisconnected(authenticatedBridgeId)
      }
    })
  })

  return {
    async close(): Promise<void> {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      server.off('upgrade', handleUpgrade)
      for (const socket of wss.clients) {
        socket.terminate()
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve())
      })
    }
  }
}

type ParsedBridgeMessage =
  | { ok: true; message: BridgeRuntimeInboundMessage }
  | { ok: false; reason: 'invalid-json' | 'schema'; type?: unknown; issues?: unknown }

function parseBridgeMessage(data: WebSocket.RawData): ParsedBridgeMessage {
  const text = typeof data === 'string' ? data : data.toString('utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'invalid-json' }
  }
  const result = bridgeRuntimeInboundMessageSchema.safeParse(parsed)
  if (!result.success) {
    const type = typeof parsed === 'object' && parsed !== null && 'type' in parsed
      ? (parsed as { type?: unknown }).type
      : undefined
    return { ok: false, reason: 'schema', type, issues: result.error.issues.slice(0, 5) }
  }
  return { ok: true, message: result.data }
}

async function authenticateBridgeHello(
  socket: WebSocket,
  message: Extract<BridgeRuntimeInboundMessage, { type: 'bridge.hello' }>
): Promise<{ bridgeId: string; tenantId: string | null } | null> {
  const bridge = await rootPrisma.bridge.findUnique({
    where: { id: message.bridgeId },
    select: {
      id: true,
      tenantId: true,
      version: true,
      releaseFingerprint: true,
      buildRevision: true,
      sourceFingerprint: true,
      protocolVersion: true,
      runnerAbiVersion: true,
      updateChannel: true,
      runtimeTokenHash: true
    }
  })

  if (!bridge || !bridgeRuntimeTokenMatches(message.runtimeToken, bridge.runtimeTokenHash)) {
    socket.close(4003, 'bridge authentication failed')
    return null
  }

  await rootPrisma.bridge.update({
    where: { id: bridge.id },
    data: {
      lastSeenAt: new Date(),
      ...(message.version ? { version: message.version } : {}),
      ...(message.releaseFingerprint ? { releaseFingerprint: message.releaseFingerprint } : {}),
      ...(message.buildRevision ? { buildRevision: message.buildRevision } : {}),
      // "Don't know" must not preserve a stale value: a bridge whose image
      // changed underneath it (rebuild while running an activated bundle)
      // would otherwise be pinned to the old image fingerprint forever.
      sourceFingerprint: message.sourceFingerprint ?? null,
      ...(message.protocolVersion != null ? { protocolVersion: message.protocolVersion } : {}),
      ...(message.runnerAbiVersion ? { runnerAbiVersion: message.runnerAbiVersion } : {}),
      updateStatus: null,
      latestAvailableVersion: null,
      lastUpdateCheckAt: new Date(),
      lastUpdateError: null
    }
  })
  if (bridge.tenantId) {
    broadcastBridgesChanged(bridge.tenantId)
  }

  return {
    bridgeId: bridge.id,
    tenantId: bridge.tenantId
  }
}

function handleAuthenticatedMessage(
  bridgeId: string,
  tenantId: string | null,
  message: BridgeRuntimeInboundMessage,
  takeHeartbeatLastSeenAt: () => Date | null
): void {
  switch (message.type) {
    case 'bridge.heartbeat': {
      const lastSeenAt = takeHeartbeatLastSeenAt()
      if (!lastSeenAt) return
      void rootPrisma.bridge.update({
        where: { id: bridgeId },
        data: { lastSeenAt }
      }).catch((error) => {
        console.warn(`[bridge-session] heartbeat lastSeenAt write failed for bridge ${bridgeId}`, (error as Error).message)
      })
      return
    }
    case 'bridge.rpc.success': {
      bridgeSessionManager.resolveRpcSuccess(message.id, message.result)
      return
    }
    case 'bridge.rpc.progress': {
      bridgeSessionManager.resolveRpcProgress(message.id, message.bytesSent, message.totalBytes ?? null)
      return
    }
    case 'bridge.rpc.error': {
      bridgeSessionManager.resolveRpcError(message.id, message.error)
      return
    }
    case 'bridge.camera.frame': {
      bridgeSessionManager.handleCameraFrame(bridgeId, message.printerId, message.jpegBase64)
      return
    }
    case 'bridge.printer.ftps.active': {
      const changed = bridgeSessionManager.setPrinterFtpActivity(bridgeId, message.printerId, message.active)
      if (changed && tenantId) {
        wsBroadcaster.broadcast({ type: 'printer.ftps.active', printerId: message.printerId, active: message.active }, tenantId)
      }
      return
    }
    case 'bridge.printer.report': {
      printerManager.ingestBridgeReport(message.printerId, message.report, bridgeId)
      return
    }
    case 'bridge.printer.discovered': {
      printerDiscovery.setBridgePrinters(bridgeId, message.printers)
      if (tenantId) {
        void recoverAndSyncBridgePrinters(bridgeId, tenantId)
      }
      return
    }
    case 'bridge.printer.offline': {
      printerManager.markBridgePrinterOffline(message.printerId, bridgeId)
      return
    }
    case 'bridge.printer.connection': {
      printerManager.ingestBridgeConnectionValidation(message.printerId, message.validation, bridgeId)
      return
    }
    case 'bridge.printer.status': {
      bridgeSessionManager.setPrinterStatus(bridgeId, message.printer)
      printerManager.ingestBridgeStatus(message.printer, bridgeId)
      return
    }
    case 'bridge.printer.removed': {
      bridgeSessionManager.removePrinterStatus(message.printerId)
      return
    }
    case 'bridge.debug.capture.status': {
      setBridgeDebugCaptureStatus(bridgeId, message.status)
      if (tenantId) {
        wsBroadcaster.broadcast({ type: 'bridge.debug.capture', bridgeId, status: message.status }, tenantId)
      }
      return
    }
    case 'bridge.metrics': {
      recordBridgeMetricsSnapshot(bridgeId, tenantId, message.metrics)
      return
    }
    case 'bridge.hello': {
      return
    }
  }
}

async function recoverAndSyncBridgePrinters(bridgeId: string, tenantId: string | null): Promise<void> {
  const recoveredPrinters = tenantId
    ? await recoverBridgePrinterAssignments({ bridgeId, tenantId })
    : []
  await syncBridgePrinterConfig(bridgeId)
  if (tenantId && recoveredPrinters.length > 0) {
    broadcastPrinterViewsChanged(tenantId)
  }
}