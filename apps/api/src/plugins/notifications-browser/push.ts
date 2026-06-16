/**
 * Web Push helpers for the browser-notifications plugin.
 *
 * Owns VAPID key lifecycle and the subscription list, both persisted
 * in the plugin's `Setting` store so they survive restarts. Kept
 * inside the plugin (not in `lib/`) because Web Push is specific to
 * this delivery channel; other notification plugins do not import it.
 */
import webpush, { type PushSubscription } from 'web-push'
import type { PluginSettingStore, PluginLogger } from '../../plugin/types.js'

const VAPID_PUBLIC_KEY = 'vapidPublicKey'
const VAPID_PRIVATE_KEY = 'vapidPrivateKey'
const VAPID_SUBJECT_KEY = 'vapidSubject'
const SUBSCRIPTIONS_KEY = 'subscriptions'
/**
 * Default `mailto:` claim included in every signed push request.
 * Push services require *some* contact, but we don't want to ask the
 * user to set one — the address is opaque to end users.
 */
const DEFAULT_VAPID_SUBJECT = 'mailto:printstream@local'

export interface StoredSubscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
  /** ISO timestamp set by the server when the subscription is registered. */
  createdAt: string
  /** Optional UA string captured from the registering request, used only for display. */
  userAgent?: string
  /** Stable actor key so per-account dismissal sync can target only that account's devices. */
  actorKey?: string
}

export class WebPushDelivery {
  private publicKey = ''
  private privateKey = ''
  private subject = DEFAULT_VAPID_SUBJECT
  private subscriptions: StoredSubscription[] = []

  constructor(
    private readonly settings: PluginSettingStore,
    private readonly logger: PluginLogger
  ) {}

  /**
   * Load persisted delivery state.
   *
   * Server-wide instances own the shared VAPID keys and should use the
   * default behavior. Tenant-scoped instances should restore only the
   * subscription list and continue signing with the server-wide keypair.
   */
  async load(options: { includeVapid?: boolean } = {}): Promise<void> {
    const { includeVapid = true } = options
    const subsRaw = await this.settings.get(SUBSCRIPTIONS_KEY)
    this.subscriptions = parseSubscriptions(subsRaw)

    if (!includeVapid) {
      return
    }

    const [pub, priv, subj] = await Promise.all([
      this.settings.get(VAPID_PUBLIC_KEY),
      this.settings.get(VAPID_PRIVATE_KEY),
      this.settings.get(VAPID_SUBJECT_KEY)
    ])

    if (pub && priv) {
      this.publicKey = pub
      this.privateKey = priv
    } else {
      const keys = webpush.generateVAPIDKeys()
      this.publicKey = keys.publicKey
      this.privateKey = keys.privateKey
      await this.settings.set(VAPID_PUBLIC_KEY, this.publicKey)
      await this.settings.set(VAPID_PRIVATE_KEY, this.privateKey)
      this.logger.info('generated new VAPID keypair')
    }

    this.subject = subj && subj.length > 0 ? subj : DEFAULT_VAPID_SUBJECT
  }

  getPublicKey(): string {
    return this.publicKey
  }

  getPrivateKey(): string {
    return this.privateKey
  }

  getSubject(): string {
    return this.subject
  }

  /**
   * Override the VAPID keys used for signing. Used by per-tenant
   * delivery instances so they share the server-wide keypair without
   * regenerating their own.
   */
  setVapidKeys(publicKey: string, privateKey: string, subject: string): void {
    this.publicKey = publicKey
    this.privateKey = privateKey
    this.subject = subject
  }

  async setSubject(value: string): Promise<void> {
    const trimmed = value.trim()
    if (!trimmed) {
      this.subject = DEFAULT_VAPID_SUBJECT
      await this.settings.delete(VAPID_SUBJECT_KEY)
      return
    }
    if (!/^(mailto:|https?:\/\/)/i.test(trimmed)) {
      throw new Error('VAPID subject must be a mailto: or https:// URL')
    }
    this.subject = trimmed
    await this.settings.set(VAPID_SUBJECT_KEY, trimmed)
  }

