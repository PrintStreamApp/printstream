/**
 * Owns insertion of new and staged instances into the active plate. The shared
 * placement helper enforces material and collision rules for every caller;
 * accepted source colours join the same undo frame as the imported geometry.
 */
import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { StagedImport } from '@printstream/shared'
import type * as THREE from 'three'
import type { SliceSettingsController } from '../../components/library/SliceSettingsPanel'
import { toast } from '../../lib/toast'
import { insertEditorInstance, type EditorInstanceFootprint } from './lib/editorInstanceInsertion'
import { addedPartHostId, instanceFromStagedImport, stagedFootprint, supportPaintKey,
  type EditorInstance, type EditorState } from './lib/editorModel'
import type { EditorImportStore } from './lib/editorImportStore'
import type { SourceColorPaintCommit } from './lib/editorGeometryReplacement'
import { triangleSoupToBinaryStl } from './lib/meshCut'
import { PRIMITIVE_LABELS, primitiveTriangleSoup, type PrimitiveKind } from './lib/primitives'

interface EditorInstanceInsertionOptions {
  activePlateIndex: number
  sliceConfigRef: MutableRefObject<SliceSettingsController | undefined>
  stateRef: MutableRefObject<EditorState | null>
  setState: Dispatch<SetStateAction<EditorState | null>>
  groupsRef: MutableRefObject<Map<string, THREE.Group>>
  updatePlates: Parameters<typeof insertEditorInstance>[0]['updatePlates']
  setSelectedKey: Dispatch<SetStateAction<string | null>>
  importStore: Pick<EditorImportStore, 'meshUrl' | 'stageFile'>
  setImporting: Dispatch<SetStateAction<boolean>>
}

/** Return the common insertion gate plus staged-model and built-in primitive actions. */
export function useEditorInstanceInsertion({
  activePlateIndex,
  sliceConfigRef,
  stateRef,
  setState,
  groupsRef,
  updatePlates,
  setSelectedKey,
  importStore,
  setImporting
}: EditorInstanceInsertionOptions) {
  const addInstanceToActivePlate = useCallback((
    instance: EditorInstance,
    footprint?: EditorInstanceFootprint,
    options: { recordHistory?: boolean } = {}
  ) => insertEditorInstance({
    instance,
    footprint,
    recordHistory: options.recordHistory,
    projectFilamentCount: sliceConfigRef.current?.projectFilaments?.length ?? 0,
    activePlateIndex,
    state: stateRef.current,
    groups: groupsRef.current,
    updatePlates,
    selectInstance: setSelectedKey
  }), [activePlateIndex, sliceConfigRef, stateRef, groupsRef, updatePlates, setSelectedKey])

  const addStagedImport = useCallback((
    staged: StagedImport,
    sourceColorPaint?: SourceColorPaintCommit,
    options: { recordHistory?: boolean } = {}
  ) => {
    // Foreign meshes keep file-local coordinates; the staged footprint lets placement centre
    // their visible bounds at a free bed spot instead of centring an arbitrary file origin.
    const instance = instanceFromStagedImport(staged, importStore.meshUrl)
    if (sourceColorPaint) instance.filamentId = sourceColorPaint.filamentId
    const added = addInstanceToActivePlate(instance, stagedFootprint(staged), options)
    if (!added) return false
    if (!sourceColorPaint || Object.keys(sourceColorPaint.colorPaint).length === 0) return true
    const hostId = addedPartHostId(instance)
    if (hostId == null) return true
    // No second checkpoint: accepting colour and geometry is one user import action.
    setState((current) => current ? {
      ...current,
      colorPaint: {
        ...(current.colorPaint ?? {}),
        [supportPaintKey(hostId, 0)]: sourceColorPaint.colorPaint
      }
    } : current)
    return true
  }, [addInstanceToActivePlate, importStore.meshUrl, setState])

  /** Stage a built-in solid and insert it through the same placement gate as a file import. */
  const addPrimitive = useCallback(async (kind: PrimitiveKind) => {
    if (!stateRef.current?.plates.some((plate) => plate.index === activePlateIndex)) return
    setImporting(true)
    try {
      const stl = triangleSoupToBinaryStl(primitiveTriangleSoup(kind))
      const file = new File([stl], `${PRIMITIVE_LABELS[kind]}.stl`, { type: 'application/octet-stream' })
      const staged = await importStore.stageFile(file, 'object')
      if (addStagedImport(staged)) toast.success(`Added a ${PRIMITIVE_LABELS[kind].toLowerCase()}.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to add the primitive.')
    } finally {
      setImporting(false)
    }
  }, [activePlateIndex, addStagedImport, importStore, setImporting, stateRef])

  return { addInstanceToActivePlate, addStagedImport, addPrimitive }
}
