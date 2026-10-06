/**
 * Builds the active plate's bed, models, and prime tower into `useEditorScene`'s viewport.
 * A plate switch populates the live root progressively; same-plate edits build into a detached
 * group and swap atomically. Superseded work never publishes its staged groups or progress.
 */
import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import * as THREE from 'three'
import type { TransformControls } from 'three-stdlib'
import { bedSurfaceSignature } from './lib/bedSurfaceSignature'
import { disposeObject3D } from './lib/threeMfScene'
import { createPrimeTowerObject, nextPaint, removePrimeTowers } from './editorGeometry'
import type { EditorInstance, EditorPlate } from './lib/editorModel'
import type { OrbitPivotBounds } from './lib/viewportCamera'
import {
  buildPlateInstances,
  countPlateLoadUnits,
  createPlateBedSurface,
  ensureLiveBed,
  prefetchPlateGeometry,
  type PlateBedSurfaceInput
} from './lib/editorActivePlateBuildHelpers'

interface ActivePlateBuildOptions {
  activePlate: EditorPlate | null
  activePlateIndex: number
  activeInstanceKeys: string
  sceneReady: boolean
  rebuildToken: number
  showBedModel: boolean
  bedModelGeometry: THREE.BufferGeometry | null
  bedTexture: THREE.Texture | null
  buildInstanceGroup: (instance: EditorInstance) => Promise<THREE.Group | null>
  fetchGeometry: (entryPath: string) => Promise<Map<number, THREE.BufferGeometry>>
  fetchImportGeometry: (importId: string, partIndex?: number) => Promise<THREE.BufferGeometry>
  sceneRef: MutableRefObject<THREE.Scene | null>
  plateRootRef: MutableRefObject<THREE.Group | null>
  bedCenterRef: MutableRefObject<{ x: number; y: number }>
  bedBoundsRef: MutableRefObject<OrbitPivotBounds | null>
  viewDistanceRef: MutableRefObject<number>
  prevBuiltPlateIndexRef: MutableRefObject<number | null>
  framedViewKeyRef: MutableRefObject<string | null>
  frameDefaultViewRef: MutableRefObject<(() => void) | null>
  pendingScenePlatesRef: MutableRefObject<Set<number>>
  transformRef: MutableRefObject<TransformControls | null>
  groupByKeyRef: MutableRefObject<Map<string, THREE.Group>>
  primeTowerObjRef: MutableRefObject<THREE.Object3D | null>
  isInstancePrintedRef: MutableRefObject<(instance: EditorInstance) => boolean>
  towerRequiredRef: MutableRefObject<boolean>
  computePrimeTowerHeightRef: MutableRefObject<(groups: Map<string, THREE.Group>, plateIndex: number) => number>
  projectFilamentCountRef: MutableRefObject<number>
  reattachGizmoRef: MutableRefObject<() => void>
  recomputeWarningsRef: MutableRefObject<() => void>
  regenerateActiveThumbnailRef: MutableRefObject<(() => void) | null>
  setViewerError: Dispatch<SetStateAction<string | null>>
  setViewportBuilding: Dispatch<SetStateAction<boolean>>
  setBuildIncremental: Dispatch<SetStateAction<boolean>>
  setBuildProgress: Dispatch<SetStateAction<{ done: number; total: number } | null>>
  setRenderedInstanceKeys: Dispatch<SetStateAction<ReadonlySet<string>>>
  setMaterialSyncToken: Dispatch<SetStateAction<number>>
}

