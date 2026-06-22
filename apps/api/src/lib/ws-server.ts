/**
 * WebSocket fan-out.
 *
 * One persistent server attached to the same HTTP server as Express.
 * Connections are indexed by tenant so a tenant-scoped broadcast (the hot
 * path — every printer status delta) touches only that tenant's sockets
 * rather than scanning every connected client. Platform-wide broadcasts
 * (tenantId === null) still walk the full client map, but those are rare.
 *
 * Camera frames are delivered over binary WS messages to subscribed
 * clients. See {@link CameraRelay} for the shared-socket multiplexing
 * logic that avoids opening one TLS camera connection per viewer.
 */
import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, WebSocket } from 'ws'
import type { Request } from 'express'
import { CAMERA_VIEW_PERMISSION, printerModelSchema, printerStatusSchema, resolvePermissionScope, type PrinterStatus, type WsEvent } from '@printstream/shared'
import { env } from './env.js'
import { recordWsEventBroadcast } from './metrics.js'
import { authUsesExplicitPermissions, createAnonymousAuthContext, type RequestAuthContext } from './auth-context.js'
import { authProviderRegistry } from './auth-registry.js'
import { prisma, rootPrisma } from './prisma.js'
import { resolveRequestAuth } from './auth-session.js'
import { applyPublicDemoGuestAuth } from './public-demo-policy.js'
import { bridgeSessionManager } from './bridge-session-manager.js'
import { printerEvents } from './printer-events.js'
import { printerManager } from './printer-manager.js'
import { printerDiscovery } from './printer-discovery.js'
import { supportsChamberCamera } from './camera.js'
import { CameraRelay } from './camera-relay.js'
import { CameraSnapshotHub } from './camera-snapshot-hub.js'
import { broadcastJobsChanged } from './ws-resource-events.js'
import { AUTHENTICATION_REQUIRED_MESSAGE, PERMISSION_REQUIRED_MESSAGE } from './authorization.js'
import { resolveEffectiveTenantForAuth, withResolvedTenantRequestContext, withTenantRequestContext, getCurrentTenant, type RequestTenantSummary } from './tenant-context.js'

export interface WsBroadcaster {
  /**
   * Fan out a WS event to connected clients.
   *
   * @param tenantId — pass a tenant ID to restrict delivery to that
   *   tenant's connections. Pass `null` to broadcast to every connected
   *   client (platform-wide events only — use deliberately).
   */
  broadcast(event: WsEvent, tenantId: string | null): void
  broadcastSnapshotUpdated(printerId: string, capturedAt: number, tenantId?: string | null): void
  notifyAuthChanged(input: { userIds?: readonly string[]; tenantId?: string | null }): void
  size(): number
}

interface WsClientContext {
  tenant: RequestTenantSummary | null
  auth: RequestAuthContext
}

export interface AttachedWebSocketServer {
  close(): Promise<void>
}

export class Broadcaster implements WsBroadcaster {
  private readonly clients = new Map<WebSocket, WsClientContext>()
  // Secondary index: tenantId -> that tenant's sockets. Lets a tenant-scoped
  // broadcast (the per-status-delta hot path) be O(that tenant's connections)
  // instead of O(all connected clients). Sockets whose context has no tenant are
  // never indexed here (they never receive tenant-scoped events) and are reached
  // only via the full `clients` map on platform-wide (tenantId === null) sends.
  private readonly clientsByTenant = new Map<string, Set<WebSocket>>()

  add(socket: WebSocket, context: WsClientContext): void {
    this.clients.set(socket, context)
    const tenantId = context.tenant?.id
    if (tenantId != null) {
      let tenantSockets = this.clientsByTenant.get(tenantId)
      if (!tenantSockets) {
        tenantSockets = new Set()
        this.clientsByTenant.set(tenantId, tenantSockets)
      }
      tenantSockets.add(socket)
    }
    socket.once('close', () => this.remove(socket))
  }

