/**
 * Drives the SHIPPED service-worker source (`public/push-handler.js`) against
 * a fake `self`. The file cannot be imported: it ships verbatim to `/public`
 * so no bundler rewrites its `self` references, which is also why it had no
 * coverage at all while two dismissal-sync defects sat in it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const SOURCE = readFileSync(fileURLToPath(new URL('../../../public/push-handler.js', import.meta.url)), 'utf8')

interface FakeNotification {
  tag?: string
  data: Record<string, unknown>
  close: () => void
  closed: boolean
}

interface DismissalPost {
  notificationId?: string
  tag?: string
  endpoint?: string
}

/** A service-worker global with just enough surface for the handler. */
function createServiceWorkerHarness(options: { endpoint?: string; fetchGate?: Promise<void> } = {}) {
  const listeners = new Map<string, (event: unknown) => void>()
  const shown: FakeNotification[] = []
  const posted: DismissalPost[] = []
  const opened: string[] = []

  const notify = (title: string, notificationOptions: Record<string, unknown>): FakeNotification => {
    const notification: FakeNotification = {
      tag: notificationOptions.tag as string | undefined,
      data: (notificationOptions.data ?? {}) as Record<string, unknown>,
      closed: false,
      close() { this.closed = true }
    }
    // Mirror the browser's tag semantics: a tagged notification replaces the
    // one it shares a tag with rather than stacking beside it.
    if (notification.tag) {
      const index = shown.findIndex((entry) => entry.tag === notification.tag)
      if (index >= 0) shown.splice(index, 1)
    }
    shown.push(notification)
    return notification
  }

  const self = {
    addEventListener(type: string, handler: (event: unknown) => void) { listeners.set(type, handler) },
    location: { origin: 'https://printstream.test' },
    clients: {
      async matchAll() { return [] },
      async openWindow(url: string) { opened.push(url); return null }
    },
    registration: {
      async showNotification(title: string, notificationOptions: Record<string, unknown>) {
        notify(title, notificationOptions)
      },
      async getNotifications(filter?: { tag?: string }) {
        return shown.filter((entry) => !entry.closed && (!filter?.tag || entry.tag === filter.tag))
      },
      pushManager: {
        async getSubscription() {
          return options.endpoint === undefined ? null : { endpoint: options.endpoint }
        }
      }
    }
  }

  const fetchStub = async (_url: string, init: { body: string }) => {
    // `fetchGate` models a slow network: the report stays pending until the
    // test releases it, so an assertion can run in between.
    if (options.fetchGate) await options.fetchGate
    posted.push(JSON.parse(init.body) as DismissalPost)
    return { ok: true }
  }

  new Function('self', 'fetch', SOURCE)(self, fetchStub)

  const pending: Array<Promise<unknown>> = []
  const waitUntil = (promise: Promise<unknown>) => { pending.push(promise) }
  const settle = async () => {
    while (pending.length > 0) await pending.shift()
  }

  return {
    shown,
    posted,
    opened,
    async push(payload: Record<string, unknown>) {
      listeners.get('push')?.({ data: { json: () => payload }, waitUntil })
      await settle()
    },
    async click(notification: FakeNotification) {
      listeners.get('notificationclick')?.({ notification, waitUntil })
      await settle()
    },
    async close(notification: FakeNotification) {
      listeners.get('notificationclose')?.({ notification, waitUntil })
      await settle()
    }
  }
}

test('tapping a notification reports its dismissal to the other devices', async () => {
  const worker = createServiceWorkerHarness({ endpoint: 'https://push.example.test/this-device' })
  await worker.push({ id: 'n1', title: 'Print finished', tag: 'printer:p1:job' })

  const notification = worker.shown[0]!
  await worker.click(notification)

  assert.equal(notification.closed, true)
  assert.deepEqual(worker.posted, [{
    notificationId: 'n1',
    tag: 'printer:p1:job',
    endpoint: 'https://push.example.test/this-device'
  }])
})

test('swiping a notification away reports its dismissal', async () => {
  const worker = createServiceWorkerHarness({ endpoint: 'https://push.example.test/this-device' })
  await worker.push({ id: 'n1', title: 'Print finished', tag: 'printer:p1:job' })

  await worker.close(worker.shown[0]!)

  assert.deepEqual(worker.posted, [{
    notificationId: 'n1',
    tag: 'printer:p1:job',
    endpoint: 'https://push.example.test/this-device'
  }])
})

test('a tap whose close event also fires reports exactly once', async () => {
  // Chrome fires `notificationclose` only for a user dismissal, but that is
  // not guaranteed across engines: a programmatic close must not double-post.
  const worker = createServiceWorkerHarness()
  await worker.push({ id: 'n1', title: 'Print finished', tag: 'printer:p1:job' })

  const notification = worker.shown[0]!
  await worker.click(notification)
  await worker.close(notification)

  assert.equal(worker.posted.length, 1)
})

