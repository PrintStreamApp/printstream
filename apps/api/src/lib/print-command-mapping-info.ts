/**
 * Slicer-parity mapping metadata for the Bambu `project_file` print command.
 *
 * BambuStudio's from-slicer send augments the `ams_mapping`/`ams_mapping_2`
 * arrays with `ams_mapping_info` (per-filament type/color/preset plus the
 * target nozzle) and, on dual-nozzle machines, `nozzles_info` (per-extruder
 * nozzle geometry). The AMS HT is the unit that needs this: unlike regular
 * AMS units it is not bound to a single extruder, so without the
 * filament-to-nozzle assignment the firmware cannot place HT trays in its
 * runtime mapping table — prints start and then fail with 0701-8012 ("Failed
 * to get AMS mapping table") at the first HT fetch (observed on both H2D and
 * H2C). Shapes mirror `SelectMachineDialog::get_ams_mapping_result` and
 * `build_nozzles_info`; nozzle id conventions follow BambuStudio's enums
 * (`filament_maps` values: 1 = left, 2 = right; wire `nozzleId`/`id`:
 * 0 = right, 1 = left).
 *
 * Everything here is fail-safe: missing or unreadable slice metadata yields
 * `null` and the dispatch falls back to sending the mapping arrays alone,
 * which is exactly BambuStudio's SD-card resend payload.
 */
import { amsTrayIndex, type PrinterStatus } from '@printstream/shared'
import { readEntry } from './three-mf-internal.js'

/** Per-filament and per-nozzle slice metadata read from a plate's `slice_info.config` block. */
export interface PlateSliceMappingSource {
  /** Filaments as sliced (1-based `id`, Bambu preset id in `trayInfoIdx`). */
  filaments: Array<{ id: number; type: string | null; color: string | null; trayInfoIdx: string | null }>
  /** Target extruder per project filament (1-based index): 1 = left, 2 = right. */
  filamentMaps: number[]
  /** Nozzle diameters in slicer config order (left first on dual-nozzle machines). */
  nozzleDiameters: number[]
  /** BambuStudio `NozzleVolumeType` codes per nozzle (0 standard, 1 high flow, 2 TPU high flow). */
  nozzleVolumeTypes: number[]
}

/** BambuStudio `get_nozzle_volume_type_cloud_string` equivalents. */
const NOZZLE_FLOW_WIRE_STRINGS: Record<number, string> = {
  0: 'standard_flow',
  1: 'high_flow',
  2: 'tpu_high_flow'
}

/**
 * Parse the mapping-relevant metadata for one plate out of a 3MF's
 * `Metadata/slice_info.config`. Returns `null` when the plate block is absent
 * or carries no filaments (an unsliced or gcode-only source).
 */
export function parsePlateSliceMappingSource(sliceInfoXml: string, plate: number): PlateSliceMappingSource | null {
  const plateBlocks = sliceInfoXml.match(/<plate\b[^>]*>[\s\S]*?<\/plate>/g) ?? []
  for (const block of plateBlocks) {
    const meta = new Map<string, string>()
    for (const match of block.matchAll(/<metadata\s+key="([^"]+)"\s+value="([^"]*)"\s*\/>/g)) {
      if (match[1] != null && match[2] != null) meta.set(match[1], match[2])
    }
    if (parseInt(meta.get('index') ?? '', 10) !== plate) continue

    const filaments: PlateSliceMappingSource['filaments'] = []
    for (const match of block.matchAll(/<filament\b([^/>]*)\/?>/g)) {
      const attrs = new Map<string, string>()
      for (const attr of (match[1] ?? '').matchAll(/([a-z_]+)="([^"]*)"/g)) {
        if (attr[1] != null && attr[2] != null) attrs.set(attr[1], attr[2])
      }
      const id = parseInt(attrs.get('id') ?? '', 10)
      if (!Number.isInteger(id) || id < 1) continue
      filaments.push({
        id,
        type: attrs.get('type') ?? null,
        color: attrs.get('color') ?? null,
        trayInfoIdx: attrs.get('tray_info_idx') ?? null
      })
    }
    if (filaments.length === 0) return null

    return {
      filaments,
      filamentMaps: integerList(meta.get('filament_maps')),
      nozzleDiameters: (meta.get('nozzle_diameters') ?? '')
        .split(',')
        .map((value) => Number.parseFloat(value.trim()))
        .filter((value) => Number.isFinite(value) && value > 0),
      nozzleVolumeTypes: integerList(meta.get('nozzle_volume_type'))
    }
  }
  return null
}

function integerList(value: string | undefined): number[] {
  if (!value) return []
  return value
    .trim()
    .split(/\s+/)
    .map((entry) => parseInt(entry, 10))
    .filter((entry) => Number.isInteger(entry))
}

