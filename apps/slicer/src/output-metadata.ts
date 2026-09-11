/**
 * Rewrites the embedded `project_settings.config`, `model_settings.config`, and
 * `slice_info.config` of the input 3MF before slicing so its metadata (printer
 * model, process/filament names, colours, manual nozzle assignment) shapes the
 * gcode. `filament_nozzle_map` is written verbatim as a runtime nozzle id and
 * `printer_model` as Bambu's per-model preset name; do NOT remap the nozzle id
 * through `physical_extruder_map` (see the slicer development notes nozzle-mapping invariant).
 * `slice_info.config` carries the Bambu `model_id` code, not the friendly name.
 */
import { clearInheritsGroupSlot, type CreateSlicingJob, type SlicingPresetKind } from '@printstream/shared'
import { buildManualNozzleAssignment, stringArray } from '@printstream/shared/three-mf'
export {
  applyManualFilamentMapToModelSettings,
  buildManualNozzleAssignment,
  readAuthoredManualFilamentMap
} from '@printstream/shared/three-mf'

type SlicingPresetFile = {
  id: string
  kind: SlicingPresetKind
  name: string
}

type FilamentMetadata = {
  type: string | null
  color: string | null
  profileName: string | null
  nozzleId: number | null
}

export type SlicedArtifactMetadata = {
  printerModel: string | null
  printerProfileName: string | null
  processProfileName: string | null
  filamentByProjectId: Map<number, FilamentMetadata>
}

export function buildSlicedArtifactMetadata(
  request: CreateSlicingJob,
  profileFiles: SlicingPresetFile[]
): SlicedArtifactMetadata | null {
  const profileNamesById = new Map(profileFiles.map((profile) => [profile.id, profile.name]))
  const printerProfileName = request.target.printerProfileId ? profileNamesById.get(request.target.printerProfileId) ?? null : null
  const processProfileName = request.target.processProfileId ? profileNamesById.get(request.target.processProfileId) ?? null : null
  const printerModel = request.target.mode === 'manualProfile'
    ? request.target.printerModel
    : extractPrinterModelFromProfileName(printerProfileName)

  const filamentByProjectId = new Map<number, FilamentMetadata>()
  for (const mapping of request.target.filamentMappings ?? []) {
    // Only a RESOLVED profile's name may become `filament_settings_id`. A mapping with no
    // `profileId` carries the material's DISPLAY identity ("Bambu PETG Basic") rather than a
    // preset name ("Bambu PETG Basic @BBL H2D 0.4 nozzle"): writing that overwrites the
    // project's own, correct preset name with a string no catalog contains. The project is then
    // left naming a preset nothing can resolve, and a partial config (the editor's
    // material-change drop) can no longer be repaired at slice time: the slice fails naming a
    // filament the user never chose. Null keeps the project's own value, which is the basis for
    // the slice; the same rule already guards the editor's SAVE path in SliceFileModal.
    const filamentProfileName = mapping.profileId
      ? cleanFilamentProfileName(profileNamesById.get(mapping.profileId) ?? mapping.material ?? null)
      : null
    filamentByProjectId.set(mapping.projectFilamentId, {
      type: mapping.material ? resolveFilamentType(mapping.material) : null,
      color: normalizeFilamentColor(mapping.color),
      profileName: filamentProfileName,
      nozzleId: parseToolheadNozzleId(mapping.toolheadId)
    })
  }

  if (!printerModel && !printerProfileName && !processProfileName && filamentByProjectId.size === 0) return null

  return {
    printerModel,
    printerProfileName,
    processProfileName,
    filamentByProjectId
  }
}

