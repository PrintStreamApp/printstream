/**
 * The project's printer-setting changes for both slice-settings hosts (`SliceFileModal`,
 * `useLocalSliceSettingsController`), scoped to the printer preset they were made for.
 *
 * Owns the held map and its preset; exposes only what applies to the CURRENT preset (see
 * `lib/machineSettingOverrideScope.ts` for the rule and why). Every consumer of
 * `machineSettingOverrides` (slice target, save, badge, settings dialog) therefore sees `{}` after a
 * printer switch, while the held map survives for switching back and for undo.
 *
 * Writes go through {@link MachineSettingOverridesState.setMachineSettingOverrides}, which applies
 * an updater to the map in force and re-stamps it with the current preset. An edit made on the new
 * printer therefore replaces the changes held for the old one, exactly as Bambu Studio's Discard
 * does; undo still restores them, because the snapshot carries the held map.
 */
import { useCallback, useMemo, useState } from 'react'
import {
  EMPTY_HELD_MACHINE_SETTING_OVERRIDES,
  effectiveMachineSettingOverrides,
  setAsideMachineSettingOverrides,
  type HeldMachineSettingOverrides,
  type MachineSettingOverrideMap
} from '../../lib/machineSettingOverrideScope'

/** The machine-override fields of `SliceConfigSnapshot`: the held map, so undo restores its scope. */
export interface MachineSettingOverridesSnapshot {
  /** Held changes, including ones set aside for another preset. */
  machineSettingOverrides: MachineSettingOverrideMap
  /** The preset they belong to; absent on a snapshot from before scoping (applies anywhere). */
  machineOverridesPresetId?: string | null
  machineOverridesPresetName?: string | null
}

export interface MachineSettingOverridesState {
  /** The changes in force for the selected printer preset. */
  machineSettingOverrides: MachineSettingOverrideMap
  setMachineSettingOverrides: React.Dispatch<React.SetStateAction<MachineSettingOverrideMap>>
  /**
   * Adopt the file's own changes, measured against `presetId` (the preset the lookup asked about).
   * Not an edit: callers seed without touching undo or the dirty flag.
   */
  seedMachineSettingOverrides: (overrides: MachineSettingOverrideMap, presetId: string, presetName: string | null) => void
  /** Whether anything at all is held, set-aside changes included (the seed's "already edited" test). */
  hasHeldMachineSettingOverrides: boolean
  /** Changes held for a different preset, for the panel's notice. Null when none. */
  machineOverridesSetAside: { keyCount: number; presetName: string | null } | null
  machineOverridesSnapshot: MachineSettingOverridesSnapshot
  restoreMachineOverridesSnapshot: (snapshot: Partial<MachineSettingOverridesSnapshot>) => void
}

/**
 * @param printerProfileId the printer preset currently selected (the machine target's resolution)
 * @param printerProfileName its display name, stamped beside a write so the notice can name it later
 */
export function useMachineSettingOverrides(
  printerProfileId: string,
  printerProfileName: string | null
): MachineSettingOverridesState {
  const [held, setHeld] = useState<HeldMachineSettingOverrides>(EMPTY_HELD_MACHINE_SETTING_OVERRIDES)

  const machineSettingOverrides = useMemo(
    () => effectiveMachineSettingOverrides(held, printerProfileId),
    [held, printerProfileId]
  )

  const setMachineSettingOverrides = useCallback((action: React.SetStateAction<MachineSettingOverrideMap>) => {
    setHeld((previous) => {
      // The updater sees what is in force here, never a map held for another printer, or merging
      // one key in would resurrect the whole set-aside map under the new preset.
      const current = effectiveMachineSettingOverrides(previous, printerProfileId)
      const next = typeof action === 'function' ? action(current) : action
      return { overrides: next, presetId: printerProfileId, presetName: printerProfileName }
    })
  }, [printerProfileId, printerProfileName])

  const seedMachineSettingOverrides = useCallback((overrides: MachineSettingOverrideMap, presetId: string, presetName: string | null) => {
    setHeld({ overrides, presetId, presetName })
  }, [])

  const machineOverridesSetAside = useMemo(
    () => setAsideMachineSettingOverrides(held, printerProfileId),
    [held, printerProfileId]
  )

  const machineOverridesSnapshot = useMemo<MachineSettingOverridesSnapshot>(() => ({
    machineSettingOverrides: held.overrides,
    machineOverridesPresetId: held.presetId,
    machineOverridesPresetName: held.presetName
  }), [held])

  const restoreMachineOverridesSnapshot = useCallback((snapshot: Partial<MachineSettingOverridesSnapshot>) => {
    setHeld({
      overrides: snapshot.machineSettingOverrides ?? {},
      presetId: snapshot.machineOverridesPresetId ?? null,
      presetName: snapshot.machineOverridesPresetName ?? null
    })
  }, [])

  return {
    machineSettingOverrides,
    setMachineSettingOverrides,
    seedMachineSettingOverrides,
    hasHeldMachineSettingOverrides: Object.keys(held.overrides).length > 0,
    machineOverridesSetAside,
    machineOverridesSnapshot,
    restoreMachineOverridesSnapshot
  }
}
