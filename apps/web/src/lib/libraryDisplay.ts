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
const HIDDEN_EXTENSIONS = ['.gcode.3mf']

export function formatLibraryFileName(name: string): string {
  const lower = name.toLowerCase()
  for (const ext of HIDDEN_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      return name.slice(0, name.length - ext.length)
    }
  }
  const lastDotIndex = name.lastIndexOf('.')
  return lastDotIndex > 0 ? name.slice(0, lastDotIndex) : name
}

export function splitLibraryFileNameForRename(name: string): { baseName: string; extension: string } {
  const lower = name.toLowerCase()
  for (const ext of HIDDEN_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      return {
        baseName: name.slice(0, name.length - ext.length),
        extension: name.slice(name.length - ext.length)
      }
    }
  }

  const lastDotIndex = name.lastIndexOf('.')
  if (lastDotIndex > 0) {
    return {
      baseName: name.slice(0, lastDotIndex),
      extension: name.slice(lastDotIndex)
    }
  }

  return { baseName: name, extension: '' }
}

export function formatLibraryFileKindLabel(name: string, kind: '3mf' | 'gcode' | 'stl' | 'other'): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.gcode.3mf')) return '3MF GCODE'
  if (kind === '3mf') return '3MF'
  if (kind === 'gcode') return 'GCODE'
  if (kind === 'stl') return 'STL'
  return 'OTHER'
}
