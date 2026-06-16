/**
 * Print-guard registry.
 *
 * A plugin can register a function that vets every print attempt for a
 * given printer. The dispatcher and the re-print route consult every
 * registered guard before they let a job through; if any guard returns
 * `false` (or an `{ allowed: false, reason }` object), the request is
 * rejected with HTTP 409 and the reason bubbles up to the UI.
 *
 * Guards must be cheap and synchronous; they run on every print
 * dispatch and reprint. They are intentionally not part of the plugin
 * lifecycle (no install/uninstall plumbing) — a plugin opts out of
 * guarding by removing its guard function via the unsubscribe handle
 * during shutdown. Built-in core code never touches this module.
 */

export interface PrintGuardDecision {
  allowed: boolean
  /** Reason shown to the user when `allowed === false`. */
  reason?: string
}

export interface PrintGuardContext {
  printerId: string
  /** `'dispatch'` for new uploads, `'reprint'` for SD-card reprints, `'calibration'` for calibration routines. */
  source: 'dispatch' | 'reprint' | 'calibration'
}

export type PrintGuard = (context: PrintGuardContext) => PrintGuardDecision | boolean

class PrintGuardRegistry {
  private readonly guards = new Set<PrintGuard>()

  register(guard: PrintGuard): () => void {
    this.guards.add(guard)
    return () => this.guards.delete(guard)
  }

  /**
   * Evaluate every registered guard. Returns the first denial (so the
   * UI surfaces a single, deterministic reason) or `null` when every
   * guard allows the print.
   */
  evaluate(context: PrintGuardContext): PrintGuardDecision | null {
    for (const guard of this.guards) {
      const result = guard(context)
      const decision: PrintGuardDecision = typeof result === 'boolean'
        ? { allowed: result }
        : result
      if (!decision.allowed) {
        return { allowed: false, reason: decision.reason ?? 'Print blocked by a plugin' }
      }
    }
    return null
  }

  size(): number {
    return this.guards.size
  }
}

export const printGuards = new PrintGuardRegistry()
