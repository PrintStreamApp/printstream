/**
 * Fetches the visible plate scene first, then streams the rest with bounded fan-out.
 * The opening source index is frozen because host plate selection mirrors live editor
 * changes back to the caller; following those changes would refetch the first scene.
 */
import { useCallback, useMemo, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { LibraryThreeMfScene, ThreeMfIndex } from '@printstream/shared'
import type { EditorProjectSource } from './lib/editorProjectSource'

const REST_SCENE_CONCURRENCY = 3

interface PlateSceneQueryOptions {
  sourceIndex: ThreeMfIndex | undefined
  initialPlateIndex: number | null | undefined
  baseFileId: string | null
  baseVersionId: string | null | undefined
  targetPrinterModel: string | null | undefined
  hasNoBaseFile: boolean
  projectSource: EditorProjectSource
}

/**
 * Load each remaining source plate with at most three active parses.
 * A null scene has no plated metadata and contributes no instances.
 */
export async function loadRemainingPlateScenes(
  plateIndices: readonly number[],
  loadScene: (plateIndex: number, signal?: AbortSignal) => Promise<LibraryThreeMfScene | null>,
  signal?: AbortSignal
): Promise<Map<number, LibraryThreeMfScene>> {
  const scenes = new Map<number, LibraryThreeMfScene>()
  const queue = [...plateIndices]
  const worker = async () => {
    for (;;) {
      const plateIndex = queue.shift()
      if (plateIndex === undefined) return
      const scene = await loadScene(plateIndex, signal)
      if (scene) scenes.set(plateIndex, scene)
    }
  }
  await Promise.all(Array.from({ length: Math.min(REST_SCENE_CONCURRENCY, queue.length) }, worker))
  return scenes
}

/** Return source plate indices, query states, and every scene loaded so far. */
export function useEditorPlateSceneQueries(options: PlateSceneQueryOptions) {
  const {
    sourceIndex,
    initialPlateIndex,
    baseFileId,
    baseVersionId,
    targetPrinterModel,
    hasNoBaseFile,
    projectSource
  } = options
  const plateIndices = useMemo(
    () => (sourceIndex?.plates ?? []).map((plate) => plate.index),
    [sourceIndex]
  )

  const frozenPreferredPlateRef = useRef<number | null>(null)
  const preferredPlateIndex = useMemo(() => {
    if (frozenPreferredPlateRef.current !== null) return frozenPreferredPlateRef.current
    if (plateIndices.length === 0) return null
    const resolved = initialPlateIndex != null && plateIndices.includes(initialPlateIndex)
      ? initialPlateIndex
      : plateIndices[0]!
    frozenPreferredPlateRef.current = resolved
    return resolved
  }, [plateIndices, initialPlateIndex])

  const fetchPlateScene = useCallback(
    (plateIndex: number, signal?: AbortSignal) => projectSource.loadScene(plateIndex, targetPrinterModel ?? null, signal),
    [projectSource, targetPrinterModel]
  )
  const initialSceneQuery = useQuery({
    queryKey: ['library-editor-scene-initial', baseFileId, baseVersionId ?? 'current',
      preferredPlateIndex ?? 0, targetPrinterModel ?? ''],
    enabled: !hasNoBaseFile && preferredPlateIndex !== null,
    staleTime: 60_000,
    queryFn: ({ signal }) => fetchPlateScene(preferredPlateIndex!, signal)
  })
  const initialSceneSettled = initialSceneQuery.isSuccess || initialSceneQuery.isError
  const restPlateIndices = useMemo(
    () => plateIndices.filter((index) => index !== preferredPlateIndex),
    [plateIndices, preferredPlateIndex]
  )
  const restScenesQuery = useQuery({
    queryKey: ['library-editor-scenes-rest', baseFileId, baseVersionId ?? 'current',
      restPlateIndices.join(','), targetPrinterModel ?? ''],
    enabled: !hasNoBaseFile && restPlateIndices.length > 0 && initialSceneSettled,
    staleTime: 60_000,
    queryFn: ({ signal }) => loadRemainingPlateScenes(restPlateIndices, fetchPlateScene, signal)
  })

  const scenesByPlate = useMemo(() => {
    const scenes = new Map<number, LibraryThreeMfScene>()
    if (restScenesQuery.data) {
      for (const [plateIndex, scene] of restScenesQuery.data) scenes.set(plateIndex, scene)
    }
    if (initialSceneQuery.data && preferredPlateIndex !== null) {
      scenes.set(preferredPlateIndex, initialSceneQuery.data)
    }
    return scenes
  }, [initialSceneQuery.data, restScenesQuery.data, preferredPlateIndex])

  return {
    plateIndices,
    preferredPlateIndex,
    initialSceneQuery,
    initialSceneSettled,
    restPlateIndices,
    restScenesQuery,
    scenesByPlate
  }
}
