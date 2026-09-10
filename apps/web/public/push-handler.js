/**
 * Service-worker import for the notifications-browser plugin.
 *
 * Imported by the workbox-generated service worker (see
 * `vite.config.ts` workbox.importScripts). Lives in /public so it
 * ships verbatim: no bundler can rewrite `self` references away.
 *
 * Contract: the API sends a JSON payload matching the
 * `NotificationMessage` shape in `@printstream/shared`. We translate it
 * into a browser Notification. `tag` lets a later "finished" message
 * replace an earlier "started" one for the same printer.
 *
 * ## Dismissal sync
 *
 * Dealing with a notification on ONE device clears it on the others. Both
 * gestures count and both are reported to
 * `POST /api/plugins/notifications-browser/dismissals`, which pushes a
 * `{ type: 'dismiss' }` payload to the same account's other devices:
 *
 * - `notificationclose`, the user swiped it away; and
 * - `notificationclick`, the user tapped it (or its action button).
 *
 * Reporting the CLICK is not optional garnish, and `notificationclose` does
 * not cover it. Chrome fires that event only for a dismissal BY THE USER, and
 * a click is closed programmatically right below, so a tap raises no close
 * event to fall back on. A click used to close the notification locally and
 * tell nobody, which left the most common "I have dealt with this" gesture
 * syncing to nothing: tapping an alert on a phone left it on the desktop.
 *
 * The cost, stated plainly because it is easy to under-count: a retraction
 * shows no notification, and Chrome charges a push that shows nothing against
 * the origin's `userVisibleOnly` budget, on the RECEIVING device. Excluding
 * the reporting device saves that device only; the others still pay, and
 * clearing a stack of alerts on a phone spends budget on every other device
 * signed into the same account. Nothing here can avoid that, since whether a
 * remote device still has the notification up is unknowable from the sender.
 * It is bounded instead: the server collapses retractions per tag with a push
 * `Topic`, so a burst coalesces for any device that is offline, and sends them
 * at `low` urgency. Do not add a retraction that fires more often than a
 * gesture the user actually made.
 *
 * Counterpart: `apps/api/src/plugins/notifications-browser/index.ts`.
 */
/* eslint-disable */

/**
 * Notifications this service worker closed ITSELF, so their close is not
 * reported back as a user dismissal (which would echo, or re-report a click
 * we already reported). Keyed by notification id where there is one, falling
 * back to the collapse tag.
 *
 * Entries EXPIRE, and that is the whole design constraint. A mark that
 * outlived its close would swallow the next genuine dismissal, most
 * visibly for a tag-keyed mark, where the replacement notification shares
 * its predecessor's key. Every self-close fires within a tick of its mark,
 * so a short window covers all of them; a user dismissal arriving later is
 * reported normally. (This replaces mutating `notification.data`, which
 * cannot work: `data` is a structured clone, so the write never reached the
 * stored notification and the guard silently did nothing.)
 */
const LOCAL_CLOSE_TTL_MS = 15000
const localCloses = new Map()

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
  const notification = event.notification
  // Mark BEFORE closing: on an engine that fires `notificationclose` for a
  // programmatic close, the close must not report the dismissal a second time.
  markLocalClose(notificationDismissKeys(notification))
  notification.close()

  const targetUrl = resolveNotificationTargetUrl(notification.data && notification.data.url)
  event.waitUntil((async () => {
    // Start the report but do NOT await it before opening the app. Focusing a
    // client and `openWindow` both consume the click's user activation, which
    // expires within seconds; awaiting a fetch on a cold radio outlives it, and
    // the tap then does nothing at all beyond dismissing the notification.
    // Acting on it here means it is dealt with everywhere, but opening comes
    // first because that is what the user asked for.
    const reported = reportDismissalFor(notification)
    try {
      await focusOrOpenClient(targetUrl)
    } finally {
      await reported
    }
  })())
})

/** Focus an existing same-origin window and route it, or open a new one. */
async function focusOrOpenClient(targetUrl) {
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
    try { await self.clients.openWindow(targetUrl) } catch {}
  }
}

self.addEventListener('notificationclose', (event) => {
  const notification = event.notification
  if (consumeLocalClose(notificationDismissKeys(notification))) {
    return
  }
  event.waitUntil(reportDismissalFor(notification))
})

async function handlePushEvent(data) {
  if (data && data.type === 'dismiss') {
    await dismissMatchingNotifications(data)
    return
  }

  const title = data.title || 'PrintStream'
  const tag = data.tag || undefined
  if (tag && await isTagVisibleInFocusedClient(tag)) {
    // The user is looking at this notification's subject right now (e.g. the
    // support thread it announces is open and focused), so an OS notification
    // would be noise. Skipping showNotification is allowed here: Chrome's
    // userVisibleOnly rule exempts pushes handled while a client is focused.
    return
  }
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
      tag
    }
  }
  await self.registration.showNotification(title, options)
}

