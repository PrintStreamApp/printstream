/**
 * Applies material-only editor edits to mounted meshes and refreshes paint and plate thumbnails.
 * It reads live refs when the token changes so a swatch-colour render does not traverse the scene.
 */
import { useEffect, type MutableRefObject } from 'react'
import * as THREE from 'three'
import type { EditorState } from './lib/editorModel'
import { syncEditorMaterialScene } from './lib/editorMaterialSceneSync'

interface MaterialSceneSyncOptions {
  materialSyncToken: number
  stateRef: MutableRefObject<EditorState | null>
  groupByKeyRef: MutableRefObject<Map<string, THREE.Group>>
  resolveColorFilamentIdRef: MutableRefObject<(id: number | null) => number | null>
  filamentColorsRef: MutableRefObject<Record<number, string>>
  refreshPaintOverlaysRef: MutableRefObject<() => void>
  regenerateActiveThumbnailRef: MutableRefObject<(() => void) | null>
}

/** Sync mounted colours when a material edit or completed plate build bumps the token. */
export function useEditorMaterialSceneSync(options: MaterialSceneSyncOptions): void {
  const {
    materialSyncToken,
    stateRef,
    groupByKeyRef,
    resolveColorFilamentIdRef,
    filamentColorsRef,
    refreshPaintOverlaysRef,
    regenerateActiveThumbnailRef
  } = options

  useEffect(() => {
    if (materialSyncToken === 0 || !stateRef.current) return

    syncEditorMaterialScene(
      stateRef.current,
      groupByKeyRef.current,
      resolveColorFilamentIdRef.current,
      filamentColorsRef.current
    )
    refreshPaintOverlaysRef.current()
    regenerateActiveThumbnailRef.current?.()
    // The refs supply live colours without a full traversal on every swatch-colour render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materialSyncToken])
}
