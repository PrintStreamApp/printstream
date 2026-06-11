/**
 * Camera frame relay over WebSocket.
 *
 * Multiplexes printer camera streams so that one TLS camera connection
 * is shared across all WS clients viewing the same printer. Frames are
 * sent as binary WS messages with a fixed 36-byte ASCII printer-ID
 * prefix followed by the raw JPEG bytes.
 *
 * Wire format of a binary WS message:
 *   [printerId: 36 bytes ASCII] [jpeg: N bytes]
 */
import { WebSocket } from 'ws'
import { cameraStreamHub } from './camera-stream-hub.js'

const PRINTER_ID_LENGTH = 36
const MAX_CLIENT_BUFFERED_BYTES = 1_000_000
const RETRY_DELAY_MS = 50

interface CameraClientSubscription {
  subscriberCount: number
  unsubscribe: () => void
  queuedFrame: Buffer | null
  sending: boolean
  retryTimer: NodeJS.Timeout | null
}

export class CameraRelay {
  /** Reverse index: client -> printer ID -> unsubscribe callback. */
  private readonly clientSubs = new Map<WebSocket, Map<string, CameraClientSubscription>>()

  subscribe(client: WebSocket, printerId: string): void {
    let subs = this.clientSubs.get(client)
    if (!subs) {
      subs = new Map()
      this.clientSubs.set(client, subs)
    }
    const existing = subs.get(printerId)
    if (existing) {
      existing.subscriberCount += 1
      return
    }

    const subscription: CameraClientSubscription = {
      subscriberCount: 1,
      unsubscribe: () => undefined,
      queuedFrame: null,
      sending: false,
      retryTimer: null
    }

    subscription.unsubscribe = cameraStreamHub.subscribe(printerId, (frame) => {
      this.enqueueFrame(client, printerId, subscription, frame)
    })
    subs.set(printerId, subscription)
  }

  unsubscribe(client: WebSocket, printerId: string): void {
    const subs = this.clientSubs.get(client)
    const subscription = subs?.get(printerId)
    if (!subscription) return

    if (subscription.subscriberCount > 1) {
      subscription.subscriberCount -= 1
      return
    }

    subscription.unsubscribe()
    if (subscription.retryTimer) clearTimeout(subscription.retryTimer)
    subs?.delete(printerId)
    if (subs?.size === 0) this.clientSubs.delete(client)
  }

  /** Remove all subscriptions for a disconnected client. */
  removeClient(client: WebSocket): void {
    const subs = this.clientSubs.get(client)
    if (!subs) return
    for (const subscription of subs.values()) {
      subscription.unsubscribe()
      if (subscription.retryTimer) clearTimeout(subscription.retryTimer)
    }
    this.clientSubs.delete(client)
  }

  private enqueueFrame(client: WebSocket, printerId: string, subscription: CameraClientSubscription, frame: Buffer): void {
    if (client.readyState !== WebSocket.OPEN) {
      this.unsubscribe(client, printerId)
      return
    }

    subscription.queuedFrame = frame
    if (subscription.sending || client.bufferedAmount > MAX_CLIENT_BUFFERED_BYTES) {
      this.scheduleRetry(client, printerId, subscription)
      return
    }

    const next = subscription.queuedFrame
    subscription.queuedFrame = null
    if (next) {
      this.sendFrame(client, printerId, subscription, next)
    }
  }

  private scheduleRetry(client: WebSocket, printerId: string, subscription: CameraClientSubscription): void {
    if (subscription.retryTimer) return
    subscription.retryTimer = setTimeout(() => {
      subscription.retryTimer = null
      if (client.readyState !== WebSocket.OPEN) {
        this.unsubscribe(client, printerId)
        return
      }
      if (subscription.sending || !subscription.queuedFrame) return
      if (client.bufferedAmount > MAX_CLIENT_BUFFERED_BYTES) {
        this.scheduleRetry(client, printerId, subscription)
        return
      }
      const next = subscription.queuedFrame
      subscription.queuedFrame = null
      this.sendFrame(client, printerId, subscription, next)
    }, RETRY_DELAY_MS)
  }

  private sendFrame(client: WebSocket, printerId: string, subscription: CameraClientSubscription, frame: Buffer): void {
    subscription.sending = true
    client.send(this.framePacket(printerId, frame), { binary: true }, (error) => {
      subscription.sending = false
      if (error || client.readyState !== WebSocket.OPEN) {
        this.unsubscribe(client, printerId)
        return
      }
      if (!subscription.queuedFrame) return
      if (client.bufferedAmount > MAX_CLIENT_BUFFERED_BYTES) {
        this.scheduleRetry(client, printerId, subscription)
        return
      }
      const next = subscription.queuedFrame
      subscription.queuedFrame = null
      this.sendFrame(client, printerId, subscription, next)
    })
  }

  private framePacket(printerId: string, frame: Buffer): Buffer {
    const header = Buffer.from(printerId.padEnd(PRINTER_ID_LENGTH, ' '), 'ascii')
    return Buffer.concat([header, frame])
  }
}