/**
 * Whether any visible window client currently has this tag's subject surface
 * on screen. Each candidate client is asked over a MessageChannel (answered
 * by the notifications-browser plugin's visibility responder); no answer
 * within the timeout counts as "not visible" so a wedged page never blocks
 * the notification.
 */
async function isTagVisibleInFocusedClient(tag) {
  try {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const candidates = clientList.filter((client) => client.visibilityState === 'visible')
    if (candidates.length === 0) return false
    const answers = await Promise.all(candidates.map((client) => askTagVisibility(client, tag)))
    return answers.some(Boolean)
  } catch {
    return false
  }
}

function askTagVisibility(client, tag) {
  return new Promise((resolve) => {
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), 400)
    try {
      const channel = new MessageChannel()
      channel.port1.onmessage = (event) => {
        clearTimeout(timer)
        finish(Boolean(event.data && event.data.visible))
      }
      client.postMessage({ type: 'notification-tag-visibility-check', tag }, [channel.port2])
    } catch {
      clearTimeout(timer)
      finish(false)
    }
  })
}

/**
 * A replacement notification for this tag is about to be shown; the implicit
 * close of the one it replaces is ours, not the user's. Marked by the OLD
 * notification's own id where it has one, so the mark cannot be mistaken for
 * a dismissal of the replacement that shares its tag.
 */
async function suppressDismissSyncForTag(tag) {
  if (!tag) return
  const notifications = await self.registration.getNotifications({ tag })
  for (const notification of notifications) {
    markLocalClose(notificationDismissKeys(notification))
  }
}

async function dismissMatchingNotifications(data) {
  const notifications = await self.registration.getNotifications(data.tag ? { tag: data.tag } : undefined)
  for (const notification of notifications) {
    if (!notificationMatchesDismissal(notification, data)) {
      continue
    }
    // Retracted on our own account's instruction: closing it must not report
    // a dismissal straight back and start a loop.
    markLocalClose(notificationDismissKeys(notification))
    notification.close()
  }
}

/**
 * Whether a retraction is about THIS notification.
 *
 * The id wins whenever both sides carry one, and the tag is never consulted in
 * that case. Matching either way would let a dismissal close a DIFFERENT
 * notification that merely shares the tag: tags collapse a printer's job
 * updates, so a device that was asleep for "Print failed" still shows "Print
 * started", and dismissing the stale one there would retract the failure
 * alert here, unseen. Falling back to the tag covers the retractions that
 * carry no id at all (the server's read-state `notification.dismiss`), and
 * notifications shown by an older worker that stored none.
 */
function notificationMatchesDismissal(notification, data) {
  const payload = notification.data || {}
  if (data.notificationId && payload.notificationId) {
    return payload.notificationId === data.notificationId
  }
  const tag = notification.tag || payload.tag
  return Boolean(data.tag && tag === data.tag)
}

/** The keys a notification is tracked by, most specific first. */
function notificationDismissKeys(notification) {
  const data = (notification && notification.data) || {}
  const keys = []
  if (data.notificationId) keys.push('id:' + data.notificationId)
  const tag = (notification && notification.tag) || data.tag
  // A tag-only key is a fallback for notifications with no id (older
  // payloads); an id makes the mark specific to this notification.
  if (keys.length === 0 && tag) keys.push('tag:' + tag)
  return keys
}

function markLocalClose(keys) {
  const now = Date.now()
  // Prune here too, not only on close: an engine that never fires
  // `notificationclose` for a programmatic close (Chrome) would otherwise let
  // marks accumulate for the life of the worker.
  pruneLocalCloses(now)
  const expiry = now + LOCAL_CLOSE_TTL_MS
  for (const key of keys) localCloses.set(key, expiry)
}

/** Whether this close was ours; consumes the mark either way. */
function consumeLocalClose(keys) {
  pruneLocalCloses(Date.now())
  let matched = false
  for (const key of keys) {
    if (localCloses.delete(key)) matched = true
  }
  return matched
}

function pruneLocalCloses(now) {
  for (const [key, expiry] of localCloses) {
    if (expiry <= now) localCloses.delete(key)
  }
}

async function reportDismissalFor(notification) {
  const data = (notification && notification.data) || {}
  const notificationId = data.notificationId
  const tag = (notification && notification.tag) || data.tag
  if (!notificationId && !tag) {
    return
  }
  await reportDismissal({ notificationId, tag, endpoint: await currentPushEndpoint() })
}

/**
 * This device's own push endpoint, so the server can leave it out of the
 * fan-out: the notification is already gone here, and a push that shows
 * nothing still spends the browser's silent-push allowance.
 */
async function currentPushEndpoint() {
  try {
    const subscription = await self.registration.pushManager.getSubscription()
    return subscription ? subscription.endpoint : undefined
  } catch {
    return undefined
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

function resolveNotificationTargetUrl(rawUrl) {
  try {
    const target = new URL(rawUrl || '/', self.location.origin)
    return target.origin === self.location.origin ? target.href : self.location.origin + '/'
  } catch {
    return self.location.origin + '/'
  }
}