  /**
   * Add or refresh a subscription. Replaces by `endpoint` so a client
   * that re-subscribes (after permission reset, etc) doesn't create
   * duplicate entries.
   */
  async addSubscription(input: { subscription: PushSubscription; userAgent?: string; actorKey?: string }): Promise<void> {
    const { subscription, userAgent, actorKey } = input
    const next: StoredSubscription = {
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      createdAt: new Date().toISOString(),
      userAgent,
      actorKey
    }
    this.subscriptions = this.subscriptions
      .filter((entry) => entry.endpoint !== subscription.endpoint)
      .concat(next)
    await this.persist()
  }

  async removeSubscription(endpoint: string): Promise<boolean> {
    const before = this.subscriptions.length
    this.subscriptions = this.subscriptions.filter((entry) => entry.endpoint !== endpoint)
    if (this.subscriptions.length === before) return false
    await this.persist()
    return true
  }

  size(): number {
    return this.subscriptions.length
  }

  /**
   * Fan out a JSON payload to every stored subscription. Subscriptions
   * the push service rejects as gone (HTTP 404/410) are dropped from
   * the list so dead browsers don't accumulate.
   */
  async sendToAll(payload: unknown): Promise<void> {
    await this.sendFiltered(payload, () => true)
  }

  async sendToActor(actorKey: string, payload: unknown): Promise<void> {
    await this.sendFiltered(payload, (entry) => entry.actorKey === actorKey)
  }

  /** Fan out only to subscriptions for which `predicate` returns true. */
  async sendMatching(payload: unknown, predicate: (entry: StoredSubscription) => boolean): Promise<void> {
    await this.sendFiltered(payload, predicate)
  }

  /** Read-only snapshot of the stored subscriptions. */
  listSubscriptions(): readonly StoredSubscription[] {
    return this.subscriptions
  }

  private async sendFiltered(payload: unknown, predicate: (entry: StoredSubscription) => boolean): Promise<void> {
    const recipients = this.subscriptions.filter(predicate)
    if (recipients.length === 0) return
    if (this.subscriptions.length === 0) return
    const body = JSON.stringify(payload)
    const options = {
      vapidDetails: {
        subject: this.subject,
        publicKey: this.publicKey,
        privateKey: this.privateKey
      },
      TTL: 60
    }

    const results = await Promise.allSettled(
      recipients.map((entry) =>
        webpush.sendNotification(toPushSubscription(entry), body, options)
      )
    )

    const dead = new Set<string>()
    results.forEach((result, index) => {
      const entry = recipients[index]
      if (!entry) return
      if (result.status === 'fulfilled') return
      const error = result.reason as { statusCode?: number; message?: string }
      if (error?.statusCode === 404 || error?.statusCode === 410) {
        dead.add(entry.endpoint)
      } else {
        this.logger.warn('web-push delivery failed', {
          endpoint: entry.endpoint,
          status: error?.statusCode,
          message: error?.message
        })
      }
    })

    if (dead.size > 0) {
      this.subscriptions = this.subscriptions.filter((entry) => !dead.has(entry.endpoint))
      await this.persist()
      this.logger.info(`pruned ${dead.size} dead push subscription(s)`)
    }
  }

  private async persist(): Promise<void> {
    await this.settings.set(SUBSCRIPTIONS_KEY, JSON.stringify(this.subscriptions))
  }
}

function parseSubscriptions(raw: string | null): StoredSubscription[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is StoredSubscription => {
      if (typeof entry !== 'object' || entry === null) return false
      const candidate = entry as Partial<StoredSubscription>
      return (
        typeof candidate.endpoint === 'string' &&
        typeof candidate.keys?.p256dh === 'string' &&
        typeof candidate.keys?.auth === 'string' &&
        (candidate.actorKey === undefined || typeof candidate.actorKey === 'string')
      )
    })
  } catch {
    return []
  }
}

/**
 * Internal-typed proxy used by `web-push`. Storing extra metadata
 * (createdAt, userAgent) is fine, but the library only wants the
 * subset that matches the browser's `PushSubscriptionJSON` shape.
 */
function toPushSubscription(entry: StoredSubscription): PushSubscription {
  return { endpoint: entry.endpoint, keys: entry.keys }
}

/** Re-exported for the route-layer Zod schema. */
export type { PushSubscription }
