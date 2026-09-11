/**
 * Maps a sliced plate's baked layer events onto the layers parsed from its G-code preview.
 *
 * The sliced G-code's reserved tags are authoritative for placement because sequential printing
 * can repeat the same Z heights for each object. The 3MF sidecar supplies the material identity and
 * colour that the tags omit. Height matching is retained only as a fallback for older/foreign
 * G-code without those tags.
 */

export interface GcodeLayerEventMarker {
  /** Zero-based preview-slider layer. */
  layer: number
  /** Actual top Z of the matched G-code layer, in mm. */
  z: number
  pauseCount: number
  filamentChanges: Array<{ filamentId: number | null; color: string | null }>
}

export interface GcodeLayerEventsInput {
  pauses?: ReadonlyArray<{ z: number }>
  filamentChanges?: ReadonlyArray<{ z: number; filamentId: number }>
  projectFilaments?: ReadonlyArray<{ id: number; color: string | null }>
}

export interface GcodeLayerEventOccurrences {
  pauseLayers?: readonly number[]
  filamentChangeLayers?: readonly number[]
}

/** Format the greatest parsed Z so the height chip reserves space for every preview layer. */
export function maxGcodeLayerHeightReference(layerZ: readonly number[]): string | null {
  let maximum = Number.NEGATIVE_INFINITY
  for (const z of layerZ) {
    if (Number.isFinite(z) && z > maximum) maximum = z
  }
  return Number.isFinite(maximum) ? `${maximum.toFixed(2)} mm` : null
}

/** Build one slider marker per layer, combining coincident pauses and filament changes. */
export function buildGcodeLayerEventMarkers(
  layerZ: readonly number[],
  events: GcodeLayerEventsInput,
  occurrences: GcodeLayerEventOccurrences = {}
): GcodeLayerEventMarker[] {
  if (layerZ.length === 0) return []

  const colors = new Map(events.projectFilaments?.map((filament) => [filament.id, filament.color]) ?? [])
  const markers = new Map<number, GcodeLayerEventMarker>()
  const markerFor = (eventZ: number | undefined, actualLayer: number | undefined): GcodeLayerEventMarker | null => {
    const layer = actualLayer != null && actualLayer >= 0 && actualLayer < layerZ.length
      ? actualLayer
      : eventZ != null && Number.isFinite(eventZ)
        ? nearestLayerIndex(layerZ, eventZ)
        : -1
    if (layer < 0) return null
    let marker = markers.get(layer)
    if (!marker) {
      marker = { layer, z: layerZ[layer]!, pauseCount: 0, filamentChanges: [] }
      markers.set(layer, marker)
    }
    return marker
  }

  const pauses = events.pauses ?? []
  const pauseLayers = occurrences.pauseLayers ?? []
  for (let index = 0; index < Math.max(pauses.length, pauseLayers.length); index += 1) {
    const marker = markerFor(pauses[index]?.z, pauseLayers[index])
    if (marker) marker.pauseCount += 1
  }
  const changes = events.filamentChanges ?? []
  const changeLayers = occurrences.filamentChangeLayers ?? []
  for (let index = 0; index < Math.max(changes.length, changeLayers.length); index += 1) {
    const change = changes[index]
    const marker = markerFor(change?.z, changeLayers[index])
    if (marker) {
      marker.filamentChanges.push({
        filamentId: change?.filamentId ?? null,
        color: change ? colors.get(change.filamentId) ?? null : null
      })
    }
  }

  return [...markers.values()].sort((a, b) => a.layer - b.layer)
}

/** Locate the closest actual extrusion layer without assuming uniform or monotonic layer heights. */
function nearestLayerIndex(layerZ: readonly number[], target: number): number {
  let nearest = -1
  let nearestDistance = Number.POSITIVE_INFINITY
  for (let index = 0; index < layerZ.length; index++) {
    const distance = Math.abs(layerZ[index]! - target)
    if (distance < nearestDistance) {
      nearest = index
      nearestDistance = distance
    }
  }
  return nearest
}
