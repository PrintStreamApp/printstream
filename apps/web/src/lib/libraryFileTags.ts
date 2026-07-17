/**
 * Pure helpers for deriving library-file tag/chip descriptors (printer models,
 * nozzle sizes, plate types, plate count, filament colors) shared by the
 * library browser cards and other surfaces (e.g. the version history dialog).
 * Rendering stays with the components; this module only owns the descriptor
 * shapes, colors, and inclusion rules so every surface shows the same chips.
 */
import { isDirectPrintableFileName, type LibraryFile } from '@printstream/shared'

export type FileTagColor = 'neutral' | 'primary' | 'success' | 'warning'
export type FileTagKind = 'filament' | 'meta'

export interface FileTagDescriptor {
  key: string
  label: string
  color: FileTagColor
  kind: FileTagKind
  dotColor?: string | null
  chipSx?: Record<string, unknown>
}

export interface FileTagGroups {
  filament: FileTagDescriptor[]
  filamentTrailing: FileTagDescriptor[]
  meta: FileTagDescriptor[]
}

export function shouldShowLibraryPlateTypeTags(file: LibraryFile): boolean {
  // Sliced files AND unsliced projects both carry meaningful plate types (the
  // project's configured bed for the latter), so show the chips for both.
  return file.kind === 'gcode' || file.kind === '3mf'
}

/** A plain project 3MF (no embedded gcode) — printable only after slicing. */
export function isUnslicedThreeMfFile(file: LibraryFile): boolean {
  // A geometry-only 3MF (no Bambu project metadata) is a mesh container, not an
  // openable/sliceable project — it belongs to the preview-only class below, exactly
  // like STL/STEP, and every "pick a file to slice" surface must skip it.
  return file.name.toLowerCase().endsWith('.3mf') && !isDirectPrintableFileName(file.name) && file.geometryOnly !== true
}

/**
 * Files whose only library action is the read-only 3D preview: STL, STEP, and
 * geometry-only 3MFs have no direct-print path (unlike gcode) and aren't editable
 * projects (unlike project 3MFs), so a click on one should open the previewer rather
 * than do nothing. The server converts each to a mesh for the previewer (STEP is
 * tessellated; a geometry-only 3MF is extracted).
 */
export function isPreviewOnlyLibraryFile(file: LibraryFile): boolean {
  return file.kind === 'stl' || file.kind === 'step' || (file.kind === '3mf' && file.geometryOnly === true)
}

/**
 * Files whose DEFAULT click opens the 3D preview rather than their primary action.
 * Beyond the preview-only class, this includes single-object model exports
 * (`objectExport`): full projects internally, but saved to be reused as models — so a
 * click previews them (plated mode), while slicing/editing stays available through the
 * explicit menu actions (they still count as `isUnslicedThreeMfFile`).
 */
export function isPreviewFirstLibraryFile(file: LibraryFile): boolean {
  return isPreviewOnlyLibraryFile(file) || (file.kind === '3mf' && file.objectExport === true)
}

/**
 * Meta chip descriptors exactly as the icon card renders them (plate count,
 * printer models, nozzle sizes, plate types — same order, colors, and short
 * plate labels), for surfaces outside the browser such as the version
 * history dialog that must mirror the icon-card chips.
 */
export function buildLibraryFileMetaTags(file: LibraryFile): FileTagDescriptor[] {
  return buildCompactFileTags(file, { shortPlateLabels: true }).meta
}

export function buildFullFileTags(file: LibraryFile): FileTagGroups {
  const plateCountTag = buildPlateCountTagDescriptor(file)
  return {
    filament: buildProjectFilamentTagDescriptors(file.projectFilamentChips),
    // Second line: filament dots, then nozzle sizes, then plate types.
    filamentTrailing: [...buildNozzleSizeTagDescriptors(file), ...buildPlateTagDescriptors(file)],
    meta: [
      ...(plateCountTag ? [plateCountTag] : []),
      ...buildMetaTagDescriptors(file, { includePlateTypes: false, includeNozzleSizes: false })
    ]
  }
}

/** "N plates" chip for 3MF projects and sliced gcode 3MFs (list + icon modes). */
function buildPlateCountTagDescriptor(file: LibraryFile): FileTagDescriptor | null {
  const plateCount = file.plateCount ?? 0
  if (plateCount < 1 || !file.name.toLowerCase().endsWith('.3mf')) return null
  // Success-tinted so the plate count stands apart from the neutral model chips,
  // teal nozzle chips, and amber plate-type chips.
  return {
    key: 'plate-count',
    label: plateCount === 1 ? '1 plate' : `${plateCount} plates`,
    color: 'success' as const,
    kind: 'meta' as const
  }
}

export function buildCompactFileTags(file: LibraryFile, options: { shortPlateLabels?: boolean } = {}): FileTagGroups {
  const plateCountTag = buildPlateCountTagDescriptor(file)
  return {
    filament: buildProjectFilamentTagDescriptors(file.projectFilamentChips),
    filamentTrailing: [],
    // Every meta tag renders (the row wraps); chips were previously capped at three
    // with a "+N" overflow chip, which hid the new nozzle/plate chips in icon mode.
    meta: [
      ...(plateCountTag ? [plateCountTag] : []),
      ...buildMetaTagDescriptors(file, { shortPlateLabels: options.shortPlateLabels })
    ]
  }
}

function buildProjectFilamentTagDescriptors(chips: LibraryFile['projectFilamentChips']): FileTagDescriptor[] {
  return chips.map((chip) => {
    return {
      key: `${chip.label}-${chip.color ?? 'none'}`,
      label: chip.label,
      color: 'neutral' as const,
      kind: 'filament' as const,
      dotColor: chip.color,
      chipSx: {
        '& .MuiChip-label': {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.35rem'
        }
      }
    }
  })
}

function buildMetaTagDescriptors(
  file: LibraryFile,
  options: { includePlateTypes?: boolean; includeNozzleSizes?: boolean; shortPlateLabels?: boolean } = {}
): FileTagDescriptor[] {
  const tags: FileTagDescriptor[] = []
  tags.push(...file.compatiblePrinterModels.map((label) => ({
    key: `model-${label}`,
    label,
    color: 'neutral' as const,
    kind: 'meta' as const
  })))
  if (options.includeNozzleSizes ?? true) {
    tags.push(...buildNozzleSizeTagDescriptors(file))
  }
  if (options.includePlateTypes ?? true) {
    tags.push(...buildPlateTagDescriptors(file, options.shortPlateLabels ?? false))
  }
  return tags
}

/**
 * Primary-tinted so nozzle sizes read apart from the neutral printer-model chips and
 * the warning-tinted plate-type chips at a glance.
 */
function buildNozzleSizeTagDescriptors(file: LibraryFile): FileTagDescriptor[] {
  return file.nozzleSizeChips.map((label) => ({
    key: `nozzle-${label}`,
    label,
    color: 'primary' as const,
    kind: 'meta' as const
  }))
}

/** Drop a trailing "Plate" so chips read e.g. "High Temp" instead of "High Temp Plate". */
function shortenPlateLabel(label: string): string {
  return label.replace(/\s*plate\s*$/i, '').trim() || label
}

function buildPlateTagDescriptors(file: LibraryFile, short = false): FileTagDescriptor[] {
  if (!shouldShowLibraryPlateTypeTags(file)) {
    return []
  }

  return file.plateTypeChips.map((label) => ({
    key: `plate-${label}`,
    label: short ? shortenPlateLabel(label) : label,
    color: 'warning' as const,
    kind: 'meta' as const
  }))
}
