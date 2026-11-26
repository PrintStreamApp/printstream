/** Naming policy shared by server imports and native capture's product-page handoff. */
import { splitLibraryFileNameForRename } from './library-display.js'

/**
 * Apply an editable base name while preserving the downloaded file's real extension,
 * including .gcode.3mf. Omission keeps the provider name; invalid choices throw before saving.
 */
export function buildModelImportFileName(originalName: string, outputFileName?: string): string {
  if (outputFileName === undefined) return originalName
  const { extension } = splitLibraryFileNameForRename(originalName)
  let baseName = outputFileName.trim()
  if (extension && baseName.toLowerCase().endsWith(extension.toLowerCase())) {
    baseName = baseName.slice(0, -extension.length).trim()
  }
  const fileName = `${baseName}${extension}`
  const invalidCharacter = Array.from(baseName).some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127 || character === '/' || character === '\\'
  })
  if (!baseName || baseName === '.' || baseName === '..' || fileName.length > 255
    || invalidCharacter) {
    throw new Error('Choose a valid file name of at most 255 characters, without slashes or control characters.')
  }
  return fileName
}
