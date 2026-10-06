/**
 * Builds the active plate's bed and instance groups for the viewport hook.
 * Beds share one tagged constructor across live and staged roots; an obsolete async instance
 * is disposed before it can enter either root. The hook owns cancellation and scene publication.
 */
import * as THREE from 'three'
import { createBedModelObject } from './bedModel'
import { createPreviewPlateSurface, disposeObject3D } from './threeMfScene'
import { nextPaint, restObjectOnBed, setObjectPrintedStyle } from '../editorGeometry'
import type { EditorInstance, EditorPlate } from './editorModel'

export interface PlateBedSurfaceInput {
  bed: EditorPlate['bed']
  width: number
  depth: number
  centerX: number
  centerY: number
  model: THREE.BufferGeometry | null
  texture: THREE.Texture | null
  signature: string
}

/** Construct the same tagged bed for the live and detached scene roots. */
export function createPlateBedSurface(input: PlateBedSurfaceInput): THREE.Object3D {
  const hasAppearance = Boolean(input.model || input.texture)
  const surface = createPreviewPlateSurface({
    width: input.width,
    depth: input.depth,
    centerX: input.centerX,
    centerY: input.centerY,
    excludeAreas: input.bed.excludeAreas,
    showSurfaceFill: !hasAppearance,
    axisLabelEdge: hasAppearance ? 'rear' : 'front'
  })
  // Tag for thumbnail exclusion and for an incremental build's bed-signature comparison.
  surface.userData.isBedSurface = true
  surface.userData.bedSignature = input.signature
  if (hasAppearance) {
    surface.add(createBedModelObject({
      geometry: input.model,
      texture: input.texture,
      originX: input.centerX - input.width / 2,
      originY: input.centerY - input.depth / 2,
      width: input.width,
      depth: input.depth
    }))
  }
  return surface
}

/** Replace a stale visible bed immediately while an atomic model rebuild is still in flight. */
export function ensureLiveBed(plateRoot: THREE.Group, input: PlateBedSurfaceInput): void {
  const existing = plateRoot.children.find((child) => child.userData?.isBedSurface)
  if (existing?.userData.bedSignature === input.signature) return
  if (existing) {
    disposeObject3D(existing)
    plateRoot.remove(existing)
  }
  plateRoot.add(createPlateBedSurface(input))
}

/** Count the real download units, including each solid in a multi-part import. */
export function countPlateLoadUnits(plate: EditorPlate): number {
  return plate.instances.reduce((sum, instance) => sum + (
    instance.source.kind === 'import'
      ? (instance.parts.length > 1 ? instance.parts.length : 1)
      : instance.parts.length
  ), 0)
}

/** Warm shared geometry caches without tying their requests to this scene build's lifetime. */
export function prefetchPlateGeometry(
  plate: EditorPlate,
  fetchGeometry: (entryPath: string) => Promise<Map<number, THREE.BufferGeometry>>,
  fetchImportGeometry: (importId: string, partIndex?: number) => Promise<THREE.BufferGeometry>,
  onLoaded: () => void
): void {
  for (const instance of plate.instances) {
    if (instance.source.kind === 'import') {
      const importId = instance.source.importId
      if (instance.parts.length > 1) {
        instance.parts.forEach((_part, index) => fetchImportGeometry(importId, index).then(onLoaded, onLoaded))
      } else {
        fetchImportGeometry(importId).then(onLoaded, onLoaded)
      }
    } else {
      for (const part of instance.parts) fetchGeometry(part.entryPath).then(onLoaded, onLoaded)
    }
  }
}

interface BuildInstanceContext {
  plate: EditorPlate
  target: THREE.Group
  incremental: boolean
  buildInstanceGroup: (instance: EditorInstance) => Promise<THREE.Group | null>
  isInstancePrinted: (instance: EditorInstance) => boolean
  onIncrementalGroup: (key: string, group: THREE.Group) => void
  setViewerError: (message: string) => void
  isCancelled: () => boolean
}

/** Build each model with a paint opportunity between slow objects; null means superseded. */
export async function buildPlateInstances(context: BuildInstanceContext): Promise<Map<string, THREE.Group> | null> {
  const builtGroups = new Map<string, THREE.Group>()
  const instances = context.plate.instances
  let lastPaintAt = performance.now()
  for (let instanceIndex = 0; instanceIndex < instances.length; instanceIndex += 1) {
    const instance = instances[instanceIndex]!
    try {
      const group = await context.buildInstanceGroup(instance)
      if (context.isCancelled()) {
        if (group) disposeObject3D(group)
        return null
      }
      if (group) {
        // Rest the visible geometry and persist its corrected height into the source instance.
        restObjectOnBed(group)
        instance.position.z = group.position.z
        setObjectPrintedStyle(group, context.isInstancePrinted(instance))
        context.target.add(group)
        builtGroups.set(instance.key, group)
        if (context.incremental) {
          // A later rebuild now sees a nonempty live plate and swaps atomically.
          context.onIncrementalGroup(instance.key, group)
        }
      }
    } catch (error) {
      if (context.isCancelled()) return null
      context.setViewerError(error instanceof Error ? error.message : 'Unable to load model geometry.')
    }
    // Yield near frame cadence so incremental loads paint and input stays responsive.
    if (instanceIndex < instances.length - 1 && performance.now() - lastPaintAt > 24) {
      await nextPaint()
      if (context.isCancelled()) return null
      lastPaintAt = performance.now()
    }
  }
  return context.isCancelled() ? null : builtGroups
}
