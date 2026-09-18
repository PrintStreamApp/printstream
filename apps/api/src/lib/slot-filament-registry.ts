/**
 * Slot-filament resolver registry.
 *
 * A plugin that owns filament/spool inventory (today: `filament-manager`) can
 * register a resolver that answers "which spool is loaded in this AMS slot, and
 * what is its identity?". Other plugins that need that association: e.g.
 * `calibration`, to tie a run to the loaded spool and reuse its saved value:
 * consult the registry through this shared core seam instead of importing the
 * owning plugin or reaching into its tables.
 *
 * Core manual slot identity takes precedence. Otherwise the registry is best-effort:
 * with no resolver registered (the
 * owning plugin absent or disabled for the workspace) `resolve` returns `null` and
 * consumers fall back to whatever they can observe on their own. A resolver that
 * throws is treated as "no answer" so one plugin's failure never breaks another.
 */

import { manualSlotMaterial } from './slot-materials.js'

/** Identity of the filament/spool loaded in a slot. Any field may be null when unknown. */
export interface SlotFilamentIdentity {
  /** The owning plugin's spool record id, if the slot maps to a tracked spool. */
  spoolId: string | null
  brand: string | null
  filamentType: string | null
  materialSubtype: string | null
  colorName: string | null
  /**
   * Grams the owning plugin believes are left on the spool, if it tracks a figure.
   *
   * Carried here because the browser grades low-filament warnings with this number
   * and `knownRemainGrams` REPLACES the printer's percent estimate with it rather
   * than taking the lower of the two. A server-side guard that cannot read it
   * therefore grades a DIFFERENT and sometimes stricter number than the dialog did,
   * and refuses prints the user was shown no warning for.
   */
  remainingGrams: number | null
}

export interface SlotFilamentQuery {
  workspaceId: string
  printerId: string
  amsId: number
  /**
   * Null for an external spool, which has an `amsId` but no slot. The owning
   * plugin stores it that way too (`loadedSlotId` is nullable), so narrowing this
   * to a number would silently drop every external spool from the answer.
   */
  slotId: number | null
}

/** Returns the loaded spool's identity for a slot, or `null` if none is tracked. */
export type SlotFilamentResolver = (query: SlotFilamentQuery) => Promise<SlotFilamentIdentity | null>

class SlotFilamentResolverRegistry {
  private readonly resolvers = new Set<SlotFilamentResolver>()
  private readonly releases = new Set<(query: SlotFilamentQuery) => Promise<void>>()

  register(resolver: SlotFilamentResolver, release?: (query: SlotFilamentQuery) => Promise<void>): () => void {
    this.resolvers.add(resolver)
    if (release) this.releases.add(release)
    return () => {
      this.resolvers.delete(resolver)
      if (release) this.releases.delete(release)
    }
  }

  /**
   * Ask each registered resolver in turn and return the first identity found.
   * Best-effort: a resolver that throws is skipped. `null` means no resolver
   * could map the slot to a spool.
   */
  async resolve(query: SlotFilamentQuery): Promise<SlotFilamentIdentity | null> {
    const manual = manualSlotMaterial(query)
    if (manual) return { ...manual, spoolId: null, remainingGrams: null }
    return this.resolveInventory(query)
  }

  /** Read only inventory when a command clears manual identity. Validation can fail closed on lookup errors. */
  async resolveInventory(query: SlotFilamentQuery, failOnError = false): Promise<SlotFilamentIdentity | null> {
    for (const resolver of this.resolvers) {
      try {
        const result = await resolver(query)
        if (result) return result
      } catch (error) {
        // Display/calibration lookups may fall back, but command validation must not lose
        // a known physical type just because its inventory provider is temporarily unavailable.
        console.warn('[slot-filament] a resolver threw', error instanceof Error ? error.message : error)
        if (failOnError) throw error
      }
    }
    return null
  }

  /** Release tracked inventory before assigning an independent manual identity; failures abort the save. */
  async release(query: SlotFilamentQuery): Promise<void> {
    for (const release of this.releases) await release(query)
  }

  size(): number {
    return this.resolvers.size
  }
}

export const slotFilamentResolvers = new SlotFilamentResolverRegistry()
