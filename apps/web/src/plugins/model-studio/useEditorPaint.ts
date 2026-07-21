/**
 * Owns the editor's triangle-painting feature: the support/seam/colour brush settings
 * (mode, radius, tool, smart-fill angle, height range, edge detection, overhang gate,
 * colour filament) and the logic that applies, refreshes, and clears painted-triangle
 * overlays on the live instance meshes.
 *
 * State + setters drive the paint settings panel and brush toolbar in {@link EditorView};
 * the refs are read inside the long-lived viewport pointer handlers (in `useEditorScene`)
 * so a brush stroke never re-binds the scene effect. Paint maps are mutated in place (the
 * gizmo write-back idiom) and history is recorded once per stroke by the pointer handler.
 *
 * Live editor values it reads (state, the instance group map, the active selection/plate,
 * history + thumbnail hooks) stay declared in EditorView and are threaded in as refs/params;
 * module-level paint helpers/types are imports below, not params.
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import * as THREE from 'three'
import { isNonRenderableThreeMfPartSubtype } from '@printstream/shared'
import {
  disposeObject3D,
  getGeometryTrianglePaint,
  type SupportPaintCodes,
  type TrianglePaintChannel
} from './lib/threeMfScene'
import {
  applyBucketFill,
  applyHeightRangePaint,
  applySingleTrianglePaint,
  applySmartFill,
  applySupportPaintBrush,
  buildTrianglePaintOverlay,
  getTriangleScanData,
  type SupportPaintBrushMode,
  type PaintOverlayCache
} from './lib/supportPaint'
import {
  PAINT_CHANNEL_SPECS,
  effectivePaintTool,
  paintChannelForGizmoMode,
  type GizmoMode,
  type PaintToolType
} from './editorGeometry'
import { supportPaintKey, type EditorPlate, type EditorState } from './lib/editorModel'

/**
 * Every EditorView-local value the paint logic reads. Refs/callbacks stay declared in
 * EditorView (other code reads them); they are threaded in here so the moved bodies
 * reference them unchanged. `colorPaintStateColor` is shared with EditorView's instance
 * group builder, so it is owned there and passed in. Module-level helpers/types are
 * imports above, not params.
 */
export interface EditorPaintParams {
  /** Current gizmo mode; the active paint channel is derived from it. */
  gizmoMode: GizmoMode
  /** Live per-filament colours from the slice settings (drives the recolour effect). */
  filamentColors: Record<number, string> | undefined
  /** Map a colour-paint code to the live colour of its filament (shared with the group builder). */
  colorPaintStateColor: (state: number) => number | null
  stateRef: MutableRefObject<EditorState | null>
  groupByKeyRef: MutableRefObject<Map<string, THREE.Group>>
  selectedKeyRef: MutableRefObject<string | null>
  activePlateRef: MutableRefObject<EditorPlate | null>
  recordHistoryRef: MutableRefObject<() => void>
  regenerateActiveThumbnailRef: MutableRefObject<(() => void) | null>
}

/** Everything EditorView (and `useEditorScene`) consume from the paint hook. */
export interface EditorPaint {
  paintBrushMode: SupportPaintBrushMode
  setPaintBrushMode: Dispatch<SetStateAction<SupportPaintBrushMode>>
  paintBrushModeRef: MutableRefObject<SupportPaintBrushMode>
  paintBrushRadius: number
  setPaintBrushRadius: Dispatch<SetStateAction<number>>
  paintBrushRadiusRef: MutableRefObject<number>
  paintTool: PaintToolType
  setPaintTool: Dispatch<SetStateAction<PaintToolType>>
  paintToolRef: MutableRefObject<PaintToolType>
  paintSmartAngle: number
  setPaintSmartAngle: Dispatch<SetStateAction<number>>
  paintHeightRange: number
  setPaintHeightRange: Dispatch<SetStateAction<number>>
  paintEdgeDetection: boolean
  setPaintEdgeDetection: Dispatch<SetStateAction<boolean>>
  paintOnOverhangs: boolean
  setPaintOnOverhangs: Dispatch<SetStateAction<boolean>>
  paintOverhangAngle: number
  setPaintOverhangAngle: Dispatch<SetStateAction<number>>
  paintColorFilamentId: number | null
  setPaintColorFilamentId: Dispatch<SetStateAction<number | null>>
  paintColorFilamentIdRef: MutableRefObject<number | null>
  activePaintChannel: TrianglePaintChannel | null
  activePaintChannelRef: MutableRefObject<TrianglePaintChannel | null>
  activePaintTool: PaintToolType
  effectivePaintCodes: (mesh: THREE.Mesh, channel: TrianglePaintChannel) => SupportPaintCodes | null
  refreshPaintOverlays: (root?: THREE.Object3D) => void
  refreshPaintOverlaysRef: MutableRefObject<(root?: THREE.Object3D) => void>
  applyPaintStrokeRef: MutableRefObject<(
    mesh: THREE.Mesh,
    worldPoint: THREE.Vector3,
    worldDirection: THREE.Vector3,
    faceIndex: number | null,
    phase: 'down' | 'move'
  ) => void>
  clearSelectedPaint: () => void
}

