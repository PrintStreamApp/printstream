/**
 * Track one editor paint stroke across pointer events. The viewport owns the
 * shared raycaster and history boundary; `editorPaintPicking` supplies live mesh
 * targets and hits. This module owns sampling and contact continuity. Reset on
 * pointer end or scene teardown.
 */
import * as THREE from 'three'
import type { PaintToolType } from '../editorGeometry.js'

export type PaintHit = {
  mesh: THREE.Mesh
  point: THREE.Vector3
  normal: THREE.Vector3
  faceIndex: number | null
}

type Position = { x: number; y: number }

type Options = {
  getTool: () => PaintToolType
  getTargets: () => THREE.Mesh[]
  hitAt: (x: number, y: number, targets: THREE.Mesh[]) => PaintHit | null
  apply: (hit: PaintHit, phase: 'down' | 'move', previousPoint?: THREE.Vector3 | null) => void
}

// Each raycast follows the surface. The brush sweeps between consecutive hits.
const SAMPLE_SPACING_PX = 3
const MAX_SAMPLES = 48

/** Return live stroke handlers whose callbacks read current scene refs. */
export function createEditorPaintStroke({ getTool, getTargets, hitAt, apply }: Options) {
  let active = false
  let anchor: Position | null = null
  let lastHit: { mesh: THREE.Mesh; point: THREE.Vector3 } | null = null

  const samplesTo = (x: number, y: number): Position[] => {
    if (!anchor) return [{ x, y }]
    const travel = Math.hypot(x - anchor.x, y - anchor.y)
    const steps = Math.min(Math.ceil(travel / SAMPLE_SPACING_PX), MAX_SAMPLES)
    if (steps <= 1) return [{ x, y }]

    const samples: Position[] = []
    for (let step = 1; step <= steps; step += 1) {
      const fraction = step / steps
      samples.push({
        x: anchor.x + (x - anchor.x) * fraction,
        y: anchor.y + (y - anchor.y) * fraction
      })
    }
    return samples
  }

  return {
    get active() { return active },
    /** Seed the first contact so the first move sweeps from pointer-down. */
    start(hit: PaintHit, x: number, y: number) {
      active = true
      anchor = { x, y }
      lastHit = { mesh: hit.mesh, point: hit.point.clone() }
      apply(hit, 'down')
    },
    /** Raycast interpolated samples and break the sweep on misses or mesh changes. */
    move(x: number, y: number): PaintHit | null {
      const targets = getTargets()
      const tool = getTool()
      const sweeps = tool === 'circle' || tool === 'sphere'
      const samples = sweeps ? samplesTo(x, y) : [{ x, y }]
      let finalHit: PaintHit | null = null

      for (const sample of samples) {
        const hit = hitAt(sample.x, sample.y, targets)
        if (!hit) {
          lastHit = null
          continue
        }
        const previous = sweeps && lastHit?.mesh === hit.mesh ? lastHit.point : null
        apply(hit, 'move', previous)
        lastHit = { mesh: hit.mesh, point: hit.point.clone() }
        finalHit = hit
      }
      anchor = { x, y }
      return finalHit
    },
    /** Also called during teardown so a stale contact never reaches a later scene. */
    reset() {
      active = false
      anchor = null
      lastHit = null
    }
  }
}
