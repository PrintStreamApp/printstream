/**
 * Which printer preset a project's printer-setting changes belong to, and whether they apply now.
 *
 * Owns one rule, taken from Bambu Studio: printer-setting changes never transfer to another printer
 * preset. Studio's `Tab::select_preset` sets `no_transfer` for the printer tab, so switching
 * printers offers only Discard or Save, never Transfer, and that holds for a nozzle-size switch on
 * the same model as much as for a model change. Carrying them here once sent a P1P start G-code
 * into an X2D slice; it never selected a hotend, and the print ran on the wrong nozzle.
 *
 * The changes are HELD against the preset they were made for rather than deleted, so the rule
 * costs nothing reversible: on any other preset they apply as `{}` (slice, save, badge and dialog
 * all see none), and switching back or undoing the switch makes them apply again. The same
 * intent-not-erasure model the machine target uses for picks it cannot represent.
 *
 * Pure; the state lives in `useMachineSettingOverrides`. Counterpart on the server:
 * `readMachineSettingOverrides`'s `presetName` scoping, which answers a project's record only for
 * its own preset.
 */

export type MachineSettingOverrideMap = Record<string, string | string[]>

/** Printer-setting changes, plus the preset they were made for. */
export interface HeldMachineSettingOverrides {
  overrides: MachineSettingOverrideMap
  /**
   * The printer preset id the changes were made against. Null means unscoped, which only an empty
   * map or a snapshot from before scoping existed can be: both apply to whatever is selected.
   */
  presetId: string | null
  /** That preset's display name, for the set-aside notice. */
  presetName: string | null
}

export const EMPTY_HELD_MACHINE_SETTING_OVERRIDES: HeldMachineSettingOverrides = {
  overrides: {},
  presetId: null,
  presetName: null
}

/** Whether held changes apply to the printer preset currently selected. */
export function machineOverridesApplyTo(held: HeldMachineSettingOverrides, printerProfileId: string): boolean {
  return held.presetId === null || held.presetId === printerProfileId
}

/** The changes in force for the selected preset: the held map on its own preset, otherwise none. */
export function effectiveMachineSettingOverrides(
  held: HeldMachineSettingOverrides,
  printerProfileId: string
): MachineSettingOverrideMap {
  return machineOverridesApplyTo(held, printerProfileId) ? held.overrides : {}
}

/**
 * The changes held for a DIFFERENT preset, for the notice that says they are not applied. Null when
 * nothing is set aside.
 */
export function setAsideMachineSettingOverrides(
  held: HeldMachineSettingOverrides,
  printerProfileId: string
): { keyCount: number; presetName: string | null } | null {
  if (machineOverridesApplyTo(held, printerProfileId)) return null
  const keyCount = Object.keys(held.overrides).length
  return keyCount > 0 ? { keyCount, presetName: held.presetName } : null
}
