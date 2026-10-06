/**
 * Owns the live shader uniforms for per-plate filament changes and pause bands.
 * Mesh materials retain this ref across scene updates; changing a plate or its
 * sidecars updates the uniform values without rebuilding the scene.
 */
import { useEffect, useRef, type MutableRefObject } from 'react'
import * as THREE from 'three'
import {
  effectiveFilamentChanges,
  effectivePauses,
  type EditorPlate,
  type EditorState
} from './lib/editorModel'
import {
  FILAMENT_CHANGE_MAX_BANDS,
  LAYER_PAUSE_MAX_STRIPES,
  type LayerBandUniforms
} from './editorGeometry'

interface PlateBandUniformOptions {
  activePlate: EditorPlate | null
  /** Invalidates uniforms when an in-place plate sidecar edit updates editor state. */
  state: EditorState | null
  filamentColors: Record<number, string>
  resolveColorFilamentId: (id: number | null) => number | null
}

/** Return stable uniforms whose visible counts and colours follow the active plate. */
export function useEditorPlateBandUniforms({
  activePlate,
  state,
  filamentColors,
  resolveColorFilamentId
}: PlateBandUniformOptions): MutableRefObject<LayerBandUniforms> {
  const uniformsRef = useRef<LayerBandUniforms>({
    uFcCount: { value: 0 },
    uFcHeights: { value: new Array(FILAMENT_CHANGE_MAX_BANDS).fill(0) },
    uFcColors: { value: Array.from({ length: FILAMENT_CHANGE_MAX_BANDS }, () => new THREE.Color('#9aa4ad')) },
    uPauseCount: { value: 0 },
    uPauseHeights: { value: new Array(LAYER_PAUSE_MAX_STRIPES).fill(0) }
  })

  useEffect(() => {
    const uniforms = uniformsRef.current
    const changes = activePlate
      ? [...effectiveFilamentChanges(activePlate)].sort((left, right) => left.z - right.z).slice(0, FILAMENT_CHANGE_MAX_BANDS)
      : []
    uniforms.uFcCount.value = changes.length
    changes.forEach((change, index) => {
      uniforms.uFcHeights.value[index] = change.z
      const colorFilamentId = resolveColorFilamentId(change.filamentId)
      uniforms.uFcColors.value[index]!.set(
        (colorFilamentId != null && filamentColors[colorFilamentId]) || '#9aa4ad'
      )
    })

    const pauses = activePlate ? effectivePauses(activePlate).slice(0, LAYER_PAUSE_MAX_STRIPES) : []
    uniforms.uPauseCount.value = pauses.length
    pauses.forEach((pause, index) => {
      uniforms.uPauseHeights.value[index] = pause.z
    })
  }, [activePlate, state, filamentColors, resolveColorFilamentId])

  return uniformsRef
}
