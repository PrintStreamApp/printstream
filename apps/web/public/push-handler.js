/**
 * Service-worker import for the notifications-browser plugin.
 *
 * Imported by the workbox-generated service worker (see
 * `vite.config.ts` workbox.importScripts). Lives in /public so it
 * ships verbatim — no bundler can rewrite `self` references away.
 *
 * Contract: the API sends a JSON payload matching the
 * `NotificationMessage` shape in `@printstream/shared`. We translate it
 * into a browser Notification. `tag` lets a later "finished" message
 * replace an earlier "started" one for the same printer.
 */
/* eslint-disable */
self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: 'PrintStream', body: event.data ? event.data.text() : '' }
  }
  event.waitUntil(handlePushEvent(data))
})

self.addEventListener('notificationclick', (event) => {
  markNotificationCloseAsLocal(event.notification)
  event.notification.close()
  const targetUrl = resolveNotificationTargetUrl(event.notification.data && event.notification.data.url)
  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of clientList) {
      try {
        const url = new URL(client.url)
        if (url.origin === self.location.origin) {
          await client.focus()
          if ('navigate' in client) {
            try { await client.navigate(targetUrl) } catch {}
          }
          return
        }
      } catch {}
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl)
    }
  })())
})

self.addEventListener('notificationclose', (event) => {
  const data = event.notification.data || {}
  if (data.skipDismissSync) {
    return
  }

  const notificationId = data.notificationId
  const tag = event.notification.tag || data.tag
  if (!notificationId && !tag) {
    return
  }

  event.waitUntil(reportDismissal({ notificationId, tag }))
})

async function handlePushEvent(data) {
  if (data && data.type === 'dismiss') {
    await dismissMatchingNotifications(data)
    return
  }

  const title = data.title || 'PrintStream'
  const tag = data.tag || undefined
  if (tag) {
    await suppressDismissSyncForTag(tag)
  }

  const options = {
    body: data.body || '',
    tag,
    renotify: Boolean(tag),
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    image: data.imageUrl || undefined,
    actions: [{ action: 'open-in-app', title: 'Open in app' }],
    data: {
      notificationId: data.id,
      url: data.url || '/',
      printerId: data.printerId,
      category: data.category,
      imageUrl: data.imageUrl,
      tag,
      skipDismissSync: false
    }
  }
  await self.registration.showNotification(title, options)
}

async function suppressDismissSyncForTag(tag) {
  if (!tag) return
  const notifications = await self.registration.getNotifications({ tag })
  for (const notification of notifications) {
    markNotificationCloseAsLocal(notification)
  }
}

async function dismissMatchingNotifications(data) {
  const notifications = await self.registration.getNotifications(data.tag ? { tag: data.tag } : undefined)
  for (const notification of notifications) {
    const payload = notification.data || {}
    const matchesId = data.notificationId && payload.notificationId === data.notificationId
    const matchesTag = data.tag && (notification.tag === data.tag || payload.tag === data.tag)
    if (!matchesId && !matchesTag) {
      continue
    }
    markNotificationCloseAsLocal(notification)
    notification.close()
  }
}

async function reportDismissal(payload) {
  try {
    await fetch('/api/plugins/notifications-browser/dismissals', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
  } catch {
    // Best-effort only. Remote devices keep the notification if the app cannot report the dismissal.
  }
}

function markNotificationCloseAsLocal(notification) {
  if (!notification.data || typeof notification.data !== 'object') {
    return
  }
  notification.data.skipDismissSync = true
}

function resolveNotificationTargetUrl(rawUrl) {
  try {
    const target = new URL(rawUrl || '/', self.location.origin)
    return target.origin === self.location.origin ? target.href : self.location.origin + '/'
  } catch {
    return self.location.origin + '/'
  }
}
