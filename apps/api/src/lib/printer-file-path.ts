/**
 * Normalize printer-reported active file paths.
 *
 * Some printers only expose a generated Metadata/plate_N.gcode path, which is
 * useful as a plate hint but does not identify the backing archive reliably.
 * These helpers preserve only exact printer-side file paths when available.
 */

export function isMetadataPlateGcodePath(filePath: string | null | undefined): boolean {
  return typeof filePath === 'string' && /(?:^|\/)Metadata\/plate_\d+\.gcode$/i.test(filePath)
}

export function normalizeExactPrinterFilePath(filePath: string | null | undefined): string | null {
  if (typeof filePath !== 'string') return null

  const trimmed = filePath.trim()
    .replace(/^file:\/\//i, '')
    .replace(/^\/+sdcard\//i, '')
  if (!trimmed) return null
  if (isMetadataPlateGcodePath(trimmed)) return null
  if (!/\.(3mf|gcode)$/i.test(trimmed)) return null

  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

export function choosePreferredExactPrinterFilePath(
  primary: string | null | undefined,
  fallback: string | null | undefined
): string | null {
  return normalizeExactPrinterFilePath(primary) ?? normalizeExactPrinterFilePath(fallback)
}