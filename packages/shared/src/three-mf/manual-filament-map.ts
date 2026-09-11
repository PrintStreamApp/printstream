/**
 * Manual multi-nozzle filament mapping shared by the browser 3MF author and slicer runtime.
 *
 * Bambu stores runtime nozzle ids in `filament_nozzle_map`, but its slicer CLI requires a
 * 1-based slicer-extruder map both in each plate's metadata and on `--filament-map`. Keeping the
 * conversion here makes the browser-authored project and the runtime flag exact mirrors.
 *
 * This module is dependency-free and archive-agnostic: callers own JSON/XML entry loading and ZIP
 * writes. Values are runtime nozzle ids throughout and are inverted through
 * `physical_extruder_map` exactly once.
 */
import { escapeXmlAttribute } from './xml-write.js'

/** The request-side shape used by a slice target. */
export interface ManualFilamentMapping {
  projectFilamentId: number
  toolheadId?: string | null
}

/** The already-parsed shape used by metadata readers. */
export interface ManualFilamentMetadata {
  nozzleId: number | null
}

export type ManualFilamentAssignmentSource =
  | ReadonlyArray<ManualFilamentMapping>
  | ReadonlyMap<number, ManualFilamentMetadata>

/** 1-based slicer extruder used for an unassigned filament under Manual mode. */
const DEFAULT_SLICER_EXTRUDER = '1'

/**
 * Convert requested runtime nozzle ids into BambuStudio's complete 1-based extruder map.
 *
 * Returns null for a single-nozzle project or when no filament explicitly names a nozzle. The
 * returned array covers every known filament slot because BambuStudio indexes it without a bounds
 * check; an unassigned support material therefore receives extruder 1 rather than leaving a hole.
 */
export function buildManualNozzleAssignment(
  settings: Record<string, unknown>,
  source: ManualFilamentAssignmentSource
): { filament_map_mode: 'Manual'; filament_map: string[] } | null {
  const physicalExtruderMap = parseNozzleIdList(settings.physical_extruder_map)
  if (physicalExtruderMap.length <= 1) return null
  const filamentMap = Array.isArray(settings.filament_map)
    ? settings.filament_map.map((value) => String(value))
    : []
  let assignedAny = false
  for (const [projectFilamentId, nozzleId] of nozzleAssignments(source)) {
    const index = projectFilamentId - 1
    if (index < 0 || nozzleId == null) continue
    const slicerExtruder = physicalExtruderMap.indexOf(nozzleId)
    if (slicerExtruder < 0) continue
    while (filamentMap.length <= index) filamentMap.push(DEFAULT_SLICER_EXTRUDER)
    filamentMap[index] = String(slicerExtruder + 1)
    assignedAny = true
  }
  if (!assignedAny) return null

  const sourceSlotCount = Array.isArray(source)
    ? Math.max(0, ...source.map((mapping) => mapping.projectFilamentId))
    : Math.max(0, ...source.keys())
  const filamentCount = Math.max(
    filamentMap.length,
    sourceSlotCount,
    stringArray(settings.filament_colour).length,
    stringArray(settings.filament_type).length
  )
  while (filamentMap.length < filamentCount) filamentMap.push(DEFAULT_SLICER_EXTRUDER)
  for (let index = 0; index < filamentMap.length; index++) {
    const value = filamentMap[index]
    if (value == null || value.trim() === '' || !Number.isFinite(Number.parseInt(value, 10))) {
      filamentMap[index] = DEFAULT_SLICER_EXTRUDER
    }
  }
  return { filament_map_mode: 'Manual', filament_map: filamentMap }
}

/**
 * Force the authored manual map into every plate's `model_settings.config` block.
 *
 * The CLI reads the mode here, not from `project_settings.config`. The map must additionally be
 * passed through `--filament-map`; this function only keeps the project itself self-consistent.
 */
