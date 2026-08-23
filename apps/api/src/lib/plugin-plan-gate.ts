/**
 * Plan gating for plugins. A deployment-specific module (the cloud's billing
 * module) may register one gate that blocks named plugins for workspaces whose
 * plan doesn't include them; the plugin host consults it when serving the
 * catalog and when guarding plugin HTTP routes. Self-hosted/OSS builds register
 * nothing, so every plugin stays available, exactly like the printer-quota
 * registry this mirrors.
 *
 * Lookups fail open (with a warning): a transient error in the gate must never
 * take working plugins away from paying workspaces.
 */

export interface PluginPlanGate {
  /** Names this gate may ever block: lets the host skip lookups for everything else. */
  gatedPlugins: ReadonlySet<string>
  /** The subset of `gatedPlugins` the workspace may NOT use right now. */
  blockedPluginsForWorkspace(workspaceId: string): Promise<ReadonlySet<string>>
}

const EMPTY: ReadonlySet<string> = new Set()

let gate: PluginPlanGate | null = null

/** Register the deployment's gate (pass null to clear: tests only). */
export function registerPluginPlanGate(next: PluginPlanGate | null): void {
  gate = next
}

/** Names the registered gate may block (empty when no gate is registered). */
export function planGatedPluginNames(): ReadonlySet<string> {
  return gate?.gatedPlugins ?? EMPTY
}

/** Plugins the workspace may not use under its current plan (empty when ungated). */
export async function blockedPluginsForWorkspace(workspaceId: string): Promise<ReadonlySet<string>> {
  if (!gate) return EMPTY
  try {
    return await gate.blockedPluginsForWorkspace(workspaceId)
  } catch (error) {
    console.warn('[plugin-plan-gate] lookup failed; failing open', { workspaceId, error })
    return EMPTY
  }
}
