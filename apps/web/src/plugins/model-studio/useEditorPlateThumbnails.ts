/**
 * Owns the offscreen plate renderer, live thumbnail capture, and stale-thumbnail refresh queue.
 * Plate IDs identify cached images across reorders; the active plate uses its mounted scene,
 * while inactive plates are rebuilt only after a material edit or an explicit save/slice capture.
 */
import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import * as THREE from 'three'
import type { EditorInstance, EditorState } from './lib/editorModel'
import { createPlateThumbnailRenderer, type PlateThumbnailRenderer } from './lib/plateThumbnail'
import { materialThumbnailsChanged, type MaterialThumbnailInputs } from './lib/materialThumbnailInvalidation'
import { captureEditorPlateThumbnails, type PlateThumbnailCaptureOptions } from './lib/editorPlateThumbnailCapture'

const THUMBNAIL_RECOLOUR_DEBOUNCE_MS = 250

interface EditorPlateThumbnailOptions {
  state: EditorState | null
  stateRef: MutableRefObject<EditorState | null>
  activePlateIndex: number
  filamentColors: Record<number, string>
  buildInstanceGroup: (instance: EditorInstance) => Promise<THREE.Group | null>
  sceneRef: MutableRefObject<THREE.Scene | null>
  plateRootRef: MutableRefObject<THREE.Group | null>
  pendingScenePlatesRef: MutableRefObject<Set<number>>
  plateThumbnailsRef: MutableRefObject<Record<number, string>>
  setPlateThumbnails: Dispatch<SetStateAction<Record<number, string>>>
  staleEmbeddedPlates: ReadonlySet<number>
  setStaleEmbeddedPlates: Dispatch<SetStateAction<ReadonlySet<number>>>
  regenerateActiveThumbnailRef: MutableRefObject<(() => void) | null>
}

/** Return active-plate and save/slice capture actions while managing thumbnail invalidation. */
export function useEditorPlateThumbnails(options: EditorPlateThumbnailOptions) {
  const {
    state,
    stateRef,
    activePlateIndex,
    filamentColors,
    buildInstanceGroup,
    sceneRef,
    plateRootRef,
    pendingScenePlatesRef,
    plateThumbnailsRef,
    setPlateThumbnails,
    staleEmbeddedPlates,
    setStaleEmbeddedPlates,
    regenerateActiveThumbnailRef
  } = options
  const thumbnailRendererRef = useRef<PlateThumbnailRenderer | null>(null)

  /** Lazily create one renderer so opening the editor need not allocate another WebGL context. */
  const getThumbnailRenderer = useCallback((): PlateThumbnailRenderer => {
    let renderer = thumbnailRendererRef.current
    if (!renderer) {
      renderer = createPlateThumbnailRenderer()
      thumbnailRendererRef.current = renderer
    }
    return renderer
  }, [])
  useEffect(() => () => {
    thumbnailRendererRef.current?.dispose()
    thumbnailRendererRef.current = null
  }, [])

  /** Snapshot the already-mounted plate, then restore its scene parent after rendering. */
  const regenerateActivePlateThumbnail = useCallback(() => {
    const plateRoot = plateRootRef.current
    const plate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
    if (!plateRoot || !plate) return
    try {
      const url = getThumbnailRenderer().render(plateRoot, plate.bed)
      setPlateThumbnails((current) => ({ ...current, [plate.plateId]: url }))
    } catch {
      // Thumbnail rendering is best-effort; ignore failures.
    } finally {
      // `render` re-parents the group out of the editor scene; restore it.
      const scene = sceneRef.current
      if (scene && plateRoot.parent !== scene) scene.add(plateRoot)
    }
  }, [activePlateIndex, getThumbnailRenderer, plateRootRef, sceneRef, stateRef, setPlateThumbnails])
  regenerateActiveThumbnailRef.current = regenerateActivePlateThumbnail

  /** Capture fresh thumbnail bytes for save, slice, and object export. */
  const captureAllPlateThumbnails = useCallback(
    (current: EditorState, captureOptions?: PlateThumbnailCaptureOptions) => captureEditorPlateThumbnails(
      current,
      captureOptions ?? {},
      {
        renderer: getThumbnailRenderer(),
        buildInstanceGroup,
        getLiveThumbnails: () => plateThumbnailsRef.current,
        getPendingScenePlates: () => pendingScenePlatesRef.current,
        setLiveThumbnail: (plateId, url) => {
          setPlateThumbnails((existing) => ({ ...existing, [plateId]: url }))
        }
      }
    ),
    [buildInstanceGroup, getThumbnailRenderer, pendingScenePlatesRef, plateThumbnailsRef, setPlateThumbnails]
  )

  const previousThumbnailMaterialsRef = useRef<MaterialThumbnailInputs | null>(null)
  useEffect(() => {
    const next = { colors: filamentColors, baseIds: state?.baseFilamentIds }
    const previous = previousThumbnailMaterialsRef.current
    previousThumbnailMaterialsRef.current = next
    if (!materialThumbnailsChanged(previous, next)) return
    const current = stateRef.current
    if (!current) return
    // The active plate follows live material edits. Every inactive plate, including one with a
    // cached live image, needs fresh capture after a colour or base-reference replacement.
    const affected = current.plates
      .filter((plate) => plate.index > 0 && plate.index !== activePlateIndex)
      .map((plate) => plate.plateId)
    setPlateThumbnails((existing) => {
      const next = { ...existing }
      for (const plateId of affected) delete next[plateId]
      return next
    })
    setStaleEmbeddedPlates(new Set(affected))
  }, [filamentColors, state?.baseFilamentIds, stateRef, activePlateIndex,
    setPlateThumbnails, setStaleEmbeddedPlates])

  /** Drain invalidated inactive plates one at a time so edits remain responsive. */
  useEffect(() => {
    if (staleEmbeddedPlates.size === 0) return
    const next = [...staleEmbeddedPlates][0]
    if (next === undefined) return
    const current = stateRef.current
    if (!current) return
    let cancelled = false
    const controller = new AbortController()
    void (async () => {
      try {
        await captureAllPlateThumbnails(current, { force: true, only: new Set([next]), signal: controller.signal })
      } catch (error) {
        // A newer material edit cancels this capture before it can publish an outdated image.
        if (!controller.signal.aborted) console.warn('[editor] material thumbnail refresh failed', error)
      } finally {
        // A failed plate must not wedge the queue. Its tile keeps showing the loading state.
        if (!cancelled) setStaleEmbeddedPlates((pending) => {
          const remaining = new Set(pending)
          remaining.delete(next)
          return remaining
        })
      }
    })()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [staleEmbeddedPlates, captureAllPlateThumbnails, stateRef, setStaleEmbeddedPlates])

  // The paint hook recolours live meshes in place. A settled swatch change needs one new active
  // thumbnail, but the initial build captures its own plate after all models have arrived.
  const thumbnailColourSettledRef = useRef(false)
  useEffect(() => {
    if (!thumbnailColourSettledRef.current) {
      thumbnailColourSettledRef.current = true
      return
    }
    const timer = setTimeout(
      () => regenerateActiveThumbnailRef.current?.(),
      THUMBNAIL_RECOLOUR_DEBOUNCE_MS
    )
    return () => clearTimeout(timer)
  }, [filamentColors, regenerateActiveThumbnailRef])

  return { regenerateActivePlateThumbnail, captureAllPlateThumbnails }
}
