/**
 * Helpers for normalizing Bambu tray color fields from MQTT payloads.
 *
 * The printer reports a primary `tray_color` plus, for multi-color spools,
 * an optional `cols[]` palette. Both use Bambu's `RRGGBBAA` format.
 */

/**
 * Normalize a Bambu tray color to `#RRGGBB`.
 *
 * An all-zero value (including transparent `AA=00`) means "no color set"
 * and is treated as `null` so the UI does not render phantom black/clear
 * swatches for empty trays.
 */
export function parseTrayColor(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const hex = value.trim()
  if (!/^[0-9a-fA-F]{6,8}$/.test(hex)) return null
  if (/^0+$/.test(hex)) return null
  if (hex.length === 8 && hex.slice(6, 8).toUpperCase() === '00') return null
  return `#${hex.slice(0, 6).toUpperCase()}`
}

/**
 * Normalize a multi-color palette reported in `cols[]`.
 *
 * Duplicate/invalid colors are dropped while preserving order. When the
 * palette is absent, callers can pass the normalized primary tray color as a
 * fallback to keep single-color spools represented as a one-item array.
 */
export function parseTrayColors(value: unknown, fallbackColor: string | null = null): string[] {
  const normalized = Array.isArray(value)
    ? value
      .map((entry) => parseTrayColor(entry))
      .filter((entry): entry is string => entry != null)
    : []

  const unique = normalized.filter((entry, index) => normalized.indexOf(entry) === index)
  if (unique.length > 0) return unique
  return fallbackColor ? [fallbackColor] : []
}