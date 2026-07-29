/**
 * Plate naming for the 3MF editor.
 *
 * Owns the one rule the plate strip and the rename prompt have to agree on: a plate with no
 * stored name still READS as "Plate N", so that is the text the user believes the plate is
 * called — and therefore the text the rename dialog must hand them, pre-selected, rather than
 * an empty field with a placeholder. Keeping the strip's label and the prompt's starting value
 * in one place is what stops the two drifting apart again.
 *
 * The counterpart surfaces are `editorPanels.tsx` (the strip) and `EditorView`'s
 * `handleRenamePlate`.
 */

/** Label an unnamed plate carries in the UI. `index` is the 1-based plate number. */
export function defaultPlateName(index: number): string {
  return `Plate ${index}`
}

/** Text to show for a plate, falling back to the default label when it has no name of its own. */
export function plateDisplayName(name: string | null | undefined, index: number): string {
  return name?.trim() || defaultPlateName(index)
}

/**
 * Resolve what a rename should store, `null` meaning UNNAMED. Blank input and the default label
 * both resolve to `null`: the rename dialog starts pre-filled with the default, so confirming it
 * untouched must leave the plate as it was instead of baking a name the user never chose into
 * the 3MF.
 */
export function resolvePlateRename(input: string, index: number): string | null {
  const trimmed = input.trim()
  if (!trimmed || trimmed === defaultPlateName(index)) return null
  return trimmed
}
