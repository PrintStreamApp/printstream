/**
 * Browser policy for operating-system post-processing commands embedded in project settings.
 *
 * BambuStudio desktop can ask the local user before running these commands. A hosted slicer has no
 * equivalent safe consent because the command would run as the server, not as that user. Prepared
 * browser slices therefore warn first and then clear only `post_process`; printer G-code remains.
 */

/** Whether project settings request at least one non-empty host post-processing command. */
export function hasPostProcessingScripts(projectSettingsJson: string | null): boolean {
  if (!projectSettingsJson) return false
  try {
    const parsed = JSON.parse(projectSettingsJson) as { post_process?: unknown }
    return hasPostProcessingValue(parsed.post_process)
  } catch {
    return false
  }
}

/** Whether one serialized setting value names at least one command. */
export function hasPostProcessingValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0
  return Array.isArray(value) && value.some((entry) => typeof entry === 'string' && entry.trim().length > 0)
}

/** Clear host scripts while preserving every setting interpreted as printer G-code. */
export function removePostProcessingScripts(projectSettingsJson: string): string {
  const parsed = JSON.parse(projectSettingsJson) as Record<string, unknown>
  parsed.post_process = []
  return JSON.stringify(parsed)
}