export function rewriteProjectSettingsMetadata(
  settings: Record<string, unknown>,
  metadata: SlicedArtifactMetadata
): Record<string, unknown> {
  const next = { ...settings }

  if (metadata.printerProfileName) {
    // Emit `printer_model` exactly as BambuStudio reports it per model, the machine
    // preset name without its nozzle-size suffix ("Bambu Lab H2D 0.4 nozzle" ->
    // "Bambu Lab H2D"), as a plain string, instead of our internal short code, so the
    // sliced project does not stray from what Bambu writes. Derived from the loaded
    // machine profile, so it is correct for every model without a lookup table.
    next.printer_model = bambuPrinterModelName(metadata.printerProfileName)
    next.printer_settings_id = [metadata.printerProfileName]
    next.compatible_printers = [metadata.printerProfileName]
    next.print_compatible_printers = [metadata.printerProfileName]
    // The CLI resolves the project's SYSTEM printer from inherits_group's MACHINE slot,
    // not from printer_settings_id (BambuStudio.cpp: current_printer_system_name).
    // A project saved with an inherited/custom machine preset keeps its old parent
    // there (e.g. "Bambu Lab P1P 0.4 nozzle"), and since 2.7.1 the CLI validates every
    // loaded filament preset against that name, so a stale slot fails the slice with
    // "filament preset ... is not compatible with printer <old machine>". Blank it so
    // the CLI treats the rewritten printer_settings_id as the system identity.
    // Shared with the save path rather than copied: this was a duplicate of the same
    // function, carrying the same wrong slot (the array's last entry, which is the
    // machine slot only while the array is correctly sized).
    clearInheritsGroupSlot(next, 'machine')
  } else if (metadata.printerModel) {
    next.printer_model = [metadata.printerModel]
  }
  if (metadata.processProfileName) {
    next.print_settings_id = [metadata.processProfileName]
    next.default_print_profile = metadata.processProfileName
    // Same staleness as the machine slot above: slot 0 is the process preset's
    // inherited parent, which would otherwise override the rewritten
    // print_settings_id during the CLI's compatibility checks.
    clearInheritsGroupSlot(next, 'process')
  }

  for (const [projectFilamentId, filament] of metadata.filamentByProjectId.entries()) {
    const index = projectFilamentId - 1
    if (index < 0) continue
    if (filament.type) setArrayValue(next, 'filament_type', index, filament.type)
    if (filament.color) setArrayValue(next, 'filament_colour', index, filament.color)
    if (filament.profileName) setArrayValue(next, 'filament_settings_id', index, filament.profileName)
    if (filament.nozzleId != null) {
      // `filament.nozzleId` is already a runtime nozzle id (0 = right, 1 = left): the
      // same space the index parser (`extractNozzleMapping`) canonicalises every
      // BambuStudio quirk into, and the same space `filament_nozzle_map` is read back
      // in. Write it through verbatim so an assignment the user did not change
      // round-trips to exactly what BambuStudio wrote. Do NOT remap through
      // `physical_extruder_map` here: the read path already produced a runtime id, so a
      // second remap double-inverts the assignment on machines whose map is
      // non-identity (e.g. H2D `["1","0"]`), forcing the filament onto the wrong nozzle
      // and breaking dual-nozzle offset calibration (printer error 0300-4010).
      setArrayValue(next, 'filament_nozzle_map', index, String(filament.nozzleId))
    }
  }

  // Pin a manual nozzle assignment on dual-nozzle machines (see
  // buildManualNozzleAssignment). NOTE: this pair is not what the CLI acts on, it takes the
  // MODE from the per-plate `model_settings.config` metadata and the MAP from the
  // `--filament-map` command-line flag (see `filament-map-args.ts`). We still write it here so
  // the saved artifact's metadata matches the gcode.
  const manualNozzle = buildManualNozzleAssignment(next, metadata.filamentByProjectId)
  if (manualNozzle) {
    next.filament_map = manualNozzle.filament_map
    next.filament_map_mode = manualNozzle.filament_map_mode
  }

  return next
}

export function rewriteSliceInfoMetadata(xml: string, metadata: SlicedArtifactMetadata): string {
  let nextXml = xml

  // `slice_info.config` identifies the machine by its Bambu model code (the
  // `model_id` from BambuStudio's machine_model definition, e.g. H2D -> "O1D",
  // P1S -> "C12"), not the friendly model name. The printer's own "reprint from
  // history" flow validates this code against its hardware and rejects files
  // that carry the friendly name ("The printer model doesn't match; please
  // re-slice"). When the model can't be resolved to a code we leave whatever the
  // slicer emitted untouched rather than writing a value the firmware rejects.
  const printerModelId = resolveBambuPrinterModelId(metadata.printerModel)
  if (printerModelId) {
    const escapedPrinterModel = escapeXmlAttribute(printerModelId)
    if (/<metadata\s+key="printer_model_id"\s+value="[^"]*"\s*\/>/.test(nextXml)) {
      nextXml = nextXml.replace(
        /<metadata\s+key="printer_model_id"\s+value="[^"]*"\s*\/>/g,
        `<metadata key="printer_model_id" value="${escapedPrinterModel}"/>`
      )
    } else {
      nextXml = nextXml.replace(/<plate\b[^>]*>/, (match) => `${match}\n    <metadata key="printer_model_id" value="${escapedPrinterModel}"/>`)
    }
  }

  nextXml = nextXml.replace(/<filament\b([^>]*?)(\/?)>(?:<\/filament>)?/g, (match, attrs, selfClosing) => {
    const filamentId = parseFilamentId(attrs)
    if (filamentId == null) return match
    const filament = metadata.filamentByProjectId.get(filamentId)
    if (!filament) return match

    let nextAttrs = attrs as string
    if (filament.type) nextAttrs = upsertXmlAttribute(nextAttrs, 'type', filament.type)
    if (filament.color) nextAttrs = upsertXmlAttribute(nextAttrs, 'color', filament.color)

    return `<filament${nextAttrs}${selfClosing === '/' ? '/>' : '></filament>'}`
  })

  return nextXml
}

