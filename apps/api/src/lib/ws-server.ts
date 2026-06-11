/**
 * WebSocket fan-out.
 *
 * One persistent server attached to the same HTTP server as Express.
 * Every connected client receives the same broadcast stream. Per-client
 * subscriptions can be added later if traffic warrants it; for now,
 * broadcast volume is bounded by the number of printers, not clients.
 *
 * Camera frames are delivered over binary WS messages to subscribed
 * clients. See {@link CameraRelay} for the shared-socket multiplexing
 * logic that avoids opening one TLS camera connection per viewer.
 */
import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, WebSocket } from 'ws'
import type { Request } from 'express'
import { CAMERA_VIEW_PERMISSION, printerModelSchema, resolvePermissionScope, type PrinterStatus, type WsEvent } from '@printstream/shared'
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

class Broadcaster implements WsBroadcaster {
  private readonly clients = new Map<WebSocket, WsClientContext>()

  add(socket: WebSocket, context: WsClientContext): void {
    this.clients.set(socket, context)
    socket.once('close', () => this.clients.delete(socket))
  }

  broadcast(event: WsEvent, tenantId: string | null): void {
    const payload = JSON.stringify(event)
    for (const [socket, context] of this.clients) {
      if (tenantId != null && context.tenant?.id !== tenantId) continue
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload)
      }
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
    } catch {
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
        })
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
        })
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

  for (const status of printerManager.snapshots()) {
    if (!visiblePrinterIds.has(status.printerId)) continue
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
  wsBroadcaster.broadcast({ type: 'printer.status', status }, tenantId)
}

function sendWsError(socket: WebSocket, message: string): void {
  if (socket.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify({ type: 'error', message }))
}

async function readPrinterTenantId(printerId: string): Promise<string | null> {
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
