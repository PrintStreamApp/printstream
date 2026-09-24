/** Scoped device storage. Serializes edits in one API process; revisit for multi-node writes. */
import { z } from 'zod'
import type { ApiPluginContext } from '../../plugin/types.js'
import { messageNotificationScope } from '../../lib/notification-scope.js'

const deviceSchema = z.object({
  userId: z.string(), token: z.string(), bindingId: z.string().uuid(), origin: z.string().url(), updatedAt: z.number(),
  transport: z.enum(['direct', 'relay']).optional(), encryptionPublicKey: z.string().max(1024).optional()
})
export type MobileDevice = z.infer<typeof deviceSchema>
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** Private bounded lists use a renewable lease so forgotten devices expire. */
export class MobileSubscriptions {
  private pending = new Map<string | null, Promise<void>>()
  constructor(private context: ApiPluginContext) {}

  async read(scope: string | null): Promise<MobileDevice[]> {
    const raw = await messageNotificationScope(this.context, scope).settings.get('devices')
    if (!raw) return []
    return z.array(deviceSchema).parse(JSON.parse(raw)).filter((entry) => entry.updatedAt > Date.now() - MAX_AGE_MS)
  }

  async update(scope: string | null, change: (entries: MobileDevice[]) => MobileDevice[]): Promise<void> {
    const previous = this.pending.get(scope) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(async () => {
      const entries = change(await this.read(scope))
      if (entries.length > 500) throw new Error('Mobile device limit reached for this scope')
      await messageNotificationScope(this.context, scope).settings.set('devices', JSON.stringify(entries))
    })
    this.pending.set(scope, next)
    try {
      await next
    } finally {
      if (this.pending.get(scope) === next) this.pending.delete(scope)
    }
  }
}
