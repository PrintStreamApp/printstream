/**
 * Shared XML formatting used by the 3MF document writer and imported-object renderer.
 *
 * The numeric rounding and Production Extension UUID attribute are byte-level
 * output contracts, so every injected object and component uses these helpers.
 */

/**
 * ` p:UUID="…"` for an editor-injected node when the project uses the production extension, else `''`.
 * Any unique UUID satisfies the GUI; we mint fresh v4 UUIDs for injected nodes (the source's own
 * UUIDs are copied through untouched). v4 is deliberate: it never ends with BambuStudio's
 * `OBJECT_UUID_SUFFIX`, so it cannot trip BS's backup-restore path that reinterprets the UUID's hex
 * prefix as an object id.
 */
export const productionUuidAttr = (gen: (() => string) | null): string => (gen ? ` p:UUID="${gen()}"` : '')

/** Keep six decimal places for 3MF transforms, normalizing negative zero. */
export function formatThreeMfTransformValue(value: number): string {
  const rounded = Math.round(value * 1e6) / 1e6
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

/** A component with no authored local transform stays at its mesh's origin. */
export const IDENTITY_THREE_MF_TRANSFORM = '1 0 0 0 1 0 0 0 1 0 0 0'
