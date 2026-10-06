/**
 * Builds the stable process-settings controls passed to the memoized Objects list.
 * It includes baked objects, staged imports, and independent-copy placeholders
 * so none of those need a save before editing process settings. A replaced
 * part-override map invalidates the badge callbacks even though they read a ref.
 */
import { useMemo, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { SliceSettingsController } from '../../components/library/SliceSettingsPanel'
import type { ObjectListPerObject } from './editorPanels'
import { partSlotKey, type EditorPlate, type EditorState } from './lib/editorModel'
import type { PartMember } from './lib/selectionModel'

interface EditorObjectListProcessSettingsOptions {
  perObject: SliceSettingsController['perObjectSettings']
  plateObjects: SliceSettingsController['plateObjects'] | undefined
  activePlate: EditorPlate | null
  state: EditorState | null
  stateRef: MutableRefObject<EditorState | null>
  setEditingObject: Dispatch<SetStateAction<{ ids: ReadonlyArray<number>; name: string } | null>>
  setEditingPart: Dispatch<SetStateAction<{
    objectId: number
    members: ReadonlyArray<PartMember>
    name: string
  } | null>>
}

/** Return one memoized sidebar controller, or undefined without process settings. */
export function useEditorObjectListProcessSettings({
  perObject,
  plateObjects,
  activePlate,
  state,
  stateRef,
  setEditingObject,
  setEditingPart
}: EditorObjectListProcessSettingsOptions): ObjectListPerObject | undefined {
  return useMemo(() => {
    if (!perObject) return undefined
    return {
      sliceObjectIds: new Set<number>([
        // A staged import and an independent copy can edit settings before the save gives them a baked id.
        ...(plateObjects ?? []).map((object) => object.id),
        ...(activePlate?.instances ?? []).flatMap((instance) =>
          instance.source.kind === 'import' && instance.source.replacedObjectId != null
            ? [instance.source.replacedObjectId]
            : []),
        ...Object.keys(state?.objectClones ?? {}).map(Number)
      ]),
      overrideCountFor: (objectId: number) => Object.keys(perObject.value[String(objectId)] ?? {}).length,
      onEditObject: (objectId: number, name: string) => setEditingObject({ ids: [objectId], name }),
      onEditPart: (objectId: number, partIndex: number, name: string) => {
        setEditingPart({ objectId, members: [{ kind: 'baked', partIndex }], name })
      },
      partOverrideCountFor: (objectId: number, partIndex: number) =>
        Object.keys(stateRef.current?.partProcessOverrides?.[partSlotKey(objectId, partIndex)] ?? {}).length
    }
    // This callback reads through a ref. Its object identity must still change when the
    // replacement map changes, or memoized rows keep stale override badges.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    perObject,
    plateObjects,
    activePlate?.instances,
    state?.objectClones,
    state?.partProcessOverrides,
    stateRef,
    setEditingObject,
    setEditingPart
  ])
}
