/**
 * Captures save and slice thumbnails from current plate geometry. Live previews are refreshed only
 * for real editor state; synthetic exports may request bytes without repainting the plate strip.
 * The editor owns the renderer and scene refs, while each temporary group is disposed here.
 */
import * as THREE from 'three'
import { disposeObject3D } from './threeMfScene'
import type { EditorInstance, EditorPlate, EditorState } from './editorModel'
import type { PlateThumbnailRenderer } from './plateThumbnail'

export interface PlateThumbnailCaptureOptions {
  force?: boolean
  updateLive?: boolean
  /** Stable plate IDs, not position indices. */
  only?: ReadonlySet<number>
  signal?: AbortSignal
}

interface PlateThumbnailCaptureContext {
  renderer: PlateThumbnailRenderer
  buildInstanceGroup: (instance: EditorInstance) => Promise<THREE.Group | null>
  getLiveThumbnails: () => Readonly<Record<number, string>>
  getPendingScenePlates: () => ReadonlySet<number>
  setLiveThumbnail: (plateId: number, url: string) => void
}

/**
 * Select the opened plates and displaced archive positions that need new embedded thumbnails.
 * A displaced plate with a pending scene cannot render useful geometry yet.
 */
export function shouldCapturePlateThumbnail(
  plate: EditorPlate,
  options: PlateThumbnailCaptureOptions,
  liveThumbnails: Readonly<Record<number, string>>,
  pendingScenePlates: ReadonlySet<number>
): boolean {
  if (plate.index <= 0) return false
  if (options.only && !options.only.has(plate.plateId)) return false
  const displaced = plate.sourcePlateIndex !== plate.index
    && !pendingScenePlates.has(plate.plateId)
  return Boolean(options.force || liveThumbnails[plate.plateId] || displaced)
}

/**
 * Return fresh PNG bytes by plate position, skipping ordinary unopened plates whose archived
 * thumbnail is still valid. Cancellation stops the entire capture and disposes built meshes.
 * A render failure stays best-effort per plate and keeps its previous thumbnail.
 */
export async function captureEditorPlateThumbnails(
  current: EditorState,
  options: PlateThumbnailCaptureOptions,
  context: PlateThumbnailCaptureContext
): Promise<Array<{ plateIndex: number; png: string }>> {
  const out: Array<{ plateIndex: number; png: string }> = []
  for (const plate of current.plates) {
    options.signal?.throwIfAborted()
    if (!shouldCapturePlateThumbnail(
      plate,
      options,
      context.getLiveThumbnails(),
      context.getPendingScenePlates()
    )) {
      continue
    }

    const group = new THREE.Group()
    try {
      for (const instance of plate.instances) {
        options.signal?.throwIfAborted()
        const built = await context.buildInstanceGroup(instance)
        // Own the group before checking cancellation: an async build can finish after the abort.
        if (built) group.add(built)
        options.signal?.throwIfAborted()
      }
      options.signal?.throwIfAborted()
      const url = context.renderer.render(group, plate.bed)
      options.signal?.throwIfAborted()
      if (options.updateLive !== false) context.setLiveThumbnail(plate.plateId, url)
      const png = url.replace(/^data:image\/png;base64,/, '')
      if (png.length > 0) out.push({ plateIndex: plate.index, png })
    } catch (error) {
      options.signal?.throwIfAborted()
      console.warn('[editor] plate thumbnail capture failed', { plateId: plate.plateId, error })
    } finally {
      disposeObject3D(group)
    }
  }
  return out
}