  private remove(socket: WebSocket): void {
    const context = this.clients.get(socket)
    this.clients.delete(socket)
    const tenantId = context?.tenant?.id
    if (tenantId == null) return
    const tenantSockets = this.clientsByTenant.get(tenantId)
    if (!tenantSockets) return
    tenantSockets.delete(socket)
    if (tenantSockets.size === 0) this.clientsByTenant.delete(tenantId)
  }

  broadcast(event: WsEvent, tenantId: string | null): void {
    recordWsEventBroadcast(event.type)
    const payload = JSON.stringify(event)
    if (tenantId != null) {
      const tenantSockets = this.clientsByTenant.get(tenantId)
      if (!tenantSockets) return
      for (const socket of tenantSockets) {
        if (socket.readyState === WebSocket.OPEN) socket.send(payload)
      }
      return
    }
    for (const socket of this.clients.keys()) {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload)
    }
  }

  broadcastSnapshotUpdated(printerId: string, capturedAt: number, tenantId?: string | null): void {
    if (tenantId !== undefined) {
      this.broadcast({ type: 'camera.snapshot.updated', printerId, capturedAt }, tenantId)
      return
    }

    void readPrinterTenantId(printerId).then((resolvedTenantId) => {
      if (!resolvedTenantId) return
      this.broadcast({ type: 'camera.snapshot.updated', printerId, capturedAt }, resolvedTenantId)
    })
  }

  notifyAuthChanged(input: { userIds?: readonly string[]; tenantId?: string | null }): void {
    const userIds = input.userIds ? new Set(input.userIds) : null
    const payload = JSON.stringify({ type: 'auth.changed' } satisfies WsEvent)
    for (const [socket, context] of this.clients) {
      if (socket.readyState !== WebSocket.OPEN) continue
      const actor = context.auth.actor
      const matchesUser = userIds == null || (actor.type === 'user' && userIds.has(actor.userId))
      const matchesTenant = input.tenantId === undefined || context.tenant?.id === input.tenantId || (input.tenantId === null && context.tenant == null)
      if (!matchesUser || !matchesTenant) continue
      socket.send(payload, () => socket.close(4001, 'auth changed'))
    }
  }

  size(): number {
    return this.clients.size
  }

  forEachClient(visitor: (socket: WebSocket, context: WsClientContext) => void): void {
    for (const [socket, context] of this.clients) {
      visitor(socket, context)
    }
  }
}

export const wsBroadcaster = new Broadcaster()

/** Liveness flag the heartbeat sweep tracks on each client socket. */
type HeartbeatSocket = WebSocket & { isAlive?: boolean }

/**
 * One heartbeat pass over the connected client sockets: terminate any that did
 * not pong since the previous sweep (half-open / vanished), then ping the rest
 * and mark them pending. A `pong` (wired on connection) flips `isAlive` back on.
 * Extracted from the interval so the reap rule is unit-testable.
 */
