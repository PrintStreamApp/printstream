/**
 * The session's purge volumes, re-applied once a machine step has fixed the extruder count. Shared
 * by the save passes (`clientBakeSettingsPasses.ts`) and the slice pass (`clientSliceSettingsPass.ts`).
 */
import type { SceneEdit } from '@printstream/shared'
import { THREE_MF_PROJECT_SETTINGS_ENTRY, applyFlushVolumes } from '@printstream/shared/three-mf'

/**
 * Re-apply the session's purge volumes to settings a machine step just retargeted.
 *
 * The scene bake writes them against the OPENED file's extruder count and drops a grid of another
 * shape, so a grid edited for the newly selected printer (2 blocks on an H2D, where the file was a
 * P1P's 1) never reached the save. Same shape rule, applied again after the topology is final; an
 * edit made before the switch still does not fit, and the retarget's own resized matrix stands.
 * Shared by the save passes and the slice pass.
 */
export function reapplyFlushVolumesAfterRetarget(output: Record<string, Uint8Array>, edit: SceneEdit): void {
  const entry = output[THREE_MF_PROJECT_SETTINGS_ENTRY]
  if (!edit.flushVolumes || !entry?.length) return
  const json = new TextDecoder().decode(entry)
  output[THREE_MF_PROJECT_SETTINGS_ENTRY] = new TextEncoder().encode(applyFlushVolumes(json, edit.flushVolumes))
}