export function applyManualFilamentMapToModelSettings(modelSettingsXml: string, filamentMaps: string): string {
  const inject = `<metadata key="filament_map_mode" value="Manual"/>\n        <metadata key="filament_maps" value="${escapeXmlAttribute(filamentMaps)}"/>`
  return modelSettingsXml.replace(/<plate>([\s\S]*?)<\/plate>/g, (_block, inner: string) => {
    const cleaned = inner
      .replace(/\s*<metadata key="filament_map_mode" value="[^"]*"\s*\/>/g, '')
      .replace(/\s*<metadata key="filament_maps" value="[^"]*"\s*\/>/g, '')
    return `<plate>\n        ${inject}${cleaned}</plate>`
  })
}

/** Remove a previous manual assignment when the final target uses automatic/single-nozzle routing. */
export function clearManualFilamentMapFromProjectSettings(
  settings: Record<string, unknown>
): Record<string, unknown> {
  const next = { ...settings }
  delete next.filament_map_mode
  delete next.filament_map
  return next
}

/** Remove every plate-local half of a previous manual assignment. */
export function clearManualFilamentMapFromModelSettings(modelSettingsXml: string): string {
  return modelSettingsXml.replace(/\s*<metadata\b[^>]*\/>/g, (element) => {
    const key = /\bkey="([^"]*)"/.exec(element)?.[1]
    return key === 'filament_map_mode' || key === 'filament_maps' ? '' : element
  })
}

/** Whether any plate still asks the engine to use a manual filament map. */
export function modelSettingsCarriesManualFilamentMap(modelSettingsXml: string): boolean {
  for (const match of modelSettingsXml.matchAll(/<metadata\b[^>]*\/>/g)) {
    const element = match[0]
    if (/\bkey="filament_map_mode"/.test(element) && /\bvalue="Manual"/i.test(element)) return true
  }
  return false
}

/**
 * Read the complete manual filament map a prepared project already authored.
 *
 * Invalid or short maps fail loudly before BambuStudio can perform its unchecked vector read and
 * select a garbage extruder. Automatic modes return null and require no CLI flag.
 */
export function readAuthoredManualFilamentMap(settings: Record<string, unknown>): string[] | null {
  const rawMode = Array.isArray(settings.filament_map_mode)
    ? settings.filament_map_mode[0]
    : settings.filament_map_mode
  if (typeof rawMode !== 'string' || rawMode.trim().toLowerCase() !== 'manual') return null

  const map = stringArray(settings.filament_map).map((entry) => entry.trim())
  const filamentCount = Math.max(
    stringArray(settings.filament_settings_id).length,
    stringArray(settings.filament_colour).length,
    stringArray(settings.filament_type).length,
    stringArray(settings.filament_nozzle_map).length
  )
  if (map.length === 0 || map.length < filamentCount) {
    throw new Error(`The prepared project has a manual filament map for ${map.length} of ${filamentCount} material slots.`)
  }
  if (map.some((entry) => !/^\d+$/.test(entry) || Number.parseInt(entry, 10) < 1)) {
    throw new Error('The prepared project has an invalid manual filament map.')
  }
  const extruderCount = parseNozzleIdList(settings.physical_extruder_map).length
  if (extruderCount > 0 && map.some((entry) => Number.parseInt(entry, 10) > extruderCount)) {
    throw new Error('The prepared project maps a filament to an extruder this machine does not have.')
  }
  return map
}

function nozzleAssignments(source: ManualFilamentAssignmentSource): Array<[number, number | null]> {
  if (Array.isArray(source)) {
    const mappings = source as ReadonlyArray<ManualFilamentMapping>
    return mappings.map((mapping) => [mapping.projectFilamentId, parseToolheadNozzleId(mapping.toolheadId)])
  }
  const metadata = source as ReadonlyMap<number, ManualFilamentMetadata>
  return [...metadata.entries()].map(([projectFilamentId, filament]) => [projectFilamentId, filament.nozzleId])
}

function parseToolheadNozzleId(value: string | null | undefined): number | null {
  const match = value?.match(/^nozzle-(\d+)$/)
  const nozzleId = Number.parseInt(match?.[1] ?? '', 10)
  return Number.isInteger(nozzleId) && nozzleId >= 0 ? nozzleId : null
}

function parseNozzleIdList(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => Number.parseInt(String(entry), 10))
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => (typeof entry === 'string' ? entry : ''))
}