test('a dismissal arriving from another device closes locally without reporting back', async () => {
  const worker = createServiceWorkerHarness()
  await worker.push({ id: 'n1', title: 'Print finished', tag: 'printer:p1:job' })
  const notification = worker.shown[0]!

  await worker.push({ type: 'dismiss', notificationId: 'n1', tag: 'printer:p1:job' })
  assert.equal(notification.closed, true)

  // The close the retraction caused must not echo a dismissal back, or two
  // devices bounce one notification between them.
  await worker.close(notification)
  assert.deepEqual(worker.posted, [])
})

test('replacing a tagged notification does not consume the replacement dismissal', async () => {
  const worker = createServiceWorkerHarness()
  await worker.push({ id: 'n1', title: 'Print started', tag: 'printer:p1:job' })
  const started = worker.shown[0]!

  // "finished" replaces "started" on the same tag; the implicit close of the
  // one it replaced is ours.
  await worker.push({ id: 'n2', title: 'Print finished', tag: 'printer:p1:job' })
  const finished = worker.shown[0]!
  await worker.close(started)
  assert.deepEqual(worker.posted, [])

  // The replacement shares that tag, so a mark keyed on the tag alone would
  // have swallowed this genuine dismissal too.
  // No endpoint key at all: this device holds no push subscription, and
  // `JSON.stringify` drops the undefined rather than sending a null the
  // route's `z.string().url()` would reject.
  await worker.close(finished)
  assert.deepEqual(worker.posted, [{ notificationId: 'n2', tag: 'printer:p1:job' }])
})

test('a tap opens the app even while the dismissal report is still in flight', async () => {
  // Focusing a client consumes the click's user activation, which expires in
  // seconds. Awaiting the report first (a fetch on a cold radio) outlives it,
  // and the tap then only dismisses the notification without opening anything.
  let releaseReport = () => {}
  const worker = createServiceWorkerHarness({
    endpoint: 'https://push.example.test/this-device',
    fetchGate: new Promise<void>((resolve) => { releaseReport = resolve })
  })
  await worker.push({ id: 'n1', title: 'Print finished', tag: 'printer:p1:job' })

  const clicked = worker.click(worker.shown[0]!)
  await Promise.resolve()
  await Promise.resolve()

  assert.equal(worker.opened.length, 1, 'the app should open before the report resolves')
  releaseReport()
  await clicked
  assert.equal(worker.posted.length, 1)
})

test('a tap preserves an in-app deep link and rejects an external destination', async () => {
  const worker = createServiceWorkerHarness()

  await worker.push({
    id: 'n1',
    title: 'Support reply',
    url: '/workspaces/home/account/messages?conversation=conv-1'
  })
  await worker.click(worker.shown[0]!)
  assert.equal(
    worker.opened[0],
    'https://printstream.test/workspaces/home/account/messages?conversation=conv-1'
  )

  await worker.push({ id: 'n2', title: 'Unsafe link', url: 'https://evil.example/messages' })
  await worker.click(worker.shown[1]!)
  assert.equal(worker.opened[1], 'https://printstream.test/')
})

test('a dismissal naming an id never retracts a different notification sharing its tag', async () => {
  // The desktop slept through "Print failed" (n2) and still shows "Print
  // started" (n1) under the same tag. Dismissing n1 elsewhere must not close
  // n2 here: matching on the tag as well as the id retracts the alert the
  // user has not seen yet.
  const worker = createServiceWorkerHarness()
  await worker.push({ id: 'n2', title: 'Print failed', tag: 'printer:p1:job' })
  const unseen = worker.shown[0]!

  await worker.push({ type: 'dismiss', notificationId: 'n1', tag: 'printer:p1:job' })

  assert.equal(unseen.closed, false)
})

test('a retraction carrying only a tag still closes by tag', async () => {
  // The server's read-state `notification.dismiss` has no id to match on.
  const worker = createServiceWorkerHarness()
  await worker.push({ id: 'n1', title: 'New reply', tag: 'support:c1' })

  await worker.push({ type: 'dismiss', tag: 'support:c1' })

  assert.equal(worker.shown[0]!.closed, true)
})

test('a notification with neither id nor tag reports nothing', async () => {
  const worker = createServiceWorkerHarness()
  await worker.push({ title: 'Something happened' })

  await worker.click(worker.shown[0]!)
  await worker.close(worker.shown[0]!)

  assert.deepEqual(worker.posted, [])
})
