/**
 * Reads an SVG's source from the live editor session or the opened project archive.
 * Artwork added since opening the project has no archive entry until save.
 */
import type { EditorState } from './editorModel'
import type { EditorProjectSource } from './editorProjectSource'

/** Prefer unsaved session bytes and report a missing saved entry as an artwork error. */
export async function readEditorSvgSource(
  entryPath: string,
  state: EditorState | null,
  loadEntry: EditorProjectSource['loadEntry']
): Promise<string> {
  const sessionMarkup = state?.svgSources?.[entryPath]
  if (sessionMarkup !== undefined) return sessionMarkup

  const bytes = await loadEntry(entryPath).catch(() => {
    // The archive loader's generic missing-mesh message does not name the missing artwork.
    throw new Error(`The artwork ${entryPath} is not in this project any more.`)
  })
  return new TextDecoder().decode(bytes)
}