export function sweepWebSocketHeartbeat(clients: Iterable<WebSocket>): void {
  for (const socket of clients) {
    const liveSocket = socket as HeartbeatSocket
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

export function attachWebSocketServer(server: HttpServer): AttachedWebSocketServer {
  const wss = new WebSocketServer({ noServer: true })
  const cameraRelay = new CameraRelay()
  const cameraSnapshotHub = new CameraSnapshotHub(wsBroadcaster)
  cameraSnapshotHub.start()
  let closed = false

  const handleUpgrade = async (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!request.url || !request.url.startsWith('/ws')) {
      return
    }

    try {
      const resolved = await resolveUpgradeAuth(request)
      if (resolved.auth.authEnabled && resolved.auth.actor.type === 'anonymous') {
        rejectUpgrade(socket, 401, AUTHENTICATION_REQUIRED_MESSAGE)
        return
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        ;(request as IncomingMessage & { bambuConnection?: WsClientContext }).bambuConnection = {
          tenant: resolved.tenant,
          auth: resolved.auth
        }
        wss.emit('connection', ws, request)
      })
    } catch (error) {
      console.error('[ws] upgrade auth failed', error)
      rejectUpgrade(socket, 500, 'Internal server error')
    }
  }

  server.on('upgrade', handleUpgrade)

  wss.on('connection', (socket, request) => {
    const context = (request as IncomingMessage & { bambuConnection?: WsClientContext }).bambuConnection ?? {
      tenant: null,
      auth: createAnonymousAuthContext({ demoMode: false, authEnabled: false })
    }
    const desiredCameraSubscriptions = new Set<string>()
    const desiredSnapshotWatches = new Set<string>()
    wsBroadcaster.add(socket, context)
    // Heartbeat liveness: a pong (or any inbound frame) marks the socket alive;
    // the sweep below terminates any that miss a round-trip.
    const liveSocket = socket as WebSocket & { isAlive?: boolean }
    liveSocket.isAlive = true
    socket.on('pong', () => { liveSocket.isAlive = true })
    socket.send(JSON.stringify({ type: 'hello', serverTime: new Date().toISOString() }))
    // Replay current cached snapshots so the new client doesn't have to
    // wait for the next MQTT delta to render anything.
    void replayStatusesForTenant(socket, context.tenant)
    void replayPrinterFtpActivityForTenant(socket, context.tenant)
    // Replay the current discovered-printer set so the Add Printer
    // dialog can populate immediately on first paint.
    void sendDiscoveredPrinters(socket, context.tenant)

    socket.on('message', (data) => {
      if (typeof data !== 'string' && !Buffer.isBuffer(data)) return
      const text = typeof data === 'string' ? data : data.toString('utf8')
      let msg: { type?: string; printerId?: string }
      try { msg = JSON.parse(text) } catch { return }
      if (msg.type === 'camera.subscribe' && typeof msg.printerId === 'string') {
        const printerId = msg.printerId
        desiredCameraSubscriptions.add(printerId)
        void authorizeCameraAccess(context, printerId).then((result) => {
          if (socket.readyState !== WebSocket.OPEN || !desiredCameraSubscriptions.has(printerId)) {
            return
          }
          if (!result.ok) {
            sendWsError(socket, result.message)
            return
          }
          cameraRelay.subscribe(socket, printerId)
        }).catch((error) => console.warn('[ws] camera authorization failed', error))
      } else if (msg.type === 'camera.unsubscribe' && typeof msg.printerId === 'string') {
        desiredCameraSubscriptions.delete(msg.printerId)
        cameraRelay.unsubscribe(socket, msg.printerId)
      } else if (msg.type === 'camera.snapshot.watch' && typeof msg.printerId === 'string') {
        const printerId = msg.printerId
        desiredSnapshotWatches.add(printerId)
        void authorizeCameraAccess(context, printerId).then((result) => {
          if (socket.readyState !== WebSocket.OPEN || !desiredSnapshotWatches.has(printerId)) {
            return
          }
          if (!result.ok) {
            sendWsError(socket, result.message)
            return
          }
          cameraSnapshotHub.watch(socket, printerId)
        }).catch((error) => console.warn('[ws] camera authorization failed', error))
      } else if (msg.type === 'camera.snapshot.unwatch' && typeof msg.printerId === 'string') {
        desiredSnapshotWatches.delete(msg.printerId)
        cameraSnapshotHub.unwatch(socket, msg.printerId)
      }
    })

    socket.on('close', () => {
      desiredCameraSubscriptions.clear()
      desiredSnapshotWatches.clear()
      cameraRelay.removeClient(socket)
      cameraSnapshotHub.removeClient(socket)
    })
  })

  // Reap half-open client sockets (a browser that vanished without a close frame,
  // a dropped network) so they don't linger in `clients`, leak memory, and keep
  // receiving broadcasts forever. Each sweep terminates any socket that missed the
  // previous ping's pong, then pings the rest. `unref` so it never blocks exit.
  const HEARTBEAT_INTERVAL_MS = 30_000
  const heartbeat = setInterval(() => sweepWebSocketHeartbeat(wss.clients), HEARTBEAT_INTERVAL_MS)
  heartbeat.unref()

  const handleStatus = (status: PrinterStatus) => {
    void broadcastStatus(status)
  }
  const handlePrinterRemoved = (event: { printerId: string; tenantId: string }) => {
    wsBroadcaster.broadcast({ type: 'printer.removed', printerId: event.printerId }, event.tenantId)
  }
  const handlePrinterDiscovered = () => {
    broadcastDiscoveredPrinters()
  }
  const handleJobStarted = (event: { printer: { id: string } }) => {
    void readPrinterTenantId(event.printer.id).then((tenantId) => {
      if (tenantId) broadcastJobsChanged(tenantId)
    })
  }
  const handleJobFinished = (event: { printer: { id: string } }) => {
    void readPrinterTenantId(event.printer.id).then((tenantId) => {
      if (tenantId) broadcastJobsChanged(tenantId)
    })
  }

  printerEvents.on('status', handleStatus)
  printerEvents.on('printer.removed', handlePrinterRemoved)
  printerEvents.on('printer.discovered', handlePrinterDiscovered)
  printerEvents.on('job.started', handleJobStarted)
  printerEvents.on('job.finished', handleJobFinished)

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true

    clearInterval(heartbeat)
    server.off('upgrade', handleUpgrade)
    printerEvents.off('status', handleStatus)
    printerEvents.off('printer.removed', handlePrinterRemoved)
    printerEvents.off('printer.discovered', handlePrinterDiscovered)
    printerEvents.off('job.started', handleJobStarted)
    printerEvents.off('job.finished', handleJobFinished)

    cameraSnapshotHub.stop()

    for (const socket of wss.clients) {
      cameraRelay.removeClient(socket)
      cameraSnapshotHub.removeClient(socket)
      socket.terminate()
    }

    await new Promise<void>((resolve) => {
      wss.close(() => resolve())
    })
  }

  server.once('close', () => {
    void close()
  })

  return { close }
}

