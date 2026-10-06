/**
 * Owns the editable Cut panel configuration and its geometry-dependent limits.
 * Offset stays raw while the user types; previews and commits read its clamped
 * value. Groove preferences survive object changes, while the viewport seeds
 * depth and width once per selected object through grooveSizedForRef.
 */
import { useMemo, useRef, useState } from 'react'
import { connectorSizeLimitsForSize } from './lib/cutConnectors'
import {
  grooveSizeLimitsForSize,
  GROOVE_CUT_DEFAULTS,
  type CutAxis,
  type CutHalfOrientation,
  type CutMode,
  type GrooveCut
} from './lib/meshCut'

/** Return Cut form state, bounded preview values, and per-object groove sizing identity. */
export function useEditorCutConfiguration() {
  const [cutAxis, setCutAxis] = useState<CutAxis>('z')
  const [cutOffset, setCutOffset] = useState(0)
  const [cutRange, setCutRange] = useState<{ min: number; max: number } | null>(null)
  const [cutKeepUpper, setCutKeepUpper] = useState(true)
  const [cutKeepLower, setCutKeepLower] = useState(true)
  // Keep orientation is the established default for both halves. Changing it implicitly would
  // change cuts users already understand, even though Studio defaults the upper half differently.
  const [cutOrientUpper, setCutOrientUpper] = useState<CutHalfOrientation>('keep')
  const [cutOrientLower, setCutOrientLower] = useState<CutHalfOrientation>('keep')
  const [cutting, setCutting] = useState(false)
  const [cutMode, setCutMode] = useState<CutMode>('plane')
  const [groove, setGroove] = useState<GrooveCut>(() => ({ depth: 4, width: 16, ...GROOVE_CUT_DEFAULTS }))
  const [cutObjectSize, setCutObjectSize] = useState<{ x: number; y: number; z: number } | null>(null)
  const grooveSizedForRef = useRef<string | null>(null)

  const clampedCutOffset = cutRange ? Math.min(Math.max(cutOffset, cutRange.min), cutRange.max) : cutOffset
  const grooveSizeLimits = useMemo(
    () => grooveSizeLimitsForSize(cutObjectSize ?? { x: 0, y: 0, z: 0 }),
    [cutObjectSize]
  )
  // A connector is a peg through the cut face, so its range differs from a groove channel.
  // It also accepts an unknown object size without clamping the connector defaults on open.
  const connectorSizeLimits = useMemo(() => connectorSizeLimitsForSize(cutObjectSize), [cutObjectSize])

  return {
    cutAxis, setCutAxis,
    cutOffset, setCutOffset,
    cutRange, setCutRange,
    cutKeepUpper, setCutKeepUpper,
    cutKeepLower, setCutKeepLower,
    cutOrientUpper, setCutOrientUpper,
    cutOrientLower, setCutOrientLower,
    cutting, setCutting,
    cutMode, setCutMode,
    groove, setGroove,
    cutObjectSize, setCutObjectSize,
    grooveSizedForRef,
    clampedCutOffset,
    grooveSizeLimits,
    connectorSizeLimits
  }
}
