/**
 * Slot-filament resolver registry.
 *
 * A plugin that owns filament/spool inventory (today: `filament-manager`) can
 * register a resolver that answers "which spool is loaded in this AMS slot, and
 * what is its identity?". Other plugins that need that association — e.g.
 * `calibration`, to tie a run to the loaded spool and reuse its saved value —
 * consult the registry through this shared core seam instead of importing the
 * owning plugin or reaching into its tables.
 *
 * The registry is best-effort and optional: with no resolver registered (the
 * owning plugin absent or disabled for the tenant) `resolve` returns `null` and
 * consumers fall back to whatever they can observe on their own. A resolver that
 * throws is treated as "no answer" so one plugin's failure never breaks another.
 */

/** Identity of the filament/spool loaded in a slot. Any field may be null when unknown. */
export interface SlotFilamentIdentity {
  /** The owning plugin's spool record id, if the slot maps to a tracked spool. */
  spoolId: string | null
  brand: string | null
  filamentType: string | null
  materialSubtype: string | null
  colorName: string | null
}

export interface SlotFilamentQuery {
  tenantId: string
  printerId: string
  amsId: number
  slotId: number
}

/** Returns the loaded spool's identity for a slot, or `null` if none is tracked. */
export type SlotFilamentResolver = (query: SlotFilamentQuery) => Promise<SlotFilamentIdentity | null>

class SlotFilamentResolverRegistry {
  private readonly resolvers = new Set<SlotFilamentResolver>()

  register(resolver: SlotFilamentResolver): () => void {
    this.resolvers.add(resolver)
    return () => this.resolvers.delete(resolver)
  }

  /**
   * Ask each registered resolver in turn and return the first identity found.
   * Best-effort: a resolver that throws is skipped. `null` means no resolver
   * could map the slot to a spool.
   */
  async resolve(query: SlotFilamentQuery): Promise<SlotFilamentIdentity | null> {
    for (const resolver of this.resolvers) {
      try {
        const result = await resolver(query)
        if (result) return result
      } catch (error) {
        // Best-effort: a failing resolver must not break the consumer, but log it — a silent
        // failure here shows up downstream as a run/print with no spool for no visible reason.
        console.warn('[slot-filament] a resolver threw; falling back', error instanceof Error ? error.message : error)
      }
    }
    return null
  }

  size(): number {
    return this.resolvers.size
  }
}

export const slotFilamentResolvers = new SlotFilamentResolverRegistry()
