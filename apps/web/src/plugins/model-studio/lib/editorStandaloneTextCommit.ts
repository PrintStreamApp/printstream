/**
 * Owns the standalone Text tool's staged object create and replacement. Opening Text already
 * records the session's one history frame, so neither path records a second frame. The selected
 * object remains the editing target while each form change replaces its staged geometry.
 */
import type { Font } from 'opentype.js'
import type { TextFontFace } from './textFonts'
import type { TextToolValue } from './textToolValue'
import type { EditorImportStore } from './editorImportStore'
import {
  instanceFromStagedImport,
  replaceInstanceGeometry,
  stagedFootprint,
  type EditorInstance,
  type EditorPlate
} from './editorModel'
import { triangleSoupToBinaryStl } from './meshCut'
import { standaloneTextSoup, textInfoForTool } from './textAuthoring'

type TextImportStore = Pick<EditorImportStore, 'stageFile' | 'meshUrl'>

export interface StandaloneTextCommitOptions {
  plate: EditorPlate
  activePlateIndex: number
  editingObjectKey: string | null
  value: TextToolValue
  resolveFace: () => Promise<{ face: TextFontFace; font: Font } | null>
  importStore: TextImportStore
  footprintCenterFor: (key: string) => { x: number; y: number } | null
  setEditingObject: (key: string | null) => void
  selectObject: (key: string) => void
  previousSelectedKeyRef: { current: string | null }
  updatePlates: (
    updater: (plates: EditorPlate[]) => EditorPlate[],
    kind: 'structure',
    options: { recordHistory: false }
  ) => void
  addInstance: (
    instance: EditorInstance,
    footprint: ReturnType<typeof stagedFootprint>,
    options: { recordHistory: false }
  ) => boolean
}

/** Stage text once, then create or replace its selected standalone object in the same session. */
export async function commitStandaloneText(options: StandaloneTextCommitOptions): Promise<void> {
  const resolved = await options.resolveFace()
  if (!resolved) return
  const standing = standaloneTextSoup(resolved.font, options.value)
  if (standing.length === 0) return

  const textInfo = textInfoForTool(options.value, resolved.face, { standalone: true })
  const name = options.value.text.slice(0, 40) || 'Text'
  const staged = await options.importStore.stageFile(
    new File([triangleSoupToBinaryStl(standing)], `${name}.stl`, { type: 'application/octet-stream' }),
    'object'
  )
  const existing = options.editingObjectKey
    ? options.plate.instances.find((entry) => entry.key === options.editingObjectKey)
    : null
  if (existing) {
    const replacement = replaceInstanceGeometry(
      existing,
      staged,
      undefined,
      options.importStore.meshUrl,
      options.footprintCenterFor(existing.key)
    )
    replacement.textInfo = textInfo
    if (!existing.nameOverridden) replacement.name = name
    replacement.nameOverridden = existing.nameOverridden

    options.setEditingObject(replacement.key)
    // Keeping the replacement selected prevents an edit from looking like a deselection and
    // closing the text tool between keystrokes.
    options.selectObject(replacement.key)
    options.previousSelectedKeyRef.current = replacement.key
    options.updatePlates((plates) => plates.map((plate) => plate.index !== options.activePlateIndex
      ? plate
      : { ...plate, instances: plate.instances.map((item) => item.key === existing.key ? replacement : item) }
    ), 'structure', { recordHistory: false })
    return
  }

  const created = instanceFromStagedImport(staged, options.importStore.meshUrl)
  created.textInfo = textInfo
  options.setEditingObject(created.key)
  // The Text mode opened the only history frame; the shared add path defaults to another.
  if (!options.addInstance(created, stagedFootprint(staged), { recordHistory: false })) {
    options.setEditingObject(null)
  }
}
