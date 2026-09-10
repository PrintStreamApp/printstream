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
import { IMPORT_FORMAT_LABELS, isMeshLibraryFileKind, type LibraryFile } from '@printstream/shared'

/**
 * The short kind chip on a library row.
 *
 * Takes `LibraryFile['kind']` rather than re-typing the union: the literal list here was a copy of
 * the schema's, which is exactly how a new kind comes to render as "OTHER" on a file the rest of
 * the app handles perfectly well. The mesh-format labels come from the shared catalogue for the
 * same reason -- one place decides that `gltf` is shown as "glTF".
 */
export function formatLibraryFileKindLabel(name: string, kind: LibraryFile['kind']): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.gcode.3mf')) return '3MF GCODE'
  if (kind === '3mf') return '3MF'
  if (kind === 'gcode') return 'GCODE'
  if (isMeshLibraryFileKind(kind)) return IMPORT_FORMAT_LABELS[kind]
  return 'OTHER'
}
