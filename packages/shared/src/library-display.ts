/**
 * Display formatting for library file names, shared so the API's job-history search can match
 * the SAME display text the web renders (a card shows "Benchy", so searching "benchy" must hit
 * even though the file is `Benchy.gcode.3mf`).
 *
 * File extensions are noise in the library UI because the file type is displayed as metadata
 * beside the name. Bambu Studio also exports sliced 3MFs as `<name>.gcode.3mf`, so that compound
 * extension is stripped as one suffix before falling back to ordinary extension stripping.
 *
 * The underlying file name on disk and the value sent to the printer are untouched; these
 * helpers only affect what a human sees. Always use the original `name` for download
 * attributes, rename forms, and any view that exposes the on-disk file (e.g. the printer
 * storage browser).
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

/** Split a file name into the editable base and the preserved extension for rename forms. */
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
