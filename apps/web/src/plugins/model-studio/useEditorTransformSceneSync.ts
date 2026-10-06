/**
 * Synchronizes transform-only edits with the mounted plate and its derived warnings/thumbnail.
 * Exact-matrix render groups fall back to an ordinary rebuild before any live group is mutated.
 */
import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import * as THREE from 'three'
import type { EditorState } from './lib/editorModel'
import { syncEditorTransformScene } from './lib/editorTransformSceneSync'

interface TransformSceneSyncOptions {
  transformSyncToken: number
  stateRef: MutableRefObject<EditorState | null>
  groupByKeyRef: MutableRefObject<Map<string, THREE.Group>>
  setRebuildToken: Dispatch<SetStateAction<number>>
  recomputeWarningsRef: MutableRefObject<() => void>
  regenerateActiveThumbnailRef: MutableRefObject<(() => void) | null>
}

/** Update the mounted plate or request a full rebuild after a transform-only edit. */
export function useEditorTransformSceneSync(options: TransformSceneSyncOptions): void {
  const {
    transformSyncToken,
    stateRef,
    groupByKeyRef,
    setRebuildToken,
    recomputeWarningsRef,
    regenerateActiveThumbnailRef
  } = options

  useEffect(() => {
    if (transformSyncToken === 0 || !stateRef.current) return

    const synced = syncEditorTransformScene(stateRef.current, groupByKeyRef.current)
    if (!synced) {
      setRebuildToken((token) => token + 1)
      return
    }
    recomputeWarningsRef.current()
    regenerateActiveThumbnailRef.current?.()
    // The token drives this effect; live state and scene refs do not rebind the work on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transformSyncToken])
}
