/**
 * Owns the Measure tool's two picked features and derived result.
 * The viewport publishes picks through a stable ref; the overlay reads the
 * resulting state and publishes circle-centre targets for touch hit testing.
 * Leaving Measure or changing plates discards the current measurement.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type * as THREE from 'three'
import { getMeasurement } from './lib/measureBetween'
import type { MeasurePick } from './lib/editorMeasurePicking'
import { sameMeasureFeature } from './lib/measureFeatures'
import type { GizmoMode } from './editorGeometry'

/** Return Measure picks, result, and stable refs shared with the viewport and overlay. */
export function useEditorMeasurement(mode: GizmoMode, activePlateIndex: number) {
  const [measurePoints, setMeasurePoints] = useState<MeasurePick[]>([])
  const measurePointsRef = useRef<MeasurePick[]>([])
  measurePointsRef.current = measurePoints
  const addMeasurePointRef = useRef<((pick: MeasurePick) => void) | null>(null)

  // A tap has no hover path, so the viewport raycasts these mounted centre markers directly.
  const measureCentreTargetsRef = useRef<Array<{ object: THREE.Object3D; slot: number }>>([])

  /**
   * Match Studio's two-slot selection: a third new pick replaces the second, preserving the
   * first as a datum. Re-picking either slot deselects it and shifts a surviving second to first.
   */
  addMeasurePointRef.current = (pick) => {
    setMeasurePoints((previous) => {
      const matches = (existing: MeasurePick) => sameMeasureFeature(existing.feature, pick.feature)
      const [first, second] = previous
      if (!first) return [pick]
      if (!second) return matches(first) ? [] : [first, pick]
      if (matches(second)) return [first]
      if (matches(first)) return [second]
      return [first, pick]
    })
  }

  useEffect(() => {
    if (mode !== 'measure') setMeasurePoints([])
  }, [mode])

  useEffect(() => {
    setMeasurePoints([])
  }, [activePlateIndex])

  // A selected circle measures from its rim. Its centre is a separate pick, so the panel and
  // overlay can answer both questions from the same visible circle.
  const measureResult = useMemo(() => {
    const [first, second] = measurePoints
    if (!first || !second) return null
    return getMeasurement(first.feature, second.feature)
  }, [measurePoints])

  /** Clearing the first slot promotes the second, matching a click on the first feature. */
  const resetSlot = useCallback((slot: number) => {
    setMeasurePoints((current) => slot === 0 ? current.slice(1) : current.slice(0, 1))
  }, [])

  const clear = useCallback(() => { setMeasurePoints([]) }, [])

  return {
    measurePoints,
    setMeasurePoints,
    measurePointsRef,
    addMeasurePointRef,
    measureCentreTargetsRef,
    measureResult,
    resetSlot,
    clear
  }
}
