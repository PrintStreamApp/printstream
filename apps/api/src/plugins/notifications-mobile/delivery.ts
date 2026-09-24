/** Event fan-out for native devices, with live membership checks and cross-scope deduplication. */
import type { NotificationMessage } from '@printstream/shared'
import type { ApiPluginContext } from '../../plugin/types.js'
import { listWorkspaceScopesWithPluginSetting } from '../../lib/notification-scope.js'
import { mayReceiveMobileNotifications } from './access.js'
import { MobileSubscriptions } from './subscriptions.js'
import { buildMobileDismissData, buildMobilePushData } from './fcm.js'
import { mobileDeliveryTransport, sendMobileNotification } from './transport.js'
import { prepareNativeNotificationImage } from '../../lib/native-notification-images.js'

/** Return a scope-safe sender; injected transport functions allow tests without real device tokens. */
export function mobileNotificationHandler(context: ApiPluginContext, subscriptions: MobileSubscriptions, transport = {
  configured: () => mobileDeliveryTransport() !== 'unavailable',
  send: sendMobileNotification
}) {
  return async (message: NotificationMessage): Promise<number> => {
    if (!transport.configured()) return 0
    const scope = message.workspaceId ?? null
    const scopes = !scope && message.targetUserIds?.length
      ? [null, ...await listWorkspaceScopesWithPluginSetting(context.prisma, context.pluginName, 'devices')]
      : [scope]
    const delivered = new Set<string>()
    let prepared: Promise<NotificationMessage> | undefined
    let accepted = 0
    for (const current of scopes) {
      if (!(context.isEnabledForWorkspace?.(current) ?? true)) continue
      const devices = await subscriptions.read(current)
      // Bound concurrent HTTP calls; one slow device must not delay every other phone.
      for (let offset = 0; offset < devices.length; offset += 8) {
        await Promise.all(devices.slice(offset, offset + 8).map(async (entry) => {
          if (delivered.has(entry.token)) return
          if (message.targetUserIds?.length && !message.targetUserIds.includes(entry.userId)) return
          if (!await mayReceiveMobileNotifications(context, entry.userId, current)) return
          if (delivered.has(entry.token)) return
          delivered.add(entry.token)
          try {
            prepared ??= prepareNativeNotificationImage(message, context.prisma)
            if (await transport.send(
              entry.token,
              buildMobilePushData(await prepared, entry.origin, entry.bindingId, current),
              entry.transport ?? 'direct',
              entry.encryptionPublicKey
            )) {
              accepted++
            } else {
              await subscriptions.update(current, (entries) => entries.filter((device) => device.token !== entry.token))
            }
          } catch {
            context.logger.warn('Native notification delivery failed', { notificationId: message.id, workspaceId: current })
          }
        }))
      }
    }
    return accepted
  }
}

/** Send a tag retraction to one authenticated user's enrolled Android devices. */
export function mobileDismissalHandler(context: ApiPluginContext, subscriptions: MobileSubscriptions, transport = {
  configured: () => mobileDeliveryTransport() !== 'unavailable',
  send: sendMobileNotification
}) {
  return async (event: {
    tag: string
    notificationId?: string
    targetUserIds?: string[]
    excludeMobileBindingIds?: string[]
  }): Promise<number> => {
    if (!transport.configured() || !event.targetUserIds?.length) return 0
    const scopes = [null, ...await listWorkspaceScopesWithPluginSetting(context.prisma, context.pluginName, 'devices')]
    const excluded = new Set(event.excludeMobileBindingIds ?? [])
    const delivered = new Set<string>()
    let accepted = 0

    for (const scope of scopes) {
      if (!(context.isEnabledForWorkspace?.(scope) ?? true)) continue
      const devices = await subscriptions.read(scope)
      for (let offset = 0; offset < devices.length; offset += 8) {
        await Promise.all(devices.slice(offset, offset + 8).map(async (entry) => {
          if (delivered.has(entry.token) || excluded.has(entry.bindingId)) return
          if (!event.targetUserIds!.includes(entry.userId)) return
          if (!await mayReceiveMobileNotifications(context, entry.userId, scope)) return
          if (delivered.has(entry.token)) return
          delivered.add(entry.token)
          try {
            if (await transport.send(
              entry.token,
              buildMobileDismissData(event.tag, event.notificationId, entry.origin, entry.bindingId),
              entry.transport ?? 'direct',
              entry.encryptionPublicKey
            )) {
              accepted++
            } else {
              await subscriptions.update(scope, (entries) => entries.filter((device) => device.token !== entry.token))
            }
          } catch {
            context.logger.warn('Native notification dismissal delivery failed', { workspaceId: scope })
          }
        }))
      }
    }

    return accepted
  }
}
