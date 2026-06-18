/**
 * Loopback control channel for a standalone SEA app over a **named pipe**
 * (Windows) or **Unix domain socket** (mac/Linux) — no TCP port is ever bound.
 * A CLI (and, through it, a tray) connect to read status and trigger updates. It
 * is pull-based: nothing runs until a client connects, and there is no on-disk
 * status file for antivirus/indexers/backup agents to react to.
 *
 * Protocol: the client writes one JSON line `{"op": "status" | "update.check" |
 * "update.apply" | "logs"}` and reads one JSON line in reply, then the socket
 * closes. The one exception is `{"op": "logs.follow", "limit"?: number}`: the
 * server replays the last `limit` log lines then keeps the socket open, writing
 * one JSON line per new log entry until the client disconnects.
 *
 * The provider is generic: the server only relays its results as JSON, so the
 * concrete status/update/log shapes stay in the consuming app.
 */
import { createServer, type Server, type Socket } from 'node:net'
import { rmSync } from 'node:fs'

/** What the control server needs from the app to answer control requests. */
export interface ControlProvider {
  getStatus(): unknown
  checkForUpdates(): Promise<unknown>
  applyUpdate(): Promise<unknown>
  getLogs(): unknown[]
  /** Subscribe to log entries captured after the call; returns an unsubscribe. */
  subscribeLogs(listener: (entry: unknown) => void): () => void
}

export interface ControlServerHandle {
  close(): Promise<void>
}

export async function startControlServer(input: {
  socketPath: string
  provider: ControlProvider
}): Promise<ControlServerHandle> {
  // A Unix socket orphaned by a crash blocks the bind; remove it first. Harmless
  // no-op for Windows named pipes (single-instance already guarantees one host).
  removeSocketFile(input.socketPath)

  const server: Server = createServer((socket) => {
    let buffer = ''
    let handled = false
    socket.on('data', (chunk) => {
      if (handled) return
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      handled = true
      const line = buffer.slice(0, newline)

      let request: { op?: string; limit?: number }
      try {
        request = JSON.parse(line) as { op?: string; limit?: number }
      } catch {
        socket.end(`${JSON.stringify({ error: 'Malformed control request.' })}\n`)
        return
      }

      if (request.op === 'logs.follow') {
        startLogStream(socket, input.provider, request.limit)
        return
      }

      void handleOp(request.op ?? '', input.provider)
        .then((result) => socket.end(`${JSON.stringify(result)}\n`))
        .catch((error) => socket.end(`${JSON.stringify({ error: error instanceof Error ? error.message : 'Control request failed.' })}\n`))
    })
    socket.on('error', () => socket.destroy())
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(input.socketPath, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  return {
    close: () => new Promise<void>((resolve) => {
      server.close(() => {
        removeSocketFile(input.socketPath)
        resolve()
      })
    })
  }
}

/**
 * Stream log entries to a connected client: replay the buffered tail (bounded by
 * `limit`), then forward each new entry until the client disconnects. The socket
 * is held open for the lifetime of the follow, so it must be cleaned up on close
 * or error to avoid a leaked subscription.
 */
function startLogStream(socket: Socket, provider: ControlProvider, limit?: number): void {
  const write = (entry: unknown): void => {
    socket.write(`${JSON.stringify(entry)}\n`)
  }

  const buffered = provider.getLogs()
  const backfill = typeof limit === 'number' && limit >= 0 && limit < buffered.length
    ? buffered.slice(buffered.length - limit)
    : buffered
  for (const entry of backfill) write(entry)

  const unsubscribe = provider.subscribeLogs(write)
  let closed = false
  const cleanup = (): void => {
    if (closed) return
    closed = true
    unsubscribe()
  }
  socket.on('close', cleanup)
  socket.on('error', () => {
    cleanup()
    socket.destroy()
  })
}

async function handleOp(op: string, provider: ControlProvider): Promise<unknown> {
  switch (op) {
    case 'status':
      return provider.getStatus()
    case 'update.check':
      return await provider.checkForUpdates()
    case 'update.apply':
      return await provider.applyUpdate()
    case 'logs':
      return { entries: provider.getLogs() }
    default:
      return { error: `Unknown control op: ${op}` }
  }
}

function removeSocketFile(socketPath: string): void {
  if (socketPath.startsWith('\\\\')) return // Windows named pipe: nothing on disk
  try {
    rmSync(socketPath, { force: true })
  } catch {
    // Best-effort.
  }
}
