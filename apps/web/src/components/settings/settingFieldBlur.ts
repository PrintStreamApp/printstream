/**
 * What a settings field should do when focus leaves it while the box is empty.
 *
 * OWNS one decision, kept out of the component so it can be reasoned about and tested directly: an
 * empty NUMERIC value must not stand as a pending change, because it never reaches the file.
 * `settings-value-guard.ts` refuses it at the write boundary (BambuStudio's scalar deserialiser
 * fails on `""`, `set_deserialize` throws, and the throw abandons every key the loader had not yet
 * applied), so a blank box showed a modified-value badge for an edit that was going to be dropped.
 * Reverting is the honest answer, and it matches what the value already is on disk.
 *
 * A TEXT option is deliberately excluded: `ConfigOptionString` accepts an empty value and clearing
 * a custom gcode field is a real edit, so reverting there would refuse something legitimate.
 *
 * This fires on BLUR only. Clearing the box mid-edit has to keep working, or the field cannot be
 * retyped.
 */

/**
 * The value to restore, or null to leave the field as the user left it.
 *
 * `editStartValue` is the value as it stood when the field took focus, NOT the most recent non-empty
 * value. That distinction is the whole correctness of this: every keystroke round-trips through the
 * parent, so a "last non-empty" ref advances to each intermediate, and clearing a box after typing
 * and reconsidering would commit the abandoned intermediate rather than restoring what was there.
 * Null when the field was already empty on focus, in which case there is nothing to restore.
 */
export function settingFieldBlurRestore(
  value: string,
  editStartValue: string | null | undefined,
  isNumeric: boolean
): string | null {
  if (!isNumeric) return null
  if (value.trim() !== '') return null
  if (editStartValue == null || editStartValue.trim() === '') return null
  return editStartValue
}
