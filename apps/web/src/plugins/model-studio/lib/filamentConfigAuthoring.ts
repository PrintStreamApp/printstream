/**
 * Resolves each saved filament slot's preset config IN THE BROWSER and attaches it to the
 * `SceneEdit`, so the bake can author the material's own physics into the project.
 *
 * WHY: a material change used to drop every non-identity filament array (temperatures, flow,
 * cooling, retraction) and rely on the slicer re-deriving them from `filament_settings_id` at slice
 * time. That holds for our slicer and fails for BambuStudio, which opens a project whose slots have
 * no values, has nothing to name a preset after, and shows the slot as an unnamed
 * `(<project>.3mf)` preset carrying bare defaults. PROVEN against a real affected file: restoring
 * exactly these keys made BambuStudio show every material correctly.
 *
 * WHY IN THE BROWSER: the model studio is our own BambuStudio GUI, so it authors what it saves.
 * Both hosts already own a `FilamentConfigResolver` for the material tune dialog and the
 * changed-vs-preset badge (the workspace `/api/slicing/profiles/resolve-filament` route, and
 * `localFilamentResolver` for the public editor), so this needs no new endpoint and no server round
 * trip the editor was not already making.
 *
 * CONTRACT: resolution is best-effort and additive. A slot whose preset cannot be resolved is left
 * without a config, and the final save guard refuses incomplete named materials. A resolver that
 * throws is logged and treated as unresolved so a complete source can still save unchanged.
 *
 * Counterpart: `applyFilamentList` in `@printstream/shared/three-mf` consumes
 * `SceneEditFilament.config`.
 */
import { FILAMENT_SETTING_KEYS, isFilamentIdentitySettingKey, isProjectSlicingPresetId, type ProcessConfig, type ResolveFilamentConfigResponse, type SceneEdit } from '@printstream/shared'
import type { FilamentConfigResolver } from '../../../components/library/FilamentSettingsDialog'

/**
 * Whether a resolved config actually carries a material's PHYSICS, as opposed to merely existing.
 *
 * A config OBJECT is not a config with VALUES, and the difference is the whole bug this guards. A
 * slot whose preset resolves to the PROJECT's own embedded preset comes back describing the
 * project's slot -- so for a project that never had physics (a new project's scaffold, or one an
 * older save stripped) it is truthy and empty, and authoring it writes nothing while reporting
 * success. Identity keys are excluded because a slot always has those; they say nothing about
 * whether the material's temperatures, flow, cooling and retraction are present.
 *
 * The same test already guards the in-session "missing material settings" repair
 * (`handleRepairFilamentPhysics`); this is the SAVE path finally applying it too.
 */
function carriesFilamentPhysics(config: ProcessConfig | undefined): boolean {
  if (!config) return false
  return Object.keys(config).some((key) => FILAMENT_SETTING_KEYS.has(key) && !isFilamentIdentitySettingKey(key))
}

/**
 * Combine a project's declared values with its named installed preset. A damaged project can still
 * carry some physics (diameter and density in the reported file) while missing temperature and flow;
 * accepting any one surviving key as a complete config saves the defect again. Explicit project
 * values win so authored tweaks survive, while the baseline fills every absent preset option.
 */
export function filamentPhysicsFromResolution(response: ResolveFilamentConfigResponse): ProcessConfig | null {
  const baseline = carriesFilamentPhysics(response.baseConfig) ? response.baseConfig : null
  if (baseline) {
    const declared = Object.fromEntries(Object.entries(response.config ?? {}).filter(([, value]) =>
      !Array.isArray(value) || value.length > 0
    ))
    return { ...baseline, ...declared }
  }
  return carriesFilamentPhysics(response.config) ? response.config! : null
}

/** Source 3MF slot to read, independent of the slot's position after a reorder. */
export function sourceFilamentSlotId(sourceIndex: number | null | undefined, fallbackId: number): number {
  return sourceIndex == null ? fallbackId : sourceIndex + 1
}

export interface FilamentConfigAuthoringContext {
  /** The slice target the presets are resolved against; null on a host with no printer selected. */
  targetId: string | null
  /** The library file the project came from, for a project-scoped preset. Null for a local file. */
  sourceFileId: string | null
  /**
   * Preset id per BAKED slot (1..N by desired-list position), for the slots the user has resolved.
   * Controller records are keyed by SESSION `projectFilamentId`, which drifts from position after a
   * mid-session remove or reorder: convert them with {@link rekeyByBakedSlot} before passing.
   */
  profileIdByFilamentId: Record<number, string | undefined>
  /** Cancels in-flight preset lookups when the enclosing save or slice is dismissed. */
  signal?: AbortSignal
}

/**
 * Re-key a session-id-keyed per-material record into the baked slot space (1..N by list position).
 *
 * The slice controller keys per-material state by session `projectFilamentId`, which equals the
 * baked slot number only while the session list still matches the file. After a mid-session remove
 * or reorder the two diverge until the save renumbers, and reading a session-keyed record by
 * position hands one slot another slot's data. Callers convert at this boundary, against the
 * CURRENT ordered slot list, so the authoring functions below can trust their keys to be baked
 * slots. Entries whose session id no longer appears in the list (a removed slot) are dropped.
 */
