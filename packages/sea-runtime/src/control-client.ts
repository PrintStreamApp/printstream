/**
 * Client for the bridge control channel (named pipe / Unix socket). Used by the
 * CLI `status`/`update` commands; the tray reaches the bridge through the CLI
 * rather than speaking the socket itself.
 */
import { connect } from 'node:net'

/** Connection failed because nothing is listening (bridge not running). */
export class BridgeNotRunningError extends Error {}

export function requestControl<T>(socketPath: string, op: string, timeoutMs = 600_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const socket = connect(socketPath)
    let buffer = ''
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
      socket.end()
    }
    const timer = setTimeout(() => finish(() => reject(new Error('The bridge did not respond.'))), timeoutMs)

    socket.on('connect', () => socket.write(`${JSON.stringify({ op })}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      const line = buffer.slice(0, newline)
      finish(() => {
        try {
          resolve(JSON.parse(line) as T)
        } catch (error) {
          reject(error)
        }
      })
    })
    socket.on('error', (error: NodeJS.ErrnoException) => finish(() => {
      reject(error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
        ? new BridgeNotRunningError('The bridge is not running.')
        : error)
    }))
  })
}

/**
 * Open a long-lived control request that yields many newline-delimited JSON
 * messages (e.g. `logs.follow`), invoking `onMessage` for each. Resolves when
 * the server closes the stream or the caller aborts via `options.signal`;
 * rejects with {@link BridgeNotRunningError} when nothing is listening.
 */
export function streamControl(
  socketPath: string,
  op: string,
  onMessage: (message: unknown) => void,
  options: { signal?: AbortSignal; limit?: number } = {}
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = connect(socketPath)
    let buffer = ''
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (options.signal) options.signal.removeEventListener('abort', onAbort)
      fn()
      socket.end()
    }
    const onAbort = (): void => finish(() => resolve())
    if (options.signal) {
      if (options.signal.aborted) {
        socket.destroy()
        resolve()
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    const request = options.limit != null ? { op, limit: options.limit } : { op }
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim() !== '') {
          try {
            onMessage(JSON.parse(line))
          } catch {
            // Skip malformed lines rather than tearing down the whole stream.
          }
        }
        newline = buffer.indexOf('\n')
      }
    })
    socket.on('close', () => finish(() => resolve()))
    socket.on('error', (error: NodeJS.ErrnoException) => finish(() => {
      reject(error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
        ? new BridgeNotRunningError('The bridge is not running.')
        : error)
    }))
  })
}
