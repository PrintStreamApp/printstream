/**
 * Client for a standalone app's control channel (named pipe / Unix socket). Used
 * by the CLI `status`/`update` commands; the tray reaches the app through the CLI
 * rather than speaking the socket itself.
 *
 * This module is shared by every SEA app (the cloud bridge and the self-hosted
 * server today), so nothing it can surface to a user may name one of them. It
 * used to say "The bridge did not respond." on a timeout, which the SERVER's CLI
 * printed verbatim, telling a self-hosted operator about a "bridge": a word this
 * product already uses for a different thing. Each CLI translates these into its
 * own wording; keep what escapes from here app-neutral.
 */
import { connect } from 'node:net'

/** Connection failed because nothing is listening on the control channel. */
export class ControlChannelUnavailableError extends Error {}

/**
 * The channel accepted the connection and then went quiet past the deadline,
 * which normally means the app died mid-operation. A distinct type rather than a
 * message a caller has to string-match, so a reworded message cannot silently
 * stop a CLI from explaining it.
 */
export class ControlChannelTimeoutError extends Error {}

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
    const timer = setTimeout(() => {
      finish(() => reject(new ControlChannelTimeoutError('The control channel did not respond.')))
      // `finish` ends the socket politely, which a peer that has stopped
      // responding may never complete, leaving the handle (and the caller's
      // event loop) open. A timeout already means it is not talking to us.
      socket.destroy()
    }, timeoutMs)

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
        ? new ControlChannelUnavailableError('Nothing is listening on the control channel.')
        : error)
    }))
  })
}

/**
 * Open a long-lived control request that yields many newline-delimited JSON
 * messages (e.g. `logs.follow`), invoking `onMessage` for each. Resolves when
 * the server closes the stream or the caller aborts via `options.signal`;
 * rejects with {@link ControlChannelUnavailableError} when nothing is listening.
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
        ? new ControlChannelUnavailableError('Nothing is listening on the control channel.')
        : error)
    }))
  })
}
