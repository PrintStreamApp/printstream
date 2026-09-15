/**
 * Classify one model-picker selection into its primary model and optional sidecars.
 *
 * A browser picker returns one flat `FileList`, while OBJ uses a primary `.obj` plus one or more
 * `.mtl` and texture resources. This keeps every editor entry point on one rule: exactly one
 * supported model, only recognized OBJ companions, and companions only for OBJ.
 */
import { detectImportFormat, type StagedImportFormat } from '@printstream/shared'

export interface ImportFileSelection {
  file: File
  companionFiles: File[]
}

/** Split and validate files selected through the editor's shared model picker. */
export function resolveImportFileSelection(
  files: FileList | readonly File[],
  importableFormats: readonly StagedImportFormat[]
): ImportFileSelection {
  const selected = Array.from(files)
  const models = selected.filter((file) => {
    const format = detectImportFormat(file.name)
    return format != null && importableFormats.includes(format)
  })
  if (models.length === 0) throw new Error('Select one supported model file, optionally with its OBJ material and texture files.')
  if (models.length > 1) throw new Error('Select only one model file at a time.')

  const file = models[0]!
  const companionFiles = selected.filter((entry) => entry !== file)
  if (companionFiles.some((entry) => !/\.(mtl|png|jpe?g)$/i.test(entry.name))) {
    throw new Error('Only MTL, PNG, and JPEG files can be selected beside a model.')
  }
  if (companionFiles.length > 0 && detectImportFormat(file.name) !== 'obj') {
    throw new Error('Material and texture files can only accompany an OBJ model.')
  }
  return { file, companionFiles }
}
