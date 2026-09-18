/** Native receivers have no session cookies. Publish only a bounded, short-lived copy of the scoped job image. */
import type { NotificationMessage } from '@printstream/shared'
import type { ApiPluginContext } from '../../plugin/types.js'
import { readPrintJobSnapshot } from '../../lib/print-job-snapshots.js'
import { storeSnapshot } from '../../lib/notification-snapshots.js'

/** Preserve public snapshot routes; translate authenticated job images without fetching arbitrary URLs. */
export async function withMobileNotificationImage(
  message: NotificationMessage,
  prisma: ApiPluginContext['prisma'],
  images = { read: readPrintJobSnapshot, store: storeSnapshot }
): Promise<NotificationMessage> {
  if (!message.imageUrl) return message
  let route: string
  try {
    route = new URL(message.imageUrl, 'https://notification.invalid').pathname
  } catch {
    return { ...message, imageUrl: undefined }
  }
  const jobId = /^\/api\/jobs\/([^/]+)\/snapshot$/.exec(route)?.[1]
  if (!jobId) return message
  if (!message.workspaceId) return { ...message, imageUrl: undefined }
  // Never allow a message in one workspace to expose a different workspace's persisted image.
  try {
    const job = await prisma.printJob.findFirst({
      where: { id: decodeURIComponent(jobId), printer: { workspaceId: message.workspaceId } },
      select: { snapshotPath: true }
    })
    const image = job?.snapshotPath ? await images.read(job.snapshotPath) : null
    const imageUrl = image && image.length <= 1024 * 1024
      ? `/api/notifications/snapshots/${images.store(image, 'image/jpeg')}`
      : undefined
    return { ...message, imageUrl }
  } catch {
    // Optional media must never prevent a time-sensitive text alert.
    console.warn('[notifications-mobile] Could not prepare notification image', { notificationId: message.id })
    return { ...message, imageUrl: undefined }
  }
}
