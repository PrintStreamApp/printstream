/**
 * Owns connector placement, shared settings, validity, and live scene targets for the Cut tool.
 * World-space connector positions are cleared on axis/object changes and reseated when the plane
 * moves. Dovetail mode hides connectors without erasing the user's plane-cut setup.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import * as THREE from 'three'
import { toast } from '../../lib/toast'
import type { GizmoMode } from './editorGeometry'
import type { CutAxis, CutMode } from './lib/meshCut'
import { nextInstanceKey } from './lib/editorModel'
import {
  CONNECTOR_DEFAULTS,
  findConnectorProblems,
  isPointInsideSoup,
  type ConnectorSettings,
  type CutConnector
} from './lib/cutConnectors'

interface CutConnectorSessionOptions {
  gizmoMode: GizmoMode
  selectedKey: string | null
  cutMode: CutMode
  cutAxis: CutAxis
  clampedCutOffset: number
  setCutAxis: Dispatch<SetStateAction<CutAxis>>
}

type ConnectorEdit =
  | { kind: 'add'; worldPoint: THREE.Vector3 }
  | { kind: 'remove'; id: string }

/** Keep Cut connector setup and pointer targets in step with the chosen object and plane. */
export function useEditorCutConnectorSession(options: CutConnectorSessionOptions) {
  const { gizmoMode, selectedKey, cutMode, cutAxis, clampedCutOffset, setCutAxis } = options

  // Settings are shared by all pegs. Placement varies per peg, but editing the settings changes
  // every existing connector so the panel never promises a joint that the scene will not cut.
  const [cutConnectors, setCutConnectors] = useState<CutConnector[]>([])
  const [cutConnectorMode, setCutConnectorMode] = useState(false)
  const [cutConnectorFace, setCutConnectorFace] = useState<'lower' | 'upper'>('lower')
  const [connectorSettings, setConnectorSettings] = useState<ConnectorSettings>({ ...CONNECTOR_DEFAULTS })
  const [cutSoup, setCutSoup] = useState<Float32Array | null>(null)

  // Connectors and pointer clipping apply only to a plane cut. Returning from Dovetail resumes the
  // placement session, while leaving the Cut tool clears it entirely.
  const placingConnectors = cutConnectorMode && cutMode === 'plane'
  const cutConnectorModeRef = useRef(false)
  cutConnectorModeRef.current = placingConnectors && gizmoMode === 'cut'
  const activeConnectors = useMemo(
    () => (cutMode === 'plane' ? cutConnectors : []),
    [cutMode, cutConnectors]
  )

  const cutConnectorTargetsRef = useRef<{
    plane: THREE.Object3D | null
    /** A hit on the visible section proves the point is on the cut face. */
    section: THREE.Object3D | null
    markers: THREE.Object3D[]
  }>({ plane: null, section: null, markers: [] })
  const cutPlaneMeshRef = useRef<THREE.Mesh | null>(null)
  const connectorGhostRef = useRef<THREE.Mesh | null>(null)

  // The soup is captured once per object or axis change. Cache containment by position, and drop
  // the cache with the soup so a stale inside answer cannot permit an invalid connector cut.
  const insideCacheRef = useRef(new Map<string, boolean>())
  useEffect(() => { insideCacheRef.current.clear() }, [cutSoup])
  const activeProblems = useMemo(() => {
    if (!cutSoup) return new Map()
    const cache = insideCacheRef.current
    return findConnectorProblems(activeConnectors, cutSoup, (connector) => {
      const key = `${connector.x},${connector.y},${connector.z}`
      const cached = cache.get(key)
      if (cached !== undefined) return cached
      const inside = isPointInsideSoup(cutSoup, connector)
      cache.set(key, inside)
      return inside
    })
  }, [activeConnectors, cutSoup])

  /** Refuse a click outside the section; Studio silently drops it, but the editor explains why. */
  const editCutConnectors = useCallback((edit: ConnectorEdit) => {
    if (edit.kind === 'remove') {
      setCutConnectors((current) => current.filter((entry) => entry.id !== edit.id))
      return
    }
    if (cutSoup && !isPointInsideSoup(cutSoup, edit.worldPoint)) {
      toast.error('Place connectors inside the cut face.')
      return
    }
    setCutConnectors((current) => [...current, {
      ...connectorSettings,
      id: nextInstanceKey(),
      x: edit.worldPoint.x,
      y: edit.worldPoint.y,
      z: edit.worldPoint.z
    }])
  }, [connectorSettings, cutSoup])
  const editCutConnectorsRef = useRef(editCutConnectors)
  editCutConnectorsRef.current = editCutConnectors

  const applyConnectorSettings = useCallback((next: ConnectorSettings) => {
    setConnectorSettings(next)
    setCutConnectors((current) => current.map((connector) => ({ ...connector, ...next })))
  }, [])
  const clearCutConnectors = useCallback(() => setCutConnectors([]), [])

  /** Move the pointer ghost directly so React does not re-render at pointer frequency. */
  const hoverCutConnector = useCallback((worldPoint: THREE.Vector3 | null) => {
    const ghost = connectorGhostRef.current
    if (!ghost) return
    if (!worldPoint) {
      ghost.visible = false
      return
    }
    ghost.position.copy(worldPoint)
    ghost.visible = true
  }, [])
  const hoverCutConnectorRef = useRef(hoverCutConnector)
  hoverCutConnectorRef.current = hoverCutConnector

  // The plane resets on every Cut-tool entry or object change. Connector settings and keep-side
  // choices persist, but world-space points cannot be carried onto an unrelated model.
  useEffect(() => {
    if (gizmoMode !== 'cut' || !selectedKey) return
    setCutAxis('z')
    setCutConnectors((current) => (current.length === 0 ? current : []))
    setCutConnectorMode(false)
    setCutConnectorFace('lower')
  }, [gizmoMode, selectedKey, setCutAxis])
  useEffect(() => {
    setCutConnectors((current) => (current.length === 0 ? current : []))
  }, [cutAxis])
  useEffect(() => {
    setCutConnectors((current) => {
      if (current.length === 0) return current
      const seated = current.map((connector) => ({ ...connector, [cutAxis]: clampedCutOffset }))
      return seated.every((connector, index) => connector[cutAxis] === current[index]![cutAxis]) ? current : seated
    })
  }, [clampedCutOffset, cutAxis])
  useEffect(() => {
    if (gizmoMode === 'cut') return
    setCutConnectors((current) => (current.length === 0 ? current : []))
    setCutConnectorMode(false)
  }, [gizmoMode])

  return {
    cutConnectors,
    setCutConnectorMode,
    cutConnectorFace,
    setCutConnectorFace,
    connectorSettings,
    cutSoup,
    setCutSoup,
    placingConnectors,
    activeConnectors,
    activeProblems,
    cutConnectorModeRef,
    cutConnectorTargetsRef,
    cutPlaneMeshRef,
    connectorGhostRef,
    editCutConnectorsRef,
    hoverCutConnectorRef,
    applyConnectorSettings,
    clearCutConnectors
  }
}
