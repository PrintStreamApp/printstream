/**
 * Owns optional viewport bed resources for one machine/engine identity. A new selection hides
 * the previous assets immediately; slow or cancelled loads can never paint a different bed.
 * Rendered beds clone these resources, so cleanup may dispose the originals independently.
 */
import { useEffect, useState } from 'react'
import type { BufferGeometry, Texture } from 'three'
import { loadBedModelGeometry, loadBedTexture } from './lib/bedModel'

interface BedAppearance {
  geometry: BufferGeometry | null
  texture: Texture | null
}
interface BedAppearanceInput {
  enabled: boolean
  printerModel?: string
  slicerTargetId: string | null
  machineProfileId: string | null
  updatedAt?: string | null
  basePath?: string
}
const EMPTY: BedAppearance = { geometry: null, texture: null }

/** Load both optional assets; each loader handles unavailable resources with a null result. */
async function loadAppearance(input: BedAppearanceInput, signal: AbortSignal): Promise<BedAppearance> {
  const [geometry, texture] = await Promise.all([
    loadBedModelGeometry({ ...input, printerModel: input.printerModel!, signal }),
    input.basePath ? Promise.resolve(null) : loadBedTexture({ machineProfileId: input.machineProfileId, signal })
  ])
  return { geometry, texture }
}

/** Dispose originals once the owner changes or an obsolete request finishes. */
function disposeAppearance(value: BedAppearance): void {
  value.geometry?.dispose()
  value.texture?.dispose()
}

/** Returns only resources matching the current selection, or a plain-grid fallback while loading. */
export function useBedAppearance(input: BedAppearanceInput, load = loadAppearance): BedAppearance {
  const { enabled, printerModel, slicerTargetId, machineProfileId, updatedAt, basePath } = input
  const key = JSON.stringify([enabled, printerModel, slicerTargetId, machineProfileId, updatedAt, basePath])
  const [loaded, setLoaded] = useState<{ key: string; value: BedAppearance } | null>(null)

  useEffect(() => {
    // Forget disposed assets even when the user switches back before the next load completes.
    setLoaded(null)
    if (!enabled || !printerModel) return
    const controller = new AbortController()
    let owned: BedAppearance | null = null
    async function fetchAppearance() {
      try {
        const value = await load({ enabled, printerModel, slicerTargetId, machineProfileId, updatedAt, basePath }, controller.signal)
        if (controller.signal.aborted) {
          disposeAppearance(value)
          return
        }
        owned = value
        setLoaded({ key, value })
      } catch (error) {
        if (!controller.signal.aborted) console.warn('Unable to load editor build plate', error)
      }
    }
    void fetchAppearance()
    return () => {
      controller.abort()
      if (owned) disposeAppearance(owned)
    }
  }, [enabled, printerModel, slicerTargetId, machineProfileId, updatedAt, basePath, key, load])

  return loaded?.key === key ? loaded.value : EMPTY
}
