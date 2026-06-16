/**
 * Canonical human-readable byte formatter shared by the API and the web app.
 * Uses base-1024 units (B, KB, MB, GB), shows whole bytes with no decimal,
 * and one decimal place for KB and above (dropped once the value reaches 10).
 * Non-finite or non-positive inputs collapse to `'0 B'`.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = value >= 10 || unit === 0 ? 0 : 1
  return `${value.toFixed(digits)} ${units[unit]}`
}
