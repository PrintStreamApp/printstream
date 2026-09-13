/** Browser-held sliced 3MF input for the shared G-code preview. */
import type { ClientThreeMfProject } from './clientThreeMfProject'

export interface InMemoryGcodePreviewSource {
  fileName: string
  project: ClientThreeMfProject
}

/** Read one plate's G-code without routing the public editor's private artifact back to the API. */
export function readInMemoryPlateGcode(source: InMemoryGcodePreviewSource, plateIndex: number): string {
  const plate = source.project.index.plates.find((entry) => entry.index === plateIndex)
  const entryPath = plate?.gcodeFile
  const text = entryPath ? source.project.archive.entryText(entryPath) : null
  if (!text) throw new Error('This plate does not include previewable G-code.')
  return text
}