/** Start one cancellable scene build when the active plate or its viewport resources change. */
export function useEditorActivePlateBuild(options: ActivePlateBuildOptions): void {
  const {
    activePlate,
    activePlateIndex,
    activeInstanceKeys,
    sceneReady,
    rebuildToken,
    showBedModel,
    bedModelGeometry,
    bedTexture,
    buildInstanceGroup,
    fetchGeometry,
    fetchImportGeometry,
    sceneRef,
    plateRootRef,
    bedCenterRef,
    bedBoundsRef,
    viewDistanceRef,
    prevBuiltPlateIndexRef,
    framedViewKeyRef,
    frameDefaultViewRef,
    pendingScenePlatesRef,
    transformRef,
    groupByKeyRef,
    primeTowerObjRef,
    isInstancePrintedRef,
    towerRequiredRef,
    computePrimeTowerHeightRef,
    projectFilamentCountRef,
    reattachGizmoRef,
    recomputeWarningsRef,
    regenerateActiveThumbnailRef,
    setViewerError,
    setViewportBuilding,
    setBuildIncremental,
    setBuildProgress,
    setRenderedInstanceKeys,
    setMaterialSyncToken
  } = options

  useEffect(() => {
    const scene = sceneRef.current
    const plateRoot = plateRootRef.current
    if (!scene || !plateRoot || !activePlate) return

    let cancelled = false
    const abort = new AbortController()
    setViewerError(null)
    setViewportBuilding(true)

    // Bed dimensions for the active plate, drawn at the bed's true centre so the grid
    // spans [minX,maxX]x[minY,maxY]. Instances stay in the same plate-local frame
    // (their decomposed positions), so objects sit on the grid. World == plate-local.
    const bedWidth = Math.max(activePlate.bed.maxX - activePlate.bed.minX, 1)
    const bedDepth = Math.max(activePlate.bed.maxY - activePlate.bed.minY, 1)
    const bedCenterX = (activePlate.bed.minX + activePlate.bed.maxX) / 2
    const bedCenterY = (activePlate.bed.minY + activePlate.bed.maxY) / 2
    bedCenterRef.current = { x: bedCenterX, y: bedCenterY }
    bedBoundsRef.current = {
      minX: activePlate.bed.minX,
      maxX: activePlate.bed.maxX,
      minY: activePlate.bed.minY,
      maxY: activePlate.bed.maxY
    }
    // Re-frame the iso view on the new bed centre when the plate changes, sizing distance to
    // the bed. Adding/removing models on the same plate keeps the current camera.
    viewDistanceRef.current = Math.max(bedWidth, bedDepth) * 1.6
    const isPlateSwitch = prevBuiltPlateIndexRef.current !== null && prevBuiltPlateIndexRef.current !== activePlateIndex
    prevBuiltPlateIndexRef.current = activePlateIndex
    // Reframe on a genuine plate switch, and when the plate OR its bed changes (e.g.
    // switching target printer resizes/moves the bed). Adding/removing models on the same
    // plate+bed keeps the user's current camera. The plate-switch check is deliberate
    // belt-and-braces over the key compare: index reuse (plate reorder/delete) can leave a
    // stale latched key matching the new plate, which must not skip the switch reframe.
    const viewKey = `${activePlateIndex}|${bedCenterX},${bedCenterY},${bedWidth},${bedDepth}`
    // Reframe the camera SYNCHRONOUSLY here (not at the async swap below). frameDefaultView
    // only reads the bed centre/distance refs set just above, it's independent of the geometry,
    // and on open the build effect can run several times while slice-config/filament data
    // settles. If the reframe waited for the swap, the first run would latch the view key but
    // get superseded before swapping, and the surviving run (key already latched) would skip the
    // reframe entirely, leaving the initial plate framed on the default camera.
    if (isPlateSwitch || framedViewKeyRef.current !== viewKey) {
      // Don't latch the key while this plate's scene is still loading: it is framed on the
      // borrowed/placeholder bed, and if the real bed differs the post-fill rebuild must still
      // see a key change and reframe.
      // Keyed on the plate's session IDENTITY, like every other read of this set: `index` is a
      // position that a reorder or delete rewrites, so asking with it either misses the pending
      // plate (latching a key framed on the placeholder bed) or hits an unrelated one.
      if (!pendingScenePlatesRef.current.has(activePlate.plateId)) framedViewKeyRef.current = viewKey
      frameDefaultViewRef.current?.()
    }

    // Render strategy turns on whether the live plate is EMPTY:
    //  - A genuine plate switch clears it (just below), and the first open starts empty: build
    //    straight onto the live plateRoot and reveal each model as it finishes, so loading reads
    //    as steady progress instead of one late pop-in, and we never hold two plates' geometry
    //    at once (lower peak memory on a switch).
    //  - When the plate already has content (same-plate add/remove/duplicate, or a settling
    //    rebuild on open) build into a DETACHED staging group and swap it in atomically once
    //    complete. That path never flashes the plate empty when a build is superseded mid-flight
    //    (slice-config/filament settling, a rapid switch); a superseded staged build just discards
    //    its group and the visible plate is untouched.
    if (isPlateSwitch) {
      // Empty the previous plate from the live view immediately rather than leaving its models up
      // while the new plate loads: detach the gizmo and dispose the old meshes. The destination
      // plate's empty bed is added just below; models then populate onto it.
      transformRef.current?.detach()
      disposeObject3D(plateRoot)
      plateRoot.clear()
      groupByKeyRef.current.clear()
      primeTowerObjRef.current = null
    }
    const incremental = groupByKeyRef.current.size === 0
    setBuildIncremental(incremental)
    // Publish the load count SYNCHRONOUSLY (before the async build's first paint/prefetch) so the
    // progress bar shows the real total from the first frame, otherwise a partly-loaded plate reads
    // as finished while the count is still null. Count per-PART (the actual download units, mirroring
    // the prefetch fan-out below), not per-object, so a single multi-solid assembly still shows
    // granular progress instead of a stuck "1 of 1". The prefetch bumps `done` as each part settles.
    const totalLoadUnits = countPlateLoadUnits(activePlate)
    setBuildProgress(totalLoadUnits > 0 ? { done: 0, total: totalLoadUnits } : null)
    // Identifies the bed currently on the plate. On an incremental (empty-plate) rebuild the plate
    // is not cleared, so a bed added on a previous pass persists while its DIMENSIONS and its 3D
    // plate mesh both change underneath it (a printer switch refetches each, separately, so they
    // land on different renders). Replace the bed when its signature changed rather than skipping
    // because "a bed already exists", which stranded the stale bed until an Arrange / add-model
    // forced the atomic-swap path. The rule itself lives in lib/bedSurfaceSignature.ts, which
    // documents what it has already got wrong; the atomic (staging) path rebuilds unconditionally.
    const bedModel = showBedModel ? bedModelGeometry : null
    const customBedTexture = showBedModel ? bedTexture : null
    const bedSignature = bedSurfaceSignature({
      width: bedWidth,
      depth: bedDepth,
      centerX: bedCenterX,
      centerY: bedCenterY,
      excludeAreas: activePlate.bed.excludeAreas,
      bedModel,
      bedTexture: customBedTexture
    })
    const bedSurfaceInput: PlateBedSurfaceInput = {
      bed: activePlate.bed,
      width: bedWidth,
      depth: bedDepth,
      centerX: bedCenterX,
      centerY: bedCenterY,
      model: bedModel,
      texture: customBedTexture,
      signature: bedSignature
    }
    // Bed updates are cheap and independent of the object rebuild. Replace the visible bed
    // immediately even when models are rebuilding off-screen, or the old printer's mesh stays
    // visible until every object finishes loading.
    ensureLiveBed(plateRoot, bedSurfaceInput)

    void (async () => {
      // Incremental: add straight to the live plateRoot (already bearing its bed). Atomic: assemble
      // in a detached staging group (with its own bed) and swap it in at the end.
      const staging = incremental ? null : new THREE.Group()
      const target = staging ?? plateRoot
      if (staging) {
        staging.add(createPlateBedSurface(bedSurfaceInput))
      }
      let builtTower: THREE.Object3D | null = null
      // Only the detached staging group is ours to discard on cancel; live (incremental) models
      // already on plateRoot are reconciled by the next build's swap/clear or by scene teardown.
      const discardStaging = () => { if (staging) disposeObject3D(staging) }

      // Paint once before the (potentially heavy) geometry work so the loading indicator shows
      // immediately rather than after the first object's synchronous build.
      await nextPaint()
      if (cancelled) { discardStaging(); return }

      // Advance the progress bar as each part download settles (success OR failure), so the
      // indicator reflects real download progress, even for one big multi-part assembly. Guarded on
      // `cancelled` so a superseded build never writes progress for a plate the user left.
      let loadedUnits = 0
      const bumpLoaded = () => {
        if (cancelled) return
        loadedUnits += 1
        setBuildProgress(totalLoadUnits > 0 ? { done: loadedUnits, total: totalLoadUnits } : null)
      }
      // The geometry cache limits concurrent downloads, so prefetch can start every part now.
      prefetchPlateGeometry(activePlate, fetchGeometry, fetchImportGeometry, bumpLoaded)
      const builtGroups = await buildPlateInstances({
        plate: activePlate,
        target,
        incremental,
        buildInstanceGroup,
        isInstancePrinted: (instance) => isInstancePrintedRef.current(instance),
        onIncrementalGroup: (key, group) => {
          groupByKeyRef.current.set(key, group)
          setRenderedInstanceKeys((prev) => (prev.has(key) ? prev : new Set(prev).add(key)))
        },
        setViewerError,
        isCancelled: () => cancelled || abort.signal.aborted
      })
      if (!builtGroups) {
        discardStaging()
        return
      }
      // Now that the plate's models are present, size the prime tower to the print height (its
      // depth depends on height) and place it on the bed. The live presence gate mirrors the
      // slicer's project-wide filament count and forcing conditions, not this plate's usage;
      // see shouldShowEditorPrimeTower in lib/editorPrimeTowerHeight.ts.
      if (activePlate.primeTower && towerRequiredRef.current) {
        // Idempotent: the live toggle effect below may already have added one to this root.
        removePrimeTowers(target)
        const printHeight = computePrimeTowerHeightRef.current(builtGroups, activePlate.index)
        builtTower = createPrimeTowerObject(activePlate.primeTower, projectFilamentCountRef.current, printHeight || 30)
        target.add(builtTower)
      }

      if (staging) {
        // ---- Atomic swap: replace the visible plate with the freshly built one in one frame. ----
        transformRef.current?.detach()
        disposeObject3D(plateRoot)
        plateRoot.clear()
        while (staging.children.length > 0) plateRoot.add(staging.children[0]!)
        groupByKeyRef.current.clear()
        for (const [key, group] of builtGroups) groupByKeyRef.current.set(key, group)
      }
      // Incremental builds are already live (groupByKeyRef was populated as each model landed).
      primeTowerObjRef.current = builtTower
      // Re-attach the gizmo to the selected instance if it is on this plate.
      reattachGizmoRef.current()
      // All of this plate's models are now in the scene: refresh placement warnings now so a
      // rebuild-driven change (undo/redo, delete, duplicate, plate switch) reflects in the panel
      // immediately rather than on the next rAF poll tick (which can lag, or never arrive if a
      // drag flag was left stuck). The poll remains as a backstop for non-rebuild moves.
      // Everything this build produced is now on screen (the atomic swap above reveals it all at
      // once; incremental builds have been adding to this as each model landed).
      setRenderedInstanceKeys(new Set(builtGroups.keys()))
      recomputeWarningsRef.current()
      // Reconcile part colours from the CURRENT state. An incremental build colours each mesh from
      // the instance snapshot it was built with, so a material reassigned WHILE the solids were
      // still streaming in would otherwise keep its old colour until the next rebuild. The
      // material-sync effect is not a dependency of this build effect, so this never re-triggers it.
      setMaterialSyncToken((token) => token + 1)
      setBuildProgress(null)
      setBuildIncremental(false)
      setViewportBuilding(false)
      // Snapshot this plate now that its contents are present.
      regenerateActiveThumbnailRef.current?.()
    })()

    return () => {
      cancelled = true
      abort.abort()
      // A superseded/cancelled build returns early without clearing the building flag; reset it
      // here so it never sticks "true" (which would leave controls disabled on a ready viewport).
      // The next effect run sets it true again synchronously, so there's no flicker.
      setViewportBuilding(false)
      setBuildProgress(null)
      setBuildIncremental(false)
    }
    // showBedModel/bedModelGeometry are read when building the bed surface, so a toggle (or a
    // late-arriving mesh) has to rebuild the plate, without them the option appears to do nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePlateIndex, activeInstanceKeys, buildInstanceGroup, sceneReady, rebuildToken,
    showBedModel, bedModelGeometry, bedTexture])

}
