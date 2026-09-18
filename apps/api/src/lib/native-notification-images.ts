/**
 * Prepares notification snapshots for native clients that cannot reuse a browser session.
 * Persisted job images require authentication, so this module copies only the message's
 * workspace-owned image into the short-lived notification capability cache.
 */
import type { NotificationMessage } from '@printstream/shared'
import { readPrintJobSnapshot } from './print-job-snapshots.js'
import { storeSnapshot } from './notification-snapshots.js'
import type { AnyPrismaClient } from './prisma.js'

const MAX_NATIVE_IMAGE_BYTES = 3 * 1024 * 1024

interface NativeNotificationImageDependencies {
  read: typeof readPrintJobSnapshot
  store: typeof storeSnapshot
}

const defaultDependencies: NativeNotificationImageDependencies = {
  read: readPrintJobSnapshot,
  store: storeSnapshot
}

/**
 * Return a message whose optional image can be fetched without cookies.
 * Public notification capability URLs already meet that contract and pass through unchanged.
 * Any lookup or file failure removes only the image so the time-sensitive text still ships.
 */
export async function prepareNativeNotificationImage(
  message: NotificationMessage,
  prisma: AnyPrismaClient,
  images: NativeNotificationImageDependencies = defaultDependencies
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

  try {
    const job = await prisma.printJob.findFirst({
      where: {
        id: decodeURIComponent(jobId),
        printer: { workspaceId: message.workspaceId }
      },
      select: { snapshotPath: true }
    })
    const image = job?.snapshotPath ? await images.read(job.snapshotPath) : null
    const imageUrl = image && image.length <= MAX_NATIVE_IMAGE_BYTES
      ? `/api/notifications/snapshots/${images.store(image, 'image/jpeg')}`
      : undefined

    return { ...message, imageUrl }
  } catch {
    // Optional media must never prevent a time-sensitive text alert.
    return { ...message, imageUrl: undefined }
  }
}
