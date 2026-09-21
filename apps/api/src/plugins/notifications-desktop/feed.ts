/**
 * Bounded reconnect buffer for running desktop clients. No device credentials or
 * subscriptions are stored here. The route rechecks session and membership on
 * every read. Assumes one API process, like the printer event bus; a multi-node
 * deployment needs a shared event log before this buffer can span nodes.
 */
import { randomUUID } from 'node:crypto'
import type { DesktopNotificationEvent, NotificationMessage } from '@printstream/shared'

interface Entry {
  sequence: number
  receivedAt: number
  workspaceId: string | null
  targetUserIds?: string[]
  event: DesktopNotificationEvent
}

export class DesktopNotificationFeed {
  private readonly epoch = randomUUID()
  private sequence = 0
  private entries: Entry[] = []

  constructor(private readonly now = Date.now) {}

  /** Cap both retention and count, including on quiet-server reads. */
  private prune(): void {
    const cutoff = this.now() - 60 * 60_000
    this.entries = this.entries.filter((entry) => entry.receivedAt > cutoff).slice(-2048)
  }

  add(message: NotificationMessage): void {
    this.append(message.workspaceId ?? null, message.targetUserIds, {
      id: message.id, type: 'notification', tag: message.tag ?? message.id,
      title: message.title.slice(0, 500), body: message.body.slice(0, 4000),
      url: message.url, imageUrl: message.imageUrl
    })
  }

  dismiss(message: { workspaceId: string | null; targetUserIds?: string[]; tag: string; notificationId?: string }): void {
    this.append(message.workspaceId, message.targetUserIds, {
      id: randomUUID(), type: 'dismiss', tag: message.tag, notificationId: message.notificationId
    })
  }

  private append(workspaceId: string | null, targetUserIds: string[] | undefined, event: DesktopNotificationEvent): void {
    this.entries.push({ sequence: ++this.sequence, receivedAt: this.now(), workspaceId, targetUserIds, event })
    this.prune()
  }

  /**
   * First enrollment starts now. Reconnects replay retained events; after a
   * server restart the new epoch replays its buffer. Personal platform events
   * may reach their named user through any enrolled membership, never others.
   */
  read(workspaceId: string | null, userId: string, cursor?: string) {
    this.prune()
    const [epoch, sequence] = cursor?.split(':') ?? []
    const after = !cursor ? this.sequence : epoch === this.epoch ? Number(sequence) : 0
    const events = this.entries.filter((entry) => {
      if (!Number.isSafeInteger(after) || entry.sequence <= after) return false
      const targeted = Boolean(entry.targetUserIds?.length)
      if (targeted && !entry.targetUserIds!.includes(userId)) return false
      return entry.workspaceId === workspaceId || (entry.workspaceId === null && targeted)
    }).map((entry) => entry.event)
    return { cursor: `${this.epoch}:${this.sequence}`, events }
  }
}
