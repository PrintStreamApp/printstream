/**
 * Classify model-picker selections into models and optional OBJ sidecars.
 *
 * A browser picker returns one flat `FileList`, while OBJ uses a primary `.obj` plus one or more
 * `.mtl` and texture resources. Add-model accepts a batch; replace and add-part still require
 * exactly one model. OBJ parsers resolve their declared resources from the selected sidecar pool.
 */
import { detectImportFormat, type StagedImportFormat } from '@printstream/shared'

export interface ImportFileSelection {
  file: File
  companionFiles: File[]
}

/** Validate the whole pick before staging, preserving model order and sharing sidecars only with OBJ. */
export function resolveImportFileSelections(
  files: FileList | readonly File[],
  importableFormats: readonly StagedImportFormat[]
): ImportFileSelection[] {
  const selected = Array.from(files)
  const models = selected.filter((file) => {
    const format = detectImportFormat(file.name)
    return format != null && importableFormats.includes(format)
  })
  if (models.length === 0) throw new Error('Select at least one supported model file, optionally with OBJ material and texture files.')
  const companionFiles = selected.filter((entry) => !models.includes(entry))
  if (companionFiles.some((entry) => !/\.(mtl|png|jpe?g)$/i.test(entry.name))) {
    throw new Error('Only MTL, PNG, and JPEG files can be selected beside a model.')
  }
  if (companionFiles.length > 0 && !models.some((file) => detectImportFormat(file.name) === 'obj')) {
    throw new Error('Material and texture files can only accompany an OBJ model.')
  }
  return models.map((file) => ({ file, companionFiles: detectImportFormat(file.name) === 'obj' ? companionFiles : [] }))
}

/** Replacement and part insertion address one target, so refuse a batch before staging anything. */
export function resolveImportFileSelection(
  files: FileList | readonly File[],
  importableFormats: readonly StagedImportFormat[]
): ImportFileSelection {
  const selections = resolveImportFileSelections(files, importableFormats)
  if (selections.length > 1) throw new Error('Select only one model file at a time.')
  return selections[0]!
}

/**
 * Snapshot the pick before resetting the input so selecting the same file fires again.
 * Browsers clear the existing FileList in place when value is reset; retaining that live list
 * silently loses the model and all companions before selection validation can run.
 */
export function takeSelectedImportFiles(input: Pick<HTMLInputElement, 'files' | 'value'>): File[] {
  const files = Array.from(input.files ?? [])
  input.value = ''
  return files
}
