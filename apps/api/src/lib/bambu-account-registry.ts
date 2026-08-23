/**
 * Bambu Lab account credential registry.
 *
 * The plugin that owns the workspace's Bambu Cloud connection (`bambu-cloud-sync`)
 * registers a resolver here; other plugins that need to act as the signed-in Bambu
 * user, today `remote-imports`, to download a MakerWorld model, ask this core seam
 * instead of importing the owning plugin or reading its setting keys. Mirrors
 * `slot-filament-registry.ts`.
 *
 * Trust boundary, and why it is drawn here: the resolver hands back a REAL account
 * access token, which is the user's whole Bambu identity, not a scoped download
 * grant: Bambu issues nothing narrower. So this seam is for first-party built-in
 * plugins only, every consumer must gate on its own explicit user opt-in (enabling
 * the connection for preset sync is not consent to anything else), and the token
 * must never reach the browser, a log line, or an error message. `accountLabel` is
 * the display-safe half: it names whose account an action will run under, which a
 * consumer's UI is expected to show.
 *
 * Best-effort by design: with no resolver registered (owning plugin absent or
 * disabled for the workspace) `resolve` returns null and the consumer must degrade
 * to whatever it can do unauthenticated. A resolver that throws is treated as "no
 * credential" so one plugin's failure cannot break another.
 */

/** A workspace's connected Bambu Lab account, as far as a consuming plugin needs it. */
export interface BambuAccountCredential {
  /**
   * Bearer token for Bambu's APIs. Accepted by `api.bambulab.com` AND by
   * `makerworld.com` (verified: `Authorization: Bearer <token>` authorizes
   * `design-service` reads and model downloads). Secret, never log or serialize it.
   */
  accessToken: string
  /** Which Bambu region the connection belongs to; picks the API host. */
  region: 'global' | 'china'
  /**
   * Display-safe identifier for the account (the sign-in email). Not a secret, and
   * intended to be SHOWN: a workspace has one shared connection, so an action taken
   * with it runs under one member's account and the UI should say whose.
   */
  accountLabel: string
}

export interface BambuAccountQuery {
  workspaceId: string
}

/** Returns the workspace's connected Bambu account, or `null` when none is usable. */
export type BambuAccountResolver = (query: BambuAccountQuery) => Promise<BambuAccountCredential | null>

class BambuAccountRegistry {
  private readonly resolvers = new Set<BambuAccountResolver>()

  register(resolver: BambuAccountResolver): () => void {
    this.resolvers.add(resolver)
    return () => this.resolvers.delete(resolver)
  }

  /**
   * Ask each registered resolver in turn and return the first credential found.
   * `null` means no connected, unexpired account for this workspace: callers must
   * treat that as a normal state and say so in the UI, not as an error.
   */
  async resolve(query: BambuAccountQuery): Promise<BambuAccountCredential | null> {
    for (const resolver of this.resolvers) {
      try {
        const result = await resolver(query)
        if (result) return result
      } catch (error) {
        // Best-effort, but never silent: a throwing resolver otherwise reads downstream
        // as "no Bambu account connected", which sends the user to reconnect an account
        // that was actually fine.
        console.warn('[bambu-account] a resolver threw; treating as no credential', error instanceof Error ? error.message : error)
      }
    }
    return null
  }

  size(): number {
    return this.resolvers.size
  }
}

export const bambuAccountResolvers = new BambuAccountRegistry()