async function authorizeCameraAccess(
  context: WsClientContext,
  printerId: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (authUsesExplicitPermissions(context.auth) && !context.auth.permissions.includes(resolvePermissionScope(CAMERA_VIEW_PERMISSION))) {
    return { ok: false, message: PERMISSION_REQUIRED_MESSAGE }
  }

  if (!context.tenant?.id) {
    return { ok: false, message: 'Tenant context is required for camera access.' }
  }

  const row = await rootPrisma.printer.findFirst({
    where: {
      id: printerId,
      tenantId: context.tenant.id
    },
    select: {
      id: true,
      model: true
    }
  })

  if (!row) {
    return { ok: false, message: 'Printer not found.' }
  }
  const parsedModel = printerModelSchema.safeParse(row.model)
  const model = parsedModel.success ? parsedModel.data : 'unknown'
  if (!supportsChamberCamera(model)) {
    return { ok: false, message: `Camera not supported for model ${model}` }
  }

  return { ok: true }
}

async function resolveUpgradeAuth(request: IncomingMessage) {
  const anonymous = createAnonymousAuthContext({
    demoMode: false,
    authEnabled: false
  })
  const resolved = await withResolvedTenantRequestContext(request as Request, async () => {
    const auth = await resolveRequestAuth(prisma, request as Request, anonymous)
    const requestTenant = getCurrentTenant()
    return {
      auth: applyPublicDemoGuestAuth(auth, requestTenant),
      requestTenant
    }
  })
  const requestTenantAuthEnabled = resolved.requestTenant
    ? await withTenantRequestContext(resolved.requestTenant, async () => await authProviderRegistry.hasEnabledProviders())
    : false
  const effectiveTenant = await resolveEffectiveTenantForAuth(resolved.auth, resolved.requestTenant, {
    requestTenantAuthEnabled
  })
  const authEnabled = await withTenantRequestContext(effectiveTenant, async () => await authProviderRegistry.hasEnabledProviders())

  return {
    auth: {
      ...resolved.auth,
      authEnabled
    },
    tenant: effectiveTenant
  }
}

function broadcastDiscoveredPrinters(): void {
  wsBroadcaster.forEachClient((socket, context) => {
    void sendDiscoveredPrinters(socket, context.tenant)
  })
}

