/**
 * Widths shared by the parameter table grid and its dialog shell.
 *
 * The dialog must account for the grid's real default width, including each fixed column, so a
 * table that already fits does not show a tiny horizontal scrollbar on its first render.
 */
export const NAME_COLUMN_WIDTH = 260
export const PLATE_COLUMN_WIDTH = 96
export const SETTING_COLUMN_WIDTH = 150
export const ACTIONS_COLUMN_WIDTH = 64

/** The width needed for the fixed columns and `settingColumns` selected settings. */
export function parameterTableMinWidth(settingColumns: number): number {
  return NAME_COLUMN_WIDTH + PLATE_COLUMN_WIDTH + ACTIONS_COLUMN_WIDTH
    + settingColumns * SETTING_COLUMN_WIDTH
}