/**
 * Widen a color to the wire's `RRGGBBAA` form (no `#`). Accepts the status
 * cache's normalized `#RRGGBB`, slice_info's `#RRGGBB(AA)`, and raw hex.
 * Unknown/absent colors become the empty string, matching BambuStudio's
 * default mapping-info entry.
 */
export function toWireTrayColor(color: string | null | undefined): string {
  if (!color) return ''
  const hex = color.replace(/^#/, '').trim().toUpperCase()
  if (/^[0-9A-F]{8}$/.test(hex)) return hex
  if (/^[0-9A-F]{6}$/.test(hex)) return `${hex}FF`
  return ''
}

/** Tray colors by global tray index, from the live printer status. */
export function trayColorsByIndex(status: PrinterStatus | null | undefined): Map<number, string> {
  const colors = new Map<number, string>()
  for (const unit of status?.ams ?? []) {
    for (const slot of unit.slots) {
      const wireColor = toWireTrayColor(slot.color)
      if (!wireColor) continue
      colors.set(amsTrayIndex(unit.type, unit.unitId, slot.slot), wireColor)
    }
  }
  return colors
}

export interface ProjectFileMappingInfoFields {
  /** `ams_mapping_info` entries, aligned with the `ams_mapping` array. */
  amsMappingInfo: Array<Record<string, unknown>> | null
  /** `nozzles_info` entries (dual-nozzle plates only). */
  nozzlesInfo: Array<Record<string, unknown>> | null
}

/**
 * Build the `ams_mapping_info` + `nozzles_info` wire fields for a dispatch.
 * Only dual-nozzle plates get them (BambuStudio's `build_nozzles_info` gate,
 * and the single-nozzle payload without them is proven in production); both
 * failing HT machines (H2D, H2C) are dual-nozzle.
 */
export function buildProjectFileMappingInfoFields(
  amsMapping: number[],
  source: PlateSliceMappingSource,
  trayColorByIndex: ReadonlyMap<number, string>
): ProjectFileMappingInfoFields {
  if (source.nozzleDiameters.length !== 2) return { amsMappingInfo: null, nozzlesInfo: null }

  const amsMappingInfo = amsMapping.map((trayIndex, filamentIndex) => {
    if (!Number.isInteger(trayIndex) || trayIndex < 0) {
      // Unmapped/pruned filament: BambuStudio's default entry.
      return { ams: -1, targetColor: '', filamentId: '', filamentType: '' }
    }
    const filament = source.filaments.find((entry) => entry.id === filamentIndex + 1)
    const entry: Record<string, unknown> = {
      ams: trayIndex,
      targetColor: trayColorByIndex.get(trayIndex) ?? '',
      filamentId: filament?.trayInfoIdx ?? '',
      filamentType: filament?.type ?? ''
    }
    const filamentMap = source.filamentMaps[filamentIndex]
    if (filamentMap === 1 || filamentMap === 2) {
      // filament_maps: 1 = left, 2 = right -> wire nozzleId: 1 = left, 0 = right.
      entry.nozzleId = filamentMap === 1 ? 1 : 0
    }
    entry.sourceColor = toWireTrayColor(filament?.color)
    return entry
  })

  // Config order is [left, right]; the wire id is 1 for left, 0 for right.
  const nozzlesInfo = source.nozzleDiameters.map((diameter, configIndex) => ({
    id: configIndex === 0 ? 1 : 0,
    type: null,
    flowSize: NOZZLE_FLOW_WIRE_STRINGS[source.nozzleVolumeTypes[configIndex] ?? 0] ?? 'standard_flow',
    diameter
  }))

  return { amsMappingInfo, nozzlesInfo }
}

/**
 * Resolve the slicer-parity mapping fields for a dispatch: read the source
 * 3MF's `slice_info.config`, parse the printed plate's block, and build the
 * wire fields against the printer's live tray colors. Fail-safe passthrough —
 * any gap (gcode source, no local copy, unreadable/absent slice metadata,
 * single-nozzle plate) yields nulls and the print command carries the mapping
 * arrays alone, never blocking a print.
 */
export async function resolveProjectFileMappingInfo(input: {
  sourceKind: '3mf' | 'gcode'
  localPath: string | null
  plate: number | null
  amsMapping: number[] | undefined
  status: PrinterStatus | null | undefined
}): Promise<ProjectFileMappingInfoFields> {
  const none: ProjectFileMappingInfoFields = { amsMappingInfo: null, nozzlesInfo: null }
  if (input.sourceKind !== '3mf' || !input.localPath || input.plate == null) return none
  if (!input.amsMapping || input.amsMapping.length === 0) return none
  const sliceInfoXml = await readEntry(input.localPath, 'Metadata/slice_info.config')
    .then((buffer) => buffer.toString('utf8'))
    .catch(() => null)
  if (!sliceInfoXml) return none
  const source = parsePlateSliceMappingSource(sliceInfoXml, input.plate)
  if (!source) return none
  return buildProjectFileMappingInfoFields(input.amsMapping, source, trayColorsByIndex(input.status))
}