async function sendDiscoveredPrinters(socket: WebSocket, tenant: RequestTenantSummary | null): Promise<void> {
  const tenantId = tenant?.id ?? null
  if (!tenantId) return
  const bridges = await rootPrisma.bridge.findMany({
    where: { tenantId },
    select: { id: true }
  })
  const bridgeIds = bridges.map((bridge) => bridge.id)
  if (bridgeIds.length === 0) {
    if (socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ type: 'printer.discovered', printers: [] }))
    return
  }
  const adopted = await rootPrisma.printer.findMany({
    where: { tenantId },
    select: { serial: true }
  })
  const adoptedSerials = new Set(adopted.map((row) => row.serial))
  const printers = printerDiscovery
    .list({ tenantId, bridgeIds })
    .filter((entry) => !adoptedSerials.has(entry.serial))

  if (socket.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify({ type: 'printer.discovered', printers }))
}

async function replayStatusesForTenant(socket: WebSocket, tenant: RequestTenantSummary | null): Promise<void> {
  const visiblePrinterIds = await listTenantPrinterIds(tenant?.id ?? null)
  if (visiblePrinterIds.size === 0) return

  // Look up each of the tenant's printers by id rather than scanning every
  // managed printer in the process — keeps replay O(tenant printers) on connect.
  for (const printerId of visiblePrinterIds) {
    const status = printerManager.getStatus(printerId)
    if (!status) continue
    if (socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ type: 'printer.status', status }))
  }
}

async function replayPrinterFtpActivityForTenant(socket: WebSocket, tenant: RequestTenantSummary | null): Promise<void> {
  const visiblePrinterIds = await listTenantPrinterIds(tenant?.id ?? null)
  if (visiblePrinterIds.size === 0) return

  for (const printerId of bridgeSessionManager.listActivePrinterFtpActivity()) {
    if (!visiblePrinterIds.has(printerId)) continue
    if (socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ type: 'printer.ftps.active', printerId, active: true }))
  }
}

async function broadcastStatus(status: PrinterStatus): Promise<void> {
  const tenantId = await readPrinterTenantId(status.printerId)
  if (!tenantId) return
  // The WS contract is compile-time only on this hot path; in non-production
  // validate the payload before sending so the producer fails loudly on drift
  // (a field shape the client schema would silently drop) instead of leaving
  // the consumer to discard it. Skipped in production to avoid per-status cost.
  if (env.NODE_ENV !== 'production') {
    const result = printerStatusSchema.safeParse(status)
    if (!result.success) {
      console.error('[ws] broadcasting a printer.status that fails printerStatusSchema', {
        printerId: status.printerId,
        issues: result.error.issues.slice(0, 5)
      })
    }
  }
  wsBroadcaster.broadcast({ type: 'printer.status', status }, tenantId)
}

function sendWsError(socket: WebSocket, message: string): void {
  if (socket.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify({ type: 'error', message }))
}

async function readPrinterTenantId(printerId: string): Promise<string | null> {
  // Status/job/snapshot events fan out at MQTT cadence (live deltas plus a 30s
  // pushall per printer), so resolve the tenant from the manager's in-memory cache
  // first — a Postgres findUnique per event would scale DB load with telemetry rate,
  // not user activity. Fall back to the DB only on a cache miss.
  const cached = printerManager.getTenantId(printerId)
  if (cached) return cached
  const row = await rootPrisma.printer.findUnique({
    where: { id: printerId },
    select: { tenantId: true }
  })
  return row?.tenantId ?? null
}

async function listTenantPrinterIds(tenantId: string | null): Promise<Set<string>> {
  if (!tenantId) return new Set()

  const rows = await rootPrisma.printer.findMany({
    where: { tenantId },
    select: { id: true }
  })
  return new Set(rows.map((row) => row.id))
}

function rejectUpgrade(socket: Duplex, statusCode: number, message: string): void {
  const body = JSON.stringify({ error: message })
  socket.write(
    [
      `HTTP/1.1 ${statusCode} ${statusCode === 401 ? 'Unauthorized' : 'Forbidden'}`,
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      '',
      body
    ].join('\r\n')
  )
  socket.destroy()
}
