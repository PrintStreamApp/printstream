/**
 * Small acknowledgement seam for durable notification producers. A channel
 * owns enablement, recipient opt-ins and transport delivery. True means its
 * transport accepted delivery; false means it currently cannot deliver.
 * No queue or retry policy lives here; each producer retains its own intent.
 */
import type { NotificationMessage } from '@printstream/shared'

const channels = new Map<string, (message: NotificationMessage) => Promise<boolean>>()

export function registerAcknowledgedNotificationChannel(name: string, deliver: (message: NotificationMessage) => Promise<boolean>): () => void {
  channels.set(name, deliver)
  return () => { if (channels.get(name) === deliver) channels.delete(name) }
}

/** Throws on transport failure; unavailable channels return false without bypassing preferences. */
export async function deliverAcknowledgedNotification(name: string, message: NotificationMessage): Promise<boolean> {
  const channel = channels.get(name)
  return channel ? channel(message) : false
}