export function useEditorPaint(params: EditorPaintParams): EditorPaint {
  const {
    gizmoMode,
    filamentColors,
    colorPaintStateColor,
    stateRef,
    groupByKeyRef,
    selectedKeyRef,
    activePlateRef,
    recordHistoryRef,
    regenerateActiveThumbnailRef
  } = params

  // Support-paint brush: enforce/block/erase + radius (mm). Read via refs inside the
  // viewport's pointer handlers so strokes never re-bind the scene effect.
  const [paintBrushMode, setPaintBrushMode] = useState<SupportPaintBrushMode>('enforcer')
  const [paintBrushRadius, setPaintBrushRadius] = useState(3)
  const paintBrushModeRef = useRef(paintBrushMode)
  paintBrushModeRef.current = paintBrushMode
  const paintBrushRadiusRef = useRef(paintBrushRadius)
  paintBrushRadiusRef.current = paintBrushRadius
  // Paint tool (Bambu's tool row): circle/sphere brush, smart fill, single triangle,
  // height range. The selection is shared across channels; channels that lack the
  // selected tool fall back to the circle brush (see effectivePaintTool).
  const [paintTool, setPaintTool] = useState<PaintToolType>('circle')
  const paintToolRef = useRef(paintTool)
  paintToolRef.current = paintTool
  // Smart fill: max angle (deg) between neighbouring face normals to flood across.
  const [paintSmartAngle, setPaintSmartAngle] = useState(30)
  const paintSmartAngleRef = useRef(paintSmartAngle)
  paintSmartAngleRef.current = paintSmartAngle
  // Height range: band height (mm) painted upward from the clicked point.
  const [paintHeightRange, setPaintHeightRange] = useState(1)
  const paintHeightRangeRef = useRef(paintHeightRange)
  paintHeightRangeRef.current = paintHeightRange
  // Edge detection (colour brushes): strokes stop at edges sharper than the smart
  // fill angle instead of wrapping around them.
  const [paintEdgeDetection, setPaintEdgeDetection] = useState(false)
  const paintEdgeDetectionRef = useRef(paintEdgeDetection)
  paintEdgeDetectionRef.current = paintEdgeDetection
  // On overhangs only (support painting): strokes/fills affect only faces steeper
  // than the threshold (Bambu's highlight-by-angle gate).
  const [paintOnOverhangs, setPaintOnOverhangs] = useState(false)
  const paintOnOverhangsRef = useRef(paintOnOverhangs)
  paintOnOverhangsRef.current = paintOnOverhangs
  const [paintOverhangAngle, setPaintOverhangAngle] = useState(40)
  const paintOverhangAngleRef = useRef(paintOverhangAngle)
  paintOverhangAngleRef.current = paintOverhangAngle
  // Colour brush: which 1-based project filament new strokes paint with.
  const [paintColorFilamentId, setPaintColorFilamentId] = useState<number | null>(null)
  const paintColorFilamentIdRef = useRef(paintColorFilamentId)
  paintColorFilamentIdRef.current = paintColorFilamentId

  // ---- Triangle painting (support + seam brushes) -------------------------------

  // The active paint channel, derived from the tool mode; read via ref in handlers.
  const activePaintChannel = paintChannelForGizmoMode(gizmoMode)
  const activePaintChannelRef = useRef(activePaintChannel)
  activePaintChannelRef.current = activePaintChannel
  // The tool actually in effect for the active channel (channels without the selected
  // tool fall back to the circle brush; the shared selection is kept for when the user
  // returns to a channel that has it).
  const activePaintTool = activePaintChannel ? effectivePaintTool(activePaintChannel, paintTool) : paintTool

  /** Effective paint for a tagged mesh: this session's override, else the source mesh's. */
  const effectivePaintCodes = useCallback((mesh: THREE.Mesh, channel: TrianglePaintChannel): SupportPaintCodes | null => {
    const partRef = mesh.userData.supportPaintPart as { objectId: number; componentObjectId: number } | undefined
    if (!partRef) return null
    const override = stateRef.current?.[PAINT_CHANNEL_SPECS[channel].stateKey]?.[supportPaintKey(partRef.objectId, partRef.componentObjectId)]
    if (override) return Object.keys(override).length > 0 ? override : null
    return getGeometryTrianglePaint(mesh.geometry as THREE.BufferGeometry, channel)
  }, [stateRef])

  /** Replace a tagged mesh's painted-triangle overlay for one channel. */
  const setMeshPaintOverlay = useCallback((mesh: THREE.Mesh, channel: TrianglePaintChannel, codes: SupportPaintCodes | null) => {
    const spec = PAINT_CHANNEL_SPECS[channel]
    for (const child of mesh.children.filter((entry) => entry.name === spec.overlayName)) {
      mesh.remove(child)
      disposeObject3D(child)
    }
    // Per-(mesh, channel) meshing cache, persisted on the mesh so successive dabs only re-mesh the
    // triangles whose code changed (see PaintOverlayCache). Cleared when the channel's paint is.
    const cacheKey = `paintOverlayCache:${channel}`
    if (!codes || Object.keys(codes).length === 0) {
      mesh.userData[cacheKey] = undefined
      return
    }
    let cache = mesh.userData[cacheKey] as PaintOverlayCache | undefined
    if (!cache) { cache = new Map(); mesh.userData[cacheKey] = cache }
    const overlay = buildTrianglePaintOverlay(mesh.geometry as THREE.BufferGeometry, codes, {
      palette: spec.palette,
      name: spec.overlayName,
      offsetFactor: spec.offsetFactor,
      ...(channel === 'color' ? { colorForState: colorPaintStateColor } : {})
    }, cache)
    if (overlay) {
      // Match the scene's BambuStudio-parity gating (useEditorScene.applyPaintOverlayVisibility) so a
      // rebuilt overlay isn't briefly shown out of context: support/seam only for the selected object
      // while their tool is active; colour always. The scene re-applies on tool/selection changes.
      let groupKey: string | null = null
      for (let node: THREE.Object3D | null = mesh; node; node = node.parent) {
        if (typeof node.userData.instanceKey === 'string') { groupKey = node.userData.instanceKey; break }
      }
      overlay.visible = channel === 'color' || (channel === activePaintChannelRef.current && groupKey === selectedKeyRef.current)
      mesh.add(overlay)
    }
  }, [colorPaintStateColor, activePaintChannelRef, selectedKeyRef])

  // Coalesce overlay rebuilds to at most one per animation frame. buildTrianglePaintOverlay
  // re-meshes the part's ENTIRE (growing) paint map, so doing it synchronously on every pointermove
  // made freehand strokes stutter — and pointermove can fire faster than the display. During a
  // stroke we mark each touched (mesh, channel) dirty and rebuild once per frame from the latest
  // codes; the paint itself still applies on every move (only the re-meshing is throttled), and the
  // trailing frame after the last move renders the final state. Reads are via effectivePaintCodes so
  // the flush always meshes the current codes even if several dabs landed in one frame.
  const pendingOverlayRef = useRef(new Map<THREE.Mesh, Set<TrianglePaintChannel>>())
  const overlayRafRef = useRef<number | null>(null)
  const flushPendingOverlays = useCallback(() => {
    overlayRafRef.current = null
    const pending = pendingOverlayRef.current
    for (const [mesh, channels] of pending) {
      for (const channel of channels) setMeshPaintOverlay(mesh, channel, effectivePaintCodes(mesh, channel))
    }
    pending.clear()
  }, [setMeshPaintOverlay, effectivePaintCodes])
  const scheduleOverlayRebuild = useCallback((mesh: THREE.Mesh, channel: TrianglePaintChannel) => {
    let channels = pendingOverlayRef.current.get(mesh)
    if (!channels) { channels = new Set(); pendingOverlayRef.current.set(mesh, channels) }
    channels.add(channel)
    if (overlayRafRef.current == null) overlayRafRef.current = requestAnimationFrame(flushPendingOverlays)
  }, [flushPendingOverlays])
  // Cancel a pending rebuild on unmount (the editor closing) so it can't touch a disposed mesh.
  useEffect(() => () => { if (overlayRafRef.current != null) cancelAnimationFrame(overlayRafRef.current) }, [])

  /** Rebuild both channels' paint overlays for one instance group (or every group). */
  const refreshPaintOverlays = useCallback((root?: THREE.Object3D) => {
    const targets = root ? [root] : [...groupByKeyRef.current.values()]
    for (const target of targets) {
      const meshes: THREE.Mesh[] = []
      target.traverse((node) => {
        const mesh = node as THREE.Mesh
        if (mesh.isMesh && mesh.userData.supportPaintPart) meshes.push(mesh)
      })
      for (const mesh of meshes) {
        for (const channel of ['supports', 'seam', 'color'] as const) {
          setMeshPaintOverlay(mesh, channel, effectivePaintCodes(mesh, channel))
        }
      }
    }
  }, [effectivePaintCodes, setMeshPaintOverlay, groupByKeyRef])
  const refreshPaintOverlaysRef = useRef(refreshPaintOverlays)
  refreshPaintOverlaysRef.current = refreshPaintOverlays

  // Live recolour WITHOUT a plate rebuild. buildInstanceGroup now reads colours via refs (stable
  // w.r.t. colour), so a filament swatch edit no longer tears down + rebuilds the whole active plate
  // (the jank-2/SCALE-5 hot path — recolouring fired the full build effect on every picker tick).
  // Instead, walk the live groups and update each tagged part mesh's material colour + emissive lift
  // in place, and re-tint colour-paint overlays (whose tint follows the filament's live colour).
  // Modifier/added-part volumes carry no `recolor` tag (fixed subtype colour) so they're untouched.
  useEffect(() => {
    for (const group of groupByKeyRef.current.values()) {
      group.traverse((node) => {
        const mesh = node as THREE.Mesh
        if (!mesh.isMesh) return
        const recolor = mesh.userData.recolor as { filamentId: number | null; fallbackColor?: string } | undefined
        if (recolor) {
          const live = recolor.filamentId != null ? filamentColors?.[recolor.filamentId] : undefined
          const hex = live || recolor.fallbackColor || '#D3DDE7'
          const material = mesh.material as THREE.MeshStandardMaterial
          material.color.set(hex)
          if (material.emissive) material.emissive.set(hex).multiplyScalar(0.12)
        }
        if (mesh.userData.supportPaintPart) {
          // Only the colour channel's tint depends on filament colours; supports/seam use fixed palettes.
          // The meshing cache is keyed by code (not colour), so drop it so the new tint is rebuilt.
          mesh.userData['paintOverlayCache:color'] = undefined
          setMeshPaintOverlay(mesh, 'color', effectivePaintCodes(mesh, 'color'))
        }
      })
    }
  }, [filamentColors, setMeshPaintOverlay, effectivePaintCodes, groupByKeyRef])

  /**
   * Apply one dab of the ACTIVE channel's selected tool at a world-space hit on a
   * tagged mesh. Mutates the session's paint map in place (history is recorded once
   * per stroke by the pointer handler, matching the gizmo write-back idiom) and
   * refreshes only the touched meshes' overlays. `faceIndex` is the hit triangle
   * (the brush growth/fill seed); `phase` distinguishes the initial click from drag
   * continuation (the height band is placed by the click only).
   */
  const applyPaintStroke = useCallback((
    mesh: THREE.Mesh,
    worldPoint: THREE.Vector3,
    worldDirection: THREE.Vector3,
    faceIndex: number | null,
    phase: 'down' | 'move'
  ) => {
    const state = stateRef.current
    const channel = activePaintChannelRef.current
    if (!state || !channel) return
    const tool = effectivePaintTool(channel, paintToolRef.current)
    if (tool === 'height' && phase !== 'down') return

    const mode = paintBrushModeRef.current
    let paintState: number
    if (mode === 'eraser') paintState = 0
    else if (channel === 'color') {
      const filamentId = paintColorFilamentIdRef.current
      if (filamentId == null || filamentId < 1 || filamentId > 15) return
      paintState = filamentId
    } else paintState = mode === 'enforcer' ? 1 : 2

    const paintMesh = (target: THREE.Mesh, targetFaceIndex: number | null): void => {
      const partRef = target.userData.supportPaintPart as { objectId: number; componentObjectId: number } | undefined
      if (!partRef) return
      const geometry = target.geometry as THREE.BufferGeometry
      const scan = getTriangleScanData(geometry)
      if (!scan) return
      const stateKey = PAINT_CHANNEL_SPECS[channel].stateKey
      const key = supportPaintKey(partRef.objectId, partRef.componentObjectId)
      let channelPaint = state[stateKey]
      if (!channelPaint) {
        channelPaint = {}
        state[stateKey] = channelPaint
      }
      let codes = channelPaint[key]
      if (!codes) {
        // First stroke on this part: seed from the source mesh's existing paint so
        // erasing/overpainting starts from what the file already had.
        codes = { ...(getGeometryTrianglePaint(geometry, channel) ?? {}) }
        channelPaint[key] = codes
      }
      target.updateWorldMatrix(true, false)
      const inverse = new THREE.Matrix4().copy(target.matrixWorld).invert()
      const localPoint = worldPoint.clone().applyMatrix4(inverse)
      const localDirection = worldDirection.clone().transformDirection(inverse).normalize()
      // Brush radius is in world mm; approximate the local radius with the mesh's
      // average world axis scale (per-axis scale would need an ellipsoid test).
      const scaleX = new THREE.Vector3().setFromMatrixColumn(target.matrixWorld, 0).length()
      const scaleY = new THREE.Vector3().setFromMatrixColumn(target.matrixWorld, 1).length()
      const scaleZ = new THREE.Vector3().setFromMatrixColumn(target.matrixWorld, 2).length()
      const averageScale = (scaleX + scaleY + scaleZ) / 3 || 1
      // "On overhangs only" (support painting): faces steeper than the threshold,
      // judged on WORLD normals (Bambu's highlight_by_angle gate).
      let triangleAllowed: ((index: number) => boolean) | undefined
      if (channel === 'supports' && paintOnOverhangsRef.current) {
        const e = new THREE.Matrix3().getNormalMatrix(target.matrixWorld).elements
        const limit = -Math.cos((paintOverhangAngleRef.current * Math.PI) / 180)
        triangleAllowed = (i) => {
          const nx = scan.normals[i * 3]!
          const ny = scan.normals[i * 3 + 1]!
          const nz = scan.normals[i * 3 + 2]!
          const wx = e[0]! * nx + e[3]! * ny + e[6]! * nz
          const wy = e[1]! * nx + e[4]! * ny + e[7]! * nz
          const wz = e[2]! * nx + e[5]! * ny + e[8]! * nz
          const length = Math.sqrt(wx * wx + wy * wy + wz * wz) || 1
          return wz / length < limit
        }
      }
      let changed = false
      if (tool === 'fill') {
        if (targetFaceIndex == null) return
        changed = applySmartFill({
          codes,
          scan,
          seedTriangle: targetFaceIndex,
          angleDeg: paintSmartAngleRef.current,
          state: paintState,
          ...(triangleAllowed ? { triangleAllowed } : {})
        })
      } else if (tool === 'bucket') {
        if (targetFaceIndex == null) return
        changed = applyBucketFill({ codes, scan, seedTriangle: targetFaceIndex, state: paintState })
      } else if (tool === 'triangle') {
        if (targetFaceIndex == null) return
        changed = applySingleTrianglePaint({ codes, seedTriangle: targetFaceIndex, state: paintState })
      } else if (tool === 'height') {
        changed = applyHeightRangePaint({
          codes,
          scan,
          zBottom: worldPoint.z,
          zTop: worldPoint.z + paintHeightRangeRef.current,
          state: paintState,
          localToWorld: target.matrixWorld,
          averageScale
        })
      } else {
        changed = applySupportPaintBrush({
          codes,
          scan,
          point: localPoint,
          direction: localDirection,
          radius: paintBrushRadiusRef.current / averageScale,
          mode,
          shape: tool,
          ...(paintState > 0 ? { state: paintState } : {}),
          ...(targetFaceIndex != null ? { seedTriangle: targetFaceIndex } : {}),
          ...(triangleAllowed ? { triangleAllowed } : {}),
          ...(channel === 'color' && paintEdgeDetectionRef.current
            ? { propagationAngleDeg: paintSmartAngleRef.current }
            : {})
        })
      }
      if (changed) scheduleOverlayRebuild(target, channel)
    }

    if (tool === 'height') {
      // The band wraps the whole object: paint every printed part of the selected
      // instance, not just the part under the pointer (Bambu applies it per object).
      const group = selectedKeyRef.current ? groupByKeyRef.current.get(selectedKeyRef.current) : null
      const meshes: THREE.Mesh[] = []
      ;(group ?? mesh).traverse((node) => {
        const candidate = node as THREE.Mesh
        if (candidate.isMesh && candidate.userData.supportPaintPart) meshes.push(candidate)
      })
      for (const target of meshes.length > 0 ? meshes : [mesh]) paintMesh(target, null)
      return
    }
    paintMesh(mesh, faceIndex)
  }, [scheduleOverlayRebuild, stateRef, activePaintChannelRef, paintToolRef, paintBrushModeRef, paintColorFilamentIdRef, paintOnOverhangsRef, paintOverhangAngleRef, paintSmartAngleRef, paintHeightRangeRef, paintBrushRadiusRef, paintEdgeDetectionRef, selectedKeyRef, groupByKeyRef])
  const applyPaintStrokeRef = useRef(applyPaintStroke)
  applyPaintStrokeRef.current = applyPaintStroke

  /** Remove the ACTIVE channel's paint from the selected object's printed parts. */
  const clearSelectedPaint = useCallback(() => {
    const state = stateRef.current
    const channel = activePaintChannelRef.current
    const instance = activePlateRef.current?.instances.find((entry) => entry.key === selectedKeyRef.current)
    if (!state || !channel || !instance || instance.source.kind !== 'object') return
    recordHistoryRef.current?.()
    const stateKey = PAINT_CHANNEL_SPECS[channel].stateKey
    const channelPaint = state[stateKey] ?? (state[stateKey] = {})
    for (const part of instance.parts) {
      if (isNonRenderableThreeMfPartSubtype(part.subtype)) continue
      // An empty map means "no paint" — emitted so existing source paint is stripped.
      channelPaint[supportPaintKey(instance.objectId, part.componentObjectId)] = {}
    }
    const group = selectedKeyRef.current ? groupByKeyRef.current.get(selectedKeyRef.current) : null
    if (group) refreshPaintOverlays(group)
    regenerateActiveThumbnailRef.current?.()
  }, [refreshPaintOverlays, recordHistoryRef, stateRef, activePaintChannelRef, activePlateRef, selectedKeyRef, groupByKeyRef, regenerateActiveThumbnailRef])

  return {
    paintBrushMode,
    setPaintBrushMode,
    paintBrushModeRef,
    paintBrushRadius,
    setPaintBrushRadius,
    paintBrushRadiusRef,
    paintTool,
    setPaintTool,
    paintToolRef,
    paintSmartAngle,
    setPaintSmartAngle,
    paintHeightRange,
    setPaintHeightRange,
    paintEdgeDetection,
    setPaintEdgeDetection,
    paintOnOverhangs,
    setPaintOnOverhangs,
    paintOverhangAngle,
    setPaintOverhangAngle,
    paintColorFilamentId,
    setPaintColorFilamentId,
    paintColorFilamentIdRef,
    activePaintChannel,
    activePaintChannelRef,
    activePaintTool,
    effectivePaintCodes,
    refreshPaintOverlays,
    refreshPaintOverlaysRef,
    applyPaintStrokeRef,
    clearSelectedPaint
  }
}