function parseFilamentId(attrs: string): number | null {
  const match = attrs.match(/\sid="(\d+)"/)
  const filamentId = Number.parseInt(match?.[1] ?? '', 10)
  return Number.isInteger(filamentId) && filamentId > 0 ? filamentId : null
}

function upsertXmlAttribute(attrs: string, key: string, value: string): string {
  const escapedValue = escapeXmlAttribute(value)
  const pattern = new RegExp(`\\s${key}="[^"]*"`)
  if (pattern.test(attrs)) return attrs.replace(pattern, ` ${key}="${escapedValue}"`)
  return `${attrs} ${key}="${escapedValue}"`
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function setArrayValue(record: Record<string, unknown>, key: string, index: number, value: string): void {
  const current = Array.isArray(record[key]) ? [...record[key] as string[]] : []
  while (current.length <= index) current.push('')
  current[index] = value
  record[key] = current
}

/**
 * The Bambu `printer_model` string for a machine, taken from the loaded BambuStudio
 * machine preset name by dropping its trailing nozzle-size suffix
 * ("Bambu Lab H2D 0.4 nozzle" -> "Bambu Lab H2D"). Using the preset name keeps the
 * value identical to what Bambu writes for every model, with no per-model table to
 * drift out of date.
 */
function bambuPrinterModelName(printerProfileName: string): string {
  return printerProfileName.replace(/\s*\b\d+(?:\.\d+)?\s*nozzle\s*$/i, '').trim() || printerProfileName.trim()
}

function extractPrinterModelFromProfileName(profileName: string | null): string | null {
  if (!profileName) return null
  const normalized = profileName.trim()
  if (/\bH2D Pro\b/i.test(normalized)) return 'H2D Pro'
  if (/\bH2D\b/i.test(normalized)) return 'H2D'
  if (/\bH2S\b/i.test(normalized)) return 'H2S'
  if (/\bH2C\b/i.test(normalized)) return 'H2C'
  if (/\bP2S\b/i.test(normalized)) return 'P2S'
  if (/\bP1S\b/i.test(normalized)) return 'P1S'
  if (/\bP1P\b/i.test(normalized)) return 'P1P'
  if (/\bA1 mini\b/i.test(normalized)) return 'A1 mini'
  if (/\bA2L\b/i.test(normalized)) return 'A2L'
  if (/\bA1\b/i.test(normalized)) return 'A1'
  if (/\bX1 Carbon\b/i.test(normalized) || /\bX1C\b/i.test(normalized)) return 'X1C'
  if (/\bX1E\b/i.test(normalized)) return 'X1E'
  if (/\bX2D\b/i.test(normalized)) return 'X2D'
  if (/\bX1\b/i.test(normalized)) return 'X1'
  return null
}

/**
 * Maps a friendly Bambu printer model name (either the `PrinterModel` enum form
 * such as "A1mini"/"H2DPRO" or the spaced display form such as "A1 mini"/"H2D
 * Pro" produced by {@link extractPrinterModelFromProfileName}) to the Bambu
 * `model_id` code that BambuStudio writes into `slice_info.config`'s
 * `printer_model_id`. The codes are the authoritative `model_id` values from
 * BambuStudio's machine_model definitions (resources/profiles/BBL/machine/*.json).
 * Returns null for unknown/"unknown" models so callers can leave the slicer's
 * own metadata untouched rather than writing an invalid code.
 */
function resolveBambuPrinterModelId(model: string | null): string | null {
  if (!model) return null
  const key = model.trim().toLowerCase().replace(/\s+/g, '')
  const codes: Record<string, string> = {
    x1: 'BL-P002',
    x1c: 'BL-P001',
    x1carbon: 'BL-P001',
    x1e: 'C13',
    x2d: 'N6',
    p1p: 'C11',
    p1s: 'C12',
    p2s: 'N7',
    a1: 'N2S',
    a1mini: 'N1',
    a2l: 'N9',
    h2d: 'O1D',
    h2dpro: 'O1E',
    h2c: 'O1C2',
    h2s: 'O1S'
  }
  return codes[key] ?? null
}

function resolveFilamentType(value: string): string {
  const normalized = value.toUpperCase()
  // Bambu support filaments carry the support product name (e.g. "Bambu Support
  // for ABS"), but the project filament_type must be the base polymer, matching
  // BambuStudio. The AMS tray code (e.g. "ABS-S") is derived from the base type
  // separately, so emitting "SUPPORT"/"SUPPORT-FOR" here would create a false
  // material mismatch in the print dialog. Resolve to the underlying polymer and
  // default to PLA for generic support (e.g. "Support W"/"Support G").
  if (/\bSUPPORT\b/.test(normalized)) {
    const baseMatch = normalized.replace(/\bSUPPORT\b/g, ' ').match(/\b(PLA|PETG|ABS|ASA|TPU|PA|PC|PVA|HIPS)\b/)
    return baseMatch?.[0] ?? 'PLA'
  }
  const match = normalized.match(/\b(PLA|PETG|ABS|ASA|TPU|PA|PC|PVA|HIPS)(?:[-_\s][A-Z0-9]+)?\b/)
  return match?.[0]?.replace(/\s+/g, '-') ?? value
}

function cleanFilamentProfileName(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
    .replace(/\s*@BBL\b.*$/i, '')
    .replace(/\s*@base\b.*$/i, '')
    .trim()
  return trimmed || null
}

/**
 * True when applying `metadata` will change a filament colour the project already carries:
 * the exact condition under which the source file's embedded plate previews (rendered with
 * the OLD colours) go stale. This is our side of BambuStudio's own `filament_color_changed`
 * check, which the CLI can never hit for us: we rewrite the colours INTO the project before
 * it looks (nothing rides `--filament-colour`), so from where it sits nothing ever changed.
 * The caller reacts by dropping the stale previews (see `isPlatePreviewEntry`). Comparison
 * is RGB: alpha is ignored, matching what `normalizeFilamentColor` keeps.
 */
export function metadataChangesFilamentColours(
  settings: Record<string, unknown>,
  metadata: SlicedArtifactMetadata
): boolean {
  const embedded = stringArray(settings.filament_colour)
  for (const [projectFilamentId, filament] of metadata.filamentByProjectId.entries()) {
    if (!filament.color) continue
    const index = projectFilamentId - 1
    if (index < 0) continue
    if (normalizeFilamentColor(embedded[index]) !== filament.color) return true
  }
  return false
}

/**
 * Entry names of the per-plate preview assets BambuStudio embeds in a 3MF (cover, small
 * cover, no-light, top and pick renders). The slice pipeline drops these from the prepared
 * input when `metadataChangesFilamentColours` says they are stale, so the CLI's thumbnail
 * stage re-renders them with the new colours instead of carrying the old ones into the
 * sliced output. Runtimes that cannot render (no weston/OSMesa/shim: see
 * bambu-studio-cli.sh) regain the originals via `backfillPlateThumbnails`, which reads the
 * ORIGINAL input, not the prepared copy.
 */
export function isPlatePreviewEntry(name: string): boolean {
  return /^Metadata\/(?:plate_\d+(?:_small)?|plate_no_light_\d+|top_\d+|pick_\d+)\.png$/.test(name)
}

function normalizeFilamentColor(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toUpperCase()
  if (/^[0-9a-fA-F]{6}$/.test(trimmed)) return `#${trimmed.toUpperCase()}`
  if (/^#[0-9a-fA-F]{8}$/.test(trimmed)) return `#${trimmed.slice(1, 7).toUpperCase()}`
  if (/^[0-9a-fA-F]{8}$/.test(trimmed)) return `#${trimmed.slice(0, 6).toUpperCase()}`
  return null
}

function parseToolheadNozzleId(value: string | null | undefined): number | null {
  const match = value?.match(/^nozzle-(\d+)$/)
  const nozzleId = Number.parseInt(match?.[1] ?? '', 10)
  return Number.isInteger(nozzleId) && nozzleId >= 0 ? nozzleId : null
}

/**
 * Parse a BambuStudio nozzle-mapping array (`physical_extruder_map`,
 * `filament_nozzle_map`, ...), stored as stringified ints, into numbers. Invalid
 * entries become NaN, which never matches a real nozzle id in `indexOf` lookups.
 */
