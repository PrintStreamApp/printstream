/**
 * Display formatting for library file names.
 *
 * File extensions are noise in the library UI because the file type is
 * displayed as metadata beside the name. Bambu Studio also exports sliced
 * 3MFs as `<name>.gcode.3mf`, so that compound extension is stripped as
 * one suffix before falling back to ordinary extension stripping.
 *
 * The underlying file name on disk and the value sent to the printer
 * are untouched; this helper only affects what a human sees. Always
 * use the original `name` for download attributes, rename forms, and
 * any view that exposes the on-disk file (e.g. the printer storage
 * browser).
 */
// The name formatters moved to @printstream/shared (`library-display.ts`) so the API's
// job-history search can match the same display text; re-exported here so the web's many
// import sites keep one path.
export { formatLibraryFileName, splitLibraryFileNameForRename } from '@printstream/shared'

export function formatLibraryFileKindLabel(name: string, kind: '3mf' | 'gcode' | 'stl' | 'step' | 'other'): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.gcode.3mf')) return '3MF GCODE'
  if (kind === '3mf') return '3MF'
  if (kind === 'gcode') return 'GCODE'
  if (kind === 'stl') return 'STL'
  if (kind === 'step') return 'STEP'
  return 'OTHER'
}
