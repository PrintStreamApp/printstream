/**
 * Resolves an editor plate's baked filament-to-nozzle assignments for placement checks.
 * The archive is keyed by source plate index, while live plate indices change after reorder;
 * session-added plates have no baked nozzle assignments.
 */
import type { EditorPlate } from './editorModel'

interface SourcePlateNozzles {
  index: number
  filaments: ReadonlyArray<{ id: number; nozzleId?: number | null }>
}

/** Use the active plate's source identity to read runtime nozzle ids from the 3MF index. */
export function editorFilamentNozzleMap(
  activePlate: Pick<EditorPlate, 'sourcePlateIndex'> | null,
  sourcePlates: ReadonlyArray<SourcePlateNozzles> | null | undefined
): Map<number, number> {
  const sourceIndex = activePlate?.sourcePlateIndex
  const sourcePlate = sourceIndex != null
    ? sourcePlates?.find((plate) => plate.index === sourceIndex)
    : undefined
  const map = new Map<number, number>()
  for (const filament of sourcePlate?.filaments ?? []) {
    if (typeof filament.nozzleId === 'number') map.set(filament.id, filament.nozzleId)
  }
  return map
}

/** Include both the object's material and every part's material in its reach demand. */
export function editorInstanceNozzles(
  instance: { filamentId: number | null; parts: ReadonlyArray<{ filamentId: number | null }> },
  filamentNozzles: ReadonlyMap<number, number>
): Set<number> {
  const nozzles = new Set<number>()
  const addFilament = (filamentId: number | null) => {
    if (filamentId == null) return
    const nozzle = filamentNozzles.get(filamentId)
    if (nozzle != null) nozzles.add(nozzle)
  }
  addFilament(instance.filamentId)
  for (const part of instance.parts) addFilament(part.filamentId)
  return nozzles
}
