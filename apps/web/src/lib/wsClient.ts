/**
 * Shared WebSocket client singleton.
 *
 * Manages a single reconnecting WS connection to the API. Both the
 * printer status listener and camera frame hooks consume events through
 * this shared instance so we never open duplicate connections.
 *
 * Text messages are dispatched to registered JSON listeners.
 * Binary messages are dispatched to registered binary listeners.
 * Both types can be added/removed freely.
 */
import { buildWebSocketUrl } from './apiUrl'

export type JsonListener = (data: unknown) => void
export type BinaryListener = (data: ArrayBuffer) => void
export type OpenListener = () => void

const RECONNECT_MS = 2_000

class WsClient {
  private socket: WebSocket | null = null
  private closed = false
  private refCount = 0
  private reconnectTimer: number | null = null
  private readonly jsonListeners = new Set<JsonListener>()
  private readonly binaryListeners = new Set<BinaryListener>()
  private readonly openListeners = new Set<OpenListener>()

  start(): void {
    this.refCount += 1
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.closed = false
    if (this.socket && this.socket.readyState !== WebSocket.CLOSING && this.socket.readyState !== WebSocket.CLOSED) return
    this.connect()
  }

  restart(): void {
    if (this.refCount === 0) return
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    this.closed = false
    const socket = this.socket
    if (!socket) {
      this.connect()
      return
    }

    if (socket.readyState === WebSocket.CONNECTING) {
      socket.addEventListener('open', () => socket.close(), { once: true })
      return
    }

    this.socket = null
    socket.close()
  }

  stop(): void {
    this.refCount = Math.max(0, this.refCount - 1)
    if (this.refCount > 0) return

    this.closed = true
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const socket = this.socket
    if (!socket) return

    if (socket.readyState === WebSocket.CONNECTING) {
      socket.addEventListener('open', () => {
        if (this.refCount === 0) socket.close()
      }, { once: true })
      return
    }

    this.socket = null
    socket.close()
  }

  send(data: string | ArrayBuffer): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(data)
    }
  }

  onJson(listener: JsonListener): () => void {
    this.jsonListeners.add(listener)
    return () => this.jsonListeners.delete(listener)
  }

  onBinary(listener: BinaryListener): () => void {
    this.binaryListeners.add(listener)
    return () => this.binaryListeners.delete(listener)
  }

  onOpen(listener: OpenListener): () => void {
    this.openListeners.add(listener)
    return () => this.openListeners.delete(listener)
  }

  private connect(): void {
    if (this.closed || this.refCount === 0) return

    const socket = new WebSocket(buildWebSocketUrl('/ws'))
    socket.binaryType = 'arraybuffer'
    this.socket = socket

    socket.addEventListener('open', () => {
      for (const listener of this.openListeners) {
        listener()
      }
    })

    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        let parsed: unknown
        try { parsed = JSON.parse(event.data) } catch { return }
        for (const listener of this.jsonListeners) {
          listener(parsed)
        }
      } else if (event.data instanceof ArrayBuffer) {
        for (const listener of this.binaryListeners) {
          listener(event.data)
        }
      }
    })

    socket.addEventListener('close', () => {
      if (this.socket === socket) this.socket = null
      if (this.closed || this.refCount === 0 || this.socket) return
      this.reconnectTimer = window.setTimeout(() => this.connect(), RECONNECT_MS)
    })
  }
}

/** App-wide singleton. Call `wsClient.start()` once at mount. */
export const wsClient = new WsClient()