export function rekeyByBakedSlot<T>(
  record: Record<number, T> | undefined,
  orderedSessionIds: number[]
): Record<number, T> {
  if (!record) return {}
  const rekeyed: Record<number, T> = {}
  orderedSessionIds.forEach((sessionId, index) => {
    if (sessionId in record) rekeyed[index + 1] = record[sessionId] as T
  })
  return rekeyed
}

/**
 * One slot's preset as the repair resolved it: the values, plus what BambuStudio needs to BIND them.
 *
 * The binding travels with the config rather than being re-derived at save time for the same reason
 * the config itself is pinned, it is what the user accepted, and the catalogue can move underneath.
 */
export interface RepairedFilamentPreset {
  config: ProcessConfig
  /** The preset's parent (`inherits`). Undefined when it did not resolve; null means "system". */
  inherits?: string | null
  /** Keys the preset changes versus that parent. Meaningless without `inherits`. */
  changedKeys?: string[]
}

/**
 * Attach configs the user's in-session repair already resolved, before any re-resolving.
 *
 * The "missing material settings" repair is an undoable EDIT: it resolves every slot up front and
 * pins the result in `EditorState.repairedFilamentConfigs`. Those pinned values are what the user
 * accepted (and what the banner cleared on), so the save must carry exactly them: re-resolving
 * could return something different if the catalogue moved underneath, and would silently save a
 * value nobody agreed to. Slots without a pin are left for {@link attachResolvedFilamentConfigs}.
 *
 * Returns the input unchanged when there is no pin, so callers can apply it unconditionally.
 */
export function applyRepairedFilamentConfigs(
  edit: SceneEdit,
  repaired: Record<number, RepairedFilamentPreset> | undefined
): SceneEdit {
  if (!repaired || !edit.filaments || edit.filaments.length === 0) return edit
  return {
    ...edit,
    filaments: edit.filaments.map((filament, index) => {
      // Keys are baked slots (1..N by position): the caller re-keyed its session-id record via
      // `rekeyByBakedSlot`, the same contract `attachResolvedFilamentConfigs` relies on below.
      const preset = repaired[index + 1]
      if (!preset) return filament
      return {
        ...filament,
        config: preset.config,
        // Left OFF when the parent did not resolve, so the bake leaves the project's existing
        // record alone rather than declaring a binding we cannot stand behind.
        ...(preset.inherits === undefined ? {} : { presetInherits: preset.inherits, presetChangedKeys: preset.changedKeys ?? [] })
      }
    })
  }
}

/**
 * Returns `edit` with `config` filled in on every filament slot whose preset resolves.
 *
 * Returns the input unchanged when there is nothing to do (no resolver, no filaments), so callers
 * can await it unconditionally. A slot that already carries a `config` (an in-session repair, see
 * {@link applyRepairedFilamentConfigs}) is left alone.
 */
export async function attachResolvedFilamentConfigs(
  edit: SceneEdit,
  resolve: FilamentConfigResolver | undefined,
  context: FilamentConfigAuthoringContext
): Promise<SceneEdit> {
  if (!resolve || !edit.filaments || edit.filaments.length === 0) return edit

  const resolved = await Promise.all(edit.filaments.map(async (filament, index) => {
    // The desired list bakes as slots 1..N, and the context keys on those baked slots: the
    // caller converted its session-id records via `rekeyByBakedSlot`, so a session that removed
    // or reordered materials still resolves each slot's own preset.
    const profileId = context.profileIdByFilamentId[index + 1]
    // Already carries the user's repaired config: do not overwrite it with a fresh resolve.
    if (filament.config) return filament
    // A project choice keeps the source slot's name (`settingsId: null`), but its project preset
    // can still supply physics from the source file or the installed preset it names.
    if (!profileId || (!filament.settingsId && !isProjectSlicingPresetId(profileId))) return filament
    try {
      const response = await resolve({
        filamentProfileId: profileId,
        targetId: context.targetId,
        sourceFileId: context.sourceFileId,
        projectFilamentId: sourceFilamentSlotId(filament.sourceIndex, index + 1)
      }, context.signal ? { signal: context.signal } : undefined)
      // The resolver can return a partial PROJECT config and a complete installed baseline. Keep
      // project values where declared, then fill missing preset options from that baseline.
      const effective = filamentPhysicsFromResolution(response)
      if (!effective) return filament
      return {
        ...filament,
        config: effective,
        // Same pair as the repair path: values alone do not bind a slot to a USER preset.
        ...(response.presetInherits === undefined
          ? {}
          : { presetInherits: response.presetInherits, presetChangedKeys: response.presetChangedKeys ?? [] })
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
      // Best-effort: a save must not fail because a preset could not be resolved.
      console.warn(`[filamentConfigAuthoring] slot ${index + 1} preset ${profileId} did not resolve: ${(error as Error).message}`)
      return filament
    }
  }))

  return { ...edit, filaments: resolved }
}
