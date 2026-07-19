/**
 * Pure slice-dialog profile/material matching helpers, extracted from `LibraryView`.
 *
 * Owns the BambuStudio-mirroring compatibility logic that drives the slice and
 * print dialogs: slicing-profile sorting/visibility, machine/process/filament
 * profile compatibility matching, printer-model and nozzle-diameter token
 * matching, plate-type and material-type ordering, loaded-material option
 * building, and filament colour/mapping normalization.
 *
 * Everything here is a side-effect-free data transform over `SlicingProfileSummary`,
 * `ThreeMfIndex`, `LibraryFile`, and printer status/spool data — no React, no
 * component state. The text/token matchers intentionally mirror BambuStudio's
 * permissive profile-family behavior; prefer the explicit profile metadata and
 * fall back to normalized name/condition matching only as those functions document.
 */
import type {
  LibraryFile,
  Printer,
  PrinterNozzleFlow,
  PrinterStatus,
  SlicingProfileSummary,
  ThreeMfIndex,
  ThreeMfPlate
} from '@printstream/shared'
import { amsTrayIndex, formatNozzleLabel, getPrinterControlCapabilities, printerModelSchema } from '@printstream/shared'
import {
  KNOWN_BAMBU_PRINTER_MODEL_KEYS,
  bambuModelKeysAreCompatible,
  canonicalBambuModelKey,
  normalizeBambuStudioPrinterModelOption,
  resolveBambuPrinterModelAliases
} from './bambuPrinterModels'
import { resolveFilamentIdentity } from './filamentColor'
import type { SlotFilamentIdentityLookup } from './slotFilamentIdentity'
import { normalizeProfileText, resolveLoadedMaterialPreset } from './loadedMaterialProfileSelection'
import { formatSlicingProfileDisplayName, pickMachineDefaultFilamentProfile, pickSlicingProfileByBakedName } from './slicingProfileSelection'
import { amsUnitLetter } from './printerTrayMapping'

/**
 * Whether a `/api/slicing/profiles` response is complete enough to drive the
 * slice dialog, i.e. it carries at least one **builtin** preset.
 *
 * The slicer can answer while it is restarting or still indexing its bundled
 * `*_full/` system-preset dirs, returning only the workspace's custom profiles
 * (or nothing). BambuStudio always ships builtin machine/process/filament
 * presets, so a builtin-less response is never legitimate — it means the slicer
 * replied early. Caching that partial result strands the editor on a custom-only
 * catalogue: no builtin machine profile to auto-pick (Slice silently disabled),
 * and every loaded/AMS material collapses to the nearest custom filament (e.g.
 * PETG slots all mislabel as "PLA Basic") because the real "@BBL <model>" presets
 * the matcher scores against are absent. Callers should treat `false` as a
 * transient failure and retry rather than cache the response.
 */
export function slicingProfilesResponseIsUsable(profiles: SlicingProfileSummary[] | null | undefined): boolean {
  return Boolean(profiles?.some((profile) => profile.source === 'builtin'))
}

export function sortSlicingProfiles(profiles: SlicingProfileSummary[]): SlicingProfileSummary[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  return [...profiles].sort((left, right) => {
    if (isProjectSlicingProfile(left) !== isProjectSlicingProfile(right)) return isProjectSlicingProfile(left) ? -1 : 1
    if (left.source !== right.source) return left.source === 'custom' ? -1 : 1
    return collator.compare(left.name, right.name)
  })
}

export const PROJECT_SLICING_PROFILE_ID_PREFIX = 'project:'

export function buildProjectSlicingProfiles(bakedIndex: ThreeMfIndex | null, kind: SlicingProfileSummary['kind']): SlicingProfileSummary[] {
  if (!bakedIndex) return []
  if (kind === 'machine') return buildProjectSlicingProfileList(kind, bakedIndex.printerProfileName ? [bakedIndex.printerProfileName] : [])
  if (kind === 'process') return buildProjectSlicingProfileList(kind, bakedIndex.processProfileName ? [bakedIndex.processProfileName] : [])
  const byName = new Map<string, SlicingProfileSummary>()
  for (const filament of bakedIndex.projectFilaments) {
    const name = filament.filamentName?.trim()
    if (!name || byName.has(name)) continue
    byName.set(name, {
      id: buildProjectSlicingProfileId(kind, name),
      source: 'custom' as const,
      kind,
      name,
      filamentType: filament.filamentType ?? undefined,
      updatedAt: null
    })
  }
  return [...byName.values()]
}

export function buildProjectSlicingProfileList(kind: SlicingProfileSummary['kind'], names: string[]): SlicingProfileSummary[] {
  return Array.from(new Set(names.map((name) => name.trim()).filter(Boolean))).map((name) => ({
    id: buildProjectSlicingProfileId(kind, name),
    source: 'custom' as const,
    kind,
    name,
    updatedAt: null
  }))
}

export function mergeProjectSlicingProfiles(installedProfiles: SlicingProfileSummary[], projectProfiles: SlicingProfileSummary[]): SlicingProfileSummary[] {
  return sortSlicingProfiles([
    ...projectProfiles,
    ...installedProfiles
  ])
}

export function buildProjectSlicingProfileId(kind: SlicingProfileSummary['kind'], name: string): string {
  return `${PROJECT_SLICING_PROFILE_ID_PREFIX}${kind}:${encodeURIComponent(name)}`
}

export function isProjectSlicingProfile(profile: SlicingProfileSummary): boolean {
  return profile.id.startsWith(PROJECT_SLICING_PROFILE_ID_PREFIX)
}

export function isVisibleProcessProfile(profile: SlicingProfileSummary): boolean {
  const normalizedName = normalizedProfileText(profile.name)
  return !normalizedName.startsWith('fdm process')
}

export function isVisibleFilamentProfile(profile: SlicingProfileSummary): boolean {
  // Defensive client-side mirror of the slicer ingestion rule. During dev/HMR
  // or while an older slicer container is still running, helper JSON resources
  // can still appear in `/profiles`; BambuStudio does not show these as presets.
  return !isInternalBambuStudioResourceName(profile.name)
}

export function isInternalBambuStudioResourceName(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/[\\/]+/g, '_').replace(/\s+/g, '_')
  return normalized.startsWith('fdm_')
    || normalized.startsWith('filament_')
    || normalized.startsWith('filaments_')
    || normalized.includes('recommended_params')
}

export type SliceMaterialOption = {
  id: string
  label: string
  group: string
  materialType: string
  brand: string
  profileId: string | null
  material: string | null
  color: string | null
  colors: string[]
  source: 'ams' | 'externalSpool' | 'manual'
  trayId: number | null
  nozzleId: number | null
  toolheadId: string | null
  metadata: string
  /**
   * Short AMS/external slot badge (e.g. `A1`, `B2`, `Ext-L`) for loaded-material
   * options, matching the swatch labels in the print dialog. `null` for manual
   * profile options, which aren't tied to a physical slot.
   */
  slotLabel: string | null
  /**
   * Display name of the slicing preset actually behind this option ("Generic PLA"),
   * for loaded options whose label names the FILAMENT (e.g. a tracked spool) rather
   * than the preset. `null` when no preset resolved.
   */
  presetLabel: string | null
  /** Canonical colour name of the loaded filament ("White", "Jade White"). */
  colorName: string | null
  /**
   * Remaining quantity from the TRACKED spool (filament-manager) — covers non-RFID
   * custom spools the printer cannot estimate. Null when untracked; callers may
   * fall back to the RFID tray estimate.
   */
  remainingGrams: number | null
  remainPercent: number | null
}

export function pickMachineProfileForPrinter(profiles: SlicingProfileSummary[], printer?: Printer | null): SlicingProfileSummary | null {
  if (!printer) return null
  return pickMachineProfileByName(profiles, printer.name, printer.model)
}

export function pickMachineProfileByName(profiles: SlicingProfileSummary[], name: string | null | undefined, model: string): SlicingProfileSummary | null {
  const normalizedModel = normalizedProfileText(model)
  const normalizedName = normalizedProfileText(name ?? '')
  return profiles.find((profile) => normalizedProfileText(profile.name).includes(normalizedModel))
    ?? profiles.find((profile) => normalizedName && (normalizedName.includes(normalizedProfileText(profile.name)) || normalizedProfileText(profile.name).includes(normalizedName)))
    ?? null
}

export function isMachineProfileCompatible(profile: SlicingProfileSummary, model: string, nozzleDiameters: number[]): boolean {
  if (isProjectSlicingProfile(profile)) return true
  return matchesPrinterModel(profile, model) && matchesProfileNozzleTarget(profile, null, nozzleDiameters)
}

export function isProcessProfileCompatible(
  profile: SlicingProfileSummary,
  selectedMachineProfile: SlicingProfileSummary | null,
  model: string,
  nozzleDiameters: number[],
  plateType: string
): boolean {
  if (isProjectSlicingProfile(profile)) return true
  return matchesCompatiblePrinters(profile, selectedMachineProfile, model)
    && matchesProfilePrinterTarget(profile, selectedMachineProfile, model)
    && matchesProfileNozzleTarget(profile, selectedMachineProfile, nozzleDiameters)
    && matchesPlateType(profile, plateType)
}

export function isFilamentProfileCompatible(
  profile: SlicingProfileSummary,
  selectedMachineProfile: SlicingProfileSummary | null,
  selectedProcessProfile: SlicingProfileSummary | null,
  model: string,
  nozzleDiameters: number[]
): boolean {
  if (isProjectSlicingProfile(profile)) return true
  return matchesCompatiblePrinters(profile, selectedMachineProfile, model)
    && matchesProfilePrinterTarget(profile, selectedMachineProfile, model)
    && matchesProfileNozzleTarget(profile, selectedMachineProfile, nozzleDiameters)
    && matchesCompatiblePrints(profile, selectedProcessProfile)
}

export function matchesPrinterModel(profile: SlicingProfileSummary, model: string): boolean {
  const modelCandidates = [...(profile.printerModels ?? []), ...(profile.compatiblePrinters ?? []), profile.name]
  if (model === 'unknown' || modelCandidates.length === 0) return true
  const selectedModels = printerModelTextCandidates(model)
  return modelCandidates.some((candidate) => {
    const candidateModels = profileTextCandidates(candidate)
    return candidateModels.some((candidateModel) => selectedModels.some((selectedModel) => candidateModel.includes(selectedModel) || selectedModel.includes(candidateModel)))
  })
}

export function resolveSliceDialogSourcePrinterModel(bakedIndex: ThreeMfIndex | null, fallbackModels: readonly string[]): string | null {
  return normalizeSliceDialogPrinterModel(bakedIndex?.printerProfileName)
    ?? normalizeSliceDialogPrinterModel(bakedIndex?.compatiblePrinterModels[0])
    ?? normalizeSliceDialogPrinterModel(fallbackModels[0])
}

export function resolveSliceDialogTargetPrinterModel(selectedPrinterModel: string, selectedMachineProfile: SlicingProfileSummary | null): string | null {
  return normalizeSliceDialogPrinterModel(selectedPrinterModel)
    ?? normalizeSliceDialogPrinterModel(selectedMachineProfile?.name)
}

export function normalizeSliceDialogPrinterModel(value: unknown): string | null {
  return canonicalBambuModelKey(value)
}

export function formatSliceDialogPrinterModel(value: string): string {
  switch (value) {
    case 'H2DPRO': return 'H2D Pro'
    case 'H2D': return 'H2D'
    case 'H2C': return 'H2C'
    case 'A1mini': return 'A1 Mini'
    default: return value
  }
}

export function matchesCompatiblePrinters(profile: SlicingProfileSummary, selectedMachineProfile: SlicingProfileSummary | null, model: string): boolean {
  const compatiblePrinters = profile.compatiblePrinters ?? []
  if (compatiblePrinters.length === 0) return true
  if (!selectedMachineProfile) return model === 'unknown'
  const selectedTargets = selectedPrinterCompatibilityTargets(selectedMachineProfile, model)
  // The machine profile is what is actually sent to the slicer, so it is the
  // authority for compatibility. Deriving the key from `model` first let a
  // model/machine mismatch (e.g. model "A1" while the machine profile is "A1 mini")
  // accept a full-A1 filament against an A1-mini machine — BambuStudio then rejects
  // it at slice time ("filament ... is not compatible with printer", exit 251).
  const selectedModelKey = canonicalBambuModelKey(selectedMachineProfile.name) ?? canonicalBambuModelKey(model)
  return compatiblePrinters.some((compatiblePrinter) => {
    if (compatiblePrinter.trim() === selectedMachineProfile.name) return true
    // Reject distinct Bambu models that the permissive text matcher would
    // otherwise conflate by shared name prefix (e.g. an H2D Pro profile against
    // an H2D printer). Unknown/non-Bambu keys are left to the text matcher.
    if (!bambuModelKeysAreCompatible(selectedModelKey, canonicalBambuModelKey(compatiblePrinter))) return false
    return profileTargetMatchesSelectedPrinter(compatiblePrinter, selectedTargets)
  })
}

export function matchesCompatiblePrints(profile: SlicingProfileSummary, selectedProcessProfile: SlicingProfileSummary | null): boolean {
  const compatiblePrints = profile.compatiblePrints ?? []
  if (compatiblePrints.length === 0 || !selectedProcessProfile) return true
  return compatiblePrints.some((compatiblePrint) => compatiblePrint.trim() === selectedProcessProfile.name)
}

export function matchesNozzleDiameters(profile: SlicingProfileSummary, nozzleDiameters: number[]): boolean {
  if (!profile.nozzleDiameters || profile.nozzleDiameters.length === 0 || nozzleDiameters.length === 0) return true
  return profile.nozzleDiameters.some((profileDiameter) => nozzleDiameters.some((selectedDiameter) => Math.abs(profileDiameter - selectedDiameter) < 0.001))
}

export function matchesProfilePrinterTarget(profile: SlicingProfileSummary, selectedMachineProfile: SlicingProfileSummary | null, model: string): boolean {
  if (model === 'unknown' && !selectedMachineProfile) return true
  const selectedTargets = selectedPrinterCompatibilityTargets(selectedMachineProfile, model)
  if (selectedTargets.length === 0) return true
  const profileTargets = extractProfilePrinterTargets(profile)
  if (profileTargets.length === 0) return true
  return profileTargets.some((target) => profileTargetMatchesSelectedPrinter(target, selectedTargets))
}

export function matchesProfileNozzleTarget(profile: SlicingProfileSummary, selectedMachineProfile: SlicingProfileSummary | null, nozzleDiameters: number[]): boolean {
  if (nozzleDiameters.length === 0) return true
  if (!matchesNozzleDiameters(profile, nozzleDiameters)) return false
  const selectedNozzleTokens = nozzleDiameters.map(nozzleDiameterToken)
  const profileTargets = [profile.name, ...(profile.compatiblePrinters ?? []), profile.compatiblePrintersCondition]
    .filter((entry): entry is string => Boolean(entry))
    .map(normalizedProfileText)
  const explicitNozzleTargets = profileTargets
    .flatMap(extractNozzleDiameterTokens)
    .filter((entry): entry is string => Boolean(entry))
  if (explicitNozzleTargets.length > 0 && !explicitNozzleTargets.some((entry) => selectedNozzleTokens.includes(entry))) return false
  if (!selectedMachineProfile) return true

  const selectedMachineNozzleTokens = [selectedMachineProfile.name, ...(selectedMachineProfile.compatiblePrinters ?? [])]
    .map(normalizedProfileText)
    .flatMap(extractNozzleDiameterTokens)
    .filter((entry): entry is string => Boolean(entry))
  return selectedMachineNozzleTokens.length === 0 || selectedMachineNozzleTokens.some((entry) => selectedNozzleTokens.includes(entry))
}

export function extractNozzleDiameterTokens(value: string): string[] {
  const tokens: string[] = []
  for (const match of value.matchAll(/(?:^|\s)(\d(?:\.\d+)?)\s*(?:mm\s*)?nozzle(?:\s|$)/g)) {
    const rawDiameter = match[1]
    if (!rawDiameter) continue
    const parsed = Number.parseFloat(rawDiameter)
    if (Number.isFinite(parsed) && parsed > 0) tokens.push(nozzleDiameterToken(parsed))
  }
  for (const match of value.matchAll(/(?:^|\s)nozzle\s*(\d(?:\.\d+)?)(?:\s|$)/g)) {
    const rawDiameter = match[1]
    if (!rawDiameter) continue
    const parsed = Number.parseFloat(rawDiameter)
    if (Number.isFinite(parsed) && parsed > 0) tokens.push(nozzleDiameterToken(parsed))
  }
  for (const match of value.matchAll(/nozzle diameter\s*\d*\s*(?:==|=|in|contains)?\s*(\d(?:\.\d+)?)/g)) {
    const rawDiameter = match[1]
    if (!rawDiameter) continue
    const parsed = Number.parseFloat(rawDiameter)
    if (Number.isFinite(parsed) && parsed > 0) tokens.push(nozzleDiameterToken(parsed))
  }
  return Array.from(new Set(tokens))
}

export function nozzleDiameterToken(value: number): string {
  return Number(value).toFixed(3)
}

export function matchesPlateType(profile: SlicingProfileSummary, plateType: string): boolean {
  if (!profile.plateTypes || profile.plateTypes.length === 0 || !plateType) return true
  const selected = normalizedProfileText(plateType)
  return profile.plateTypes.some((profilePlateType) => {
    const normalized = normalizedProfileText(profilePlateType)
    return normalized === selected || normalized.includes(selected) || selected.includes(normalized)
  })
}

/**
 * The standard BambuStudio bed types every Bambu printer accepts. Profiles only carry
 * their DEFAULT bed (`curr_bed_type`), so these are always offered — otherwise targets
 * whose profiles name a single plate (e.g. P1S) never list SuperTack at all.
 */
export const BAMBU_STUDIO_PLATE_TYPES = ['cool_plate', 'engineering_plate', 'high_temp_plate', 'textured_pei_plate', 'supertack_plate']

export function resolveCompatiblePlateTypes(file: LibraryFile, bakedIndex: ThreeMfIndex | null, selectedMachineProfile: SlicingProfileSummary | null, processProfiles: SlicingProfileSummary[]): string[] {
  const profilePlateTypes = [selectedMachineProfile, ...processProfiles]
    .flatMap((profile) => profile?.plateTypes ?? [])
  const bakedPlateTypes = bakedIndex?.plates.flatMap((plate) => plate.plateType ? [plate.plateType] : []) ?? []
  const combined = ensureOptionValues([...bakedPlateTypes, ...file.plateTypeChips, ...profilePlateTypes], BAMBU_STUDIO_PLATE_TYPES)
  return sortPlateTypesByBambuStudioOrder(dedupePlateTypesByLabel(combined))
}

/**
 * Collapses plate-type values that render to the same display label (e.g. the code
 * `high_temp_plate` and the label form `High Temp Plate` arriving from different sources), keeping
 * the first occurrence so the dropdown doesn't show duplicate entries.
 */
export function dedupePlateTypesByLabel(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const key = formatPlateTypeLabel(value).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

export function sortPlateTypesByBambuStudioOrder(values: string[]): string[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  return [...values].sort((left, right) => {
    const leftRank = bambuStudioPlateTypeRank(left)
    const rightRank = bambuStudioPlateTypeRank(right)
    if (leftRank !== rightRank) return leftRank - rightRank
    return collator.compare(formatPlateTypeLabel(left), formatPlateTypeLabel(right))
  })
}

export function bambuStudioPlateTypeRank(value: string): number {
  const normalized = normalizedProfileText(value)
  if (normalized.includes('cool') || normalized === 'pc') return 0
  if (normalized.includes('engineering') || normalized.includes('eng plate') || normalized === 'pe') return 1
  if (normalized.includes('high temp') || normalized.includes('high temperature') || normalized.includes('hot plate') || normalized.includes('smooth pei') || normalized === 'pei') return 2
  if (normalized.includes('textured') || normalized === 'pte') return 3
  if (normalized.includes('supertack') || normalized.includes('super tack')) return 4
  return 100
}

export function resolveInitialPlateType(file: LibraryFile, bakedIndex: ThreeMfIndex | null): string {
  return bakedIndex?.plates.find((plate) => plate.plateType)?.plateType ?? file.plateTypeChips[0] ?? 'textured_pei_plate'
}

/** The project's own plate type (baked plate metadata, then a file chip), or null when it carries none. */
export function resolveProjectPlateType(file: LibraryFile, bakedIndex: ThreeMfIndex | null): string | null {
  return bakedIndex?.plates.find((plate) => plate.plateType)?.plateType ?? file.plateTypeChips[0] ?? null
}

/**
 * The plate-type option whose display LABEL matches `desired` (label-insensitive), or null.
 * Label-based so the code form (`high_temp_plate`) and a profile's label form (`High Temp Plate`)
 * resolve to the same option — otherwise the same logical plate falls out of its own option list
 * (the value-form differs between sources) and the selection is silently dropped.
 */
export function matchPlateTypeByLabel(options: readonly string[], desired: string | null | undefined): string | null {
  if (!desired) return null
  const key = formatPlateTypeLabel(desired).toLowerCase()
  return options.find((option) => formatPlateTypeLabel(option).toLowerCase() === key) ?? null
}

/**
 * Resolve which plate type to select from `options`, in priority order: the current choice
 * (matched by label so a value-form change never drops it), the selected printer's loaded plate,
 * then a stable default (Textured PEI, then the first option). Deliberately never snaps to
 * BambuStudio's rank-0 Cool Plate as a fallback — an unrelated profiles recompute must not
 * silently change the user's plate to Cool Plate.
 */
export function resolvePreferredPlateType(
  options: readonly string[],
  preferences: { current?: string | null; printerPlateType?: string | null }
): string {
  return matchPlateTypeByLabel(options, preferences.current)
    ?? matchPlateTypeByLabel(options, preferences.printerPlateType)
    ?? matchPlateTypeByLabel(options, 'textured_pei_plate')
    ?? options[0]
    ?? ''
}

export function resolveInitialNozzleDiameter(file: LibraryFile, printer: Printer | null | undefined, selectedMachineProfile: SlicingProfileSummary | null, bakedIndex: ThreeMfIndex | null): string {
  return resolveSliceDialogNozzleDiameterOptions(file, printer ?? null, selectedMachineProfile ? [selectedMachineProfile] : [], bakedIndex)[0] ?? '0.4'
}

export function resolveSliceDialogNozzleDiameterOptions(file: LibraryFile, printer: Printer | null, machineProfiles: SlicingProfileSummary[], bakedIndex: ThreeMfIndex | null): string[] {
  const fromBakedPlates = bakedIndex?.plates.flatMap((plate) => plate.nozzleSizes.map((entry) => Number.parseFloat(entry))) ?? []
  const fromBakedFilaments = bakedIndex?.plates.flatMap((plate) => plate.filaments.map((filament) => Number.parseFloat(filament.nozzleDiameter ?? ''))) ?? []
  const fromFile = file.nozzleSizeChips
    .map((entry) => Number.parseFloat(entry))
    .filter((entry) => Number.isFinite(entry) && entry > 0)
  const fromPrinter = printer?.currentNozzleDiameters
    .map((entry) => Number.parseFloat(entry.diameter ?? ''))
    .filter((entry) => Number.isFinite(entry) && entry > 0) ?? []
  const fromMachineProfiles = machineProfiles.flatMap((profile) => resolveMachineProfileNozzleDiameters(profile))
  return Array.from(new Set([...fromBakedPlates, ...fromBakedFilaments, ...fromFile, ...fromPrinter, ...fromMachineProfiles, 0.4]
    .filter((entry) => Number.isFinite(entry) && entry > 0)
    .map((entry) => Number(entry).toString())))
    .sort((left, right) => Number.parseFloat(left) - Number.parseFloat(right))
}

export function resolveMachineProfileNozzleDiameters(profile: SlicingProfileSummary): number[] {
  const explicit = profile.nozzleDiameters ?? []
  const fromName = extractNozzleDiameterTokens(normalizedProfileText(profile.name)).map((entry) => Number.parseFloat(entry))
  return [...explicit, ...fromName].filter((entry) => Number.isFinite(entry) && entry > 0)
}

export function buildSliceDialogToolheads(nozzleDiameter: string, nozzleFlow: PrinterNozzleFlow, status: PrinterStatus | undefined, model: string) {
  const diameter = Number.parseFloat(nozzleDiameter)
  if (status?.nozzles.length) {
    return [...status.nozzles].map((nozzle) => ({
      id: buildSliceToolheadId(nozzle.extruderId),
      label: formatNozzleLabel(nozzle.extruderId, 'long', status.nozzles.length) ?? `Nozzle ${nozzle.extruderId + 1}`,
      nozzleDiameter: nozzle.diameter ? Number.parseFloat(nozzle.diameter) : Number.isFinite(diameter) && diameter > 0 ? diameter : null,
      nozzleFlow: nozzle.flow ?? nozzleFlow,
      position: nozzle.extruderId === 1 ? 'left' as const : status.nozzles.length > 1 ? 'right' as const : 'single' as const
    })).sort((left, right) => (left.position === 'left' ? 0 : left.position === 'right' ? 1 : 2) - (right.position === 'left' ? 0 : right.position === 'right' ? 1 : 2))
  }
  const parsedModel = printerModelSchema.safeParse(model)
  if (parsedModel.success && getPrinterControlCapabilities(parsedModel.data).dualNozzles) {
    return [1, 0].map((nozzleId) => ({
      id: buildSliceToolheadId(nozzleId),
      label: formatNozzleLabel(nozzleId, 'long', 2) ?? `Nozzle ${nozzleId + 1}`,
      nozzleDiameter: Number.isFinite(diameter) && diameter > 0 ? diameter : null,
      nozzleFlow,
      position: nozzleId === 1 ? 'left' as const : 'right' as const
    }))
  }
  return [{
    id: 'primary',
    label: 'Primary nozzle',
    nozzleDiameter: Number.isFinite(diameter) && diameter > 0 ? diameter : null,
    nozzleFlow,
    position: 'single' as const
  }]
}

export function buildSliceToolheadId(nozzleId: number): string {
  return `nozzle-${nozzleId}`
}

/**
 * The runtime nozzle id (0 = right, 1 = left) encoded in a `nozzle-<id>` toolhead id, or null
 * for the single-nozzle `primary` id / any non-nozzle toolhead. The inverse of
 * {@link buildSliceToolheadId}; used to carry the editor's toolhead pick into a saved 3MF.
 */
export function parseSliceToolheadNozzleId(toolheadId: string | null | undefined): number | null {
  const match = toolheadId?.match(/^nozzle-(\d+)$/)
  const nozzleId = Number.parseInt(match?.[1] ?? '', 10)
  return Number.isInteger(nozzleId) && nozzleId >= 0 ? nozzleId : null
}

export function normalizedProfileText(value: string): string {
  return value.toLowerCase().replace(/bambu\s+lab/g, '').replace(/[^a-z0-9.]+/g, ' ').trim()
}

export function compactProfileText(value: string): string {
  return normalizedProfileText(value).replace(/\s+/g, '')
}

export function profileTextCandidates(value: string): string[] {
  const normalized = normalizedProfileText(value)
  const compacted = compactProfileText(value)
  return normalized === compacted ? [normalized] : [normalized, compacted]
}

// BambuStudio exposes most compatibility as profile metadata, but some bundled
// profiles still encode model/nozzle hints only in names or condition strings.
// The helpers below prefer explicit metadata and use normalized text matching
// only to mirror BambuStudio's permissive profile-family behavior.

export function printerModelTextCandidates(model: string): string[] {
  if (model === 'unknown') return []
  return Array.from(new Set(resolveBambuPrinterModelAliases(model).flatMap(profileTextCandidates)))
}

export function printerModelCompatibleTextCandidates(model: string): string[] {
  const baseCandidates = printerModelTextCandidates(model)
  const normalized = normalizedProfileText(model)
  const compacted = compactProfileText(model)
  const familyModels = normalized === 'p1s' || normalized === 'p1p' || compacted === 'p1s' || compacted === 'p1p'
    ? ['X1C', 'X1 Carbon']
    : []
  return Array.from(new Set([...baseCandidates, ...familyModels.flatMap(profileTextCandidates)]))
}

export function selectedPrinterCompatibilityTargets(selectedMachineProfile: SlicingProfileSummary | null, model: string): string[] {
  return Array.from(new Set([
    ...(selectedMachineProfile ? [selectedMachineProfile.name, ...(selectedMachineProfile.printerModels ?? [])].flatMap(profileTextCandidates) : []),
    ...printerModelCompatibleTextCandidates(model)
  ]))
}

export function profileTargetMatchesSelectedPrinter(target: string, selectedTargets: string[]): boolean {
  const targetCandidates = profileTextCandidates(target)
  return targetCandidates.some((targetCandidate) => selectedTargets.some((selectedTarget) => targetCandidate.includes(selectedTarget) || selectedTarget.includes(targetCandidate)))
}

export function extractProfilePrinterTargets(profile: SlicingProfileSummary): string[] {
  const explicitTargets = [
    profile.name,
    ...(profile.printerModels ?? []),
    ...(profile.compatiblePrinters ?? []),
    ...(profile.compatiblePrints ?? []),
    profile.compatiblePrintersCondition,
    profile.compatiblePrintsCondition,
    ...extractQuotedCompatibilityTargets(profile.compatiblePrintersCondition),
    ...extractQuotedCompatibilityTargets(profile.compatiblePrintsCondition)
  ].filter((entry): entry is string => Boolean(entry && !looksLikeGenericPrinterTarget(entry)))

  const matches = explicitTargets.flatMap((target) => {
    const normalized = normalizedProfileText(target)
    return KNOWN_BAMBU_PRINTER_MODEL_KEYS.flatMap((model) => {
      const aliases = printerModelTextCandidates(model)
      return aliases.some((candidate) => hasProfileToken(normalized, candidate)) ? aliases : []
    })
  })
  return Array.from(new Set(matches))
}

export function hasProfileToken(value: string, token: string): boolean {
  if (!token) return false
  const normalizedToken = normalizedProfileText(token)
  const compactToken = compactProfileText(token)
  return value.split(/\s+/).includes(normalizedToken) || (compactToken.length > 2 && compactProfileText(value).includes(compactToken))
}

export function extractQuotedCompatibilityTargets(value: string | null | undefined): string[] {
  if (!value) return []
  return Array.from(value.matchAll(/["']([^"']+)["']/g), (match) => match[1]?.trim() ?? '').filter(Boolean)
}

export function looksLikeGenericPrinterTarget(value: string): boolean {
  const normalized = normalizedProfileText(value)
  return normalized === 'default' || normalized === 'default printer' || normalized === 'any printer'
}

export function buildInitialFilamentProfileSelection(file: LibraryFile, bakedIndex: ThreeMfIndex | null, profiles: SlicingProfileSummary[], machineProfile: SlicingProfileSummary | null = null): Record<number, string> {
  if (bakedIndex) return buildBakedFilamentProfileSelection(bakedIndex, profiles, machineProfile)
  const selections: Record<number, string> = {}
  file.projectFilamentChips.forEach((filament, index) => {
    const match = profiles.find((profile) => profile.name.toLowerCase().includes(filament.label.toLowerCase()))
      ?? profiles.find((profile) => filament.label.toLowerCase().includes(profile.name.toLowerCase()))
    if (match) selections[index + 1] = match.id
  })
  return selections
}

export function buildInitialFilamentMaterialOptionSelection(file: LibraryFile, bakedIndex: ThreeMfIndex | null, profiles: SlicingProfileSummary[], machineProfile: SlicingProfileSummary | null = null): Record<number, string> {
  const profileSelections = buildInitialFilamentProfileSelection(file, bakedIndex, profiles, machineProfile)
  return Object.fromEntries(Object.entries(profileSelections).map(([filamentId, profileId]) => [filamentId, buildProfileMaterialOptionId(profileId)]))
}

export function buildBakedFilamentProfileSelection(bakedIndex: ThreeMfIndex, profiles: SlicingProfileSummary[], machineProfile: SlicingProfileSummary | null = null): Record<number, string> {
  const selections: Record<number, string> = {}
  for (const filament of bakedIndex.projectFilaments) {
    // Prefer the project's own filament; when the selected machine is
    // cross-family that preset is filtered out, so fall back to the target
    // machine's default filament profile (matching type) the way BambuStudio
    // does, then to a looser type match.
    const match = pickSlicingProfileByBakedName(profiles, filament.filamentName)
      ?? pickMachineDefaultFilamentProfile(profiles, machineProfile, filament.filamentType)
      ?? pickSlicingProfileByBakedName(profiles, filament.filamentType)
    if (match) selections[filament.id] = match.id
  }
  return selections
}

export function buildInitialFilamentColorSelection(file: LibraryFile, bakedIndex: ThreeMfIndex | null): Record<number, string> {
  const selections: Record<number, string> = {}
  if (bakedIndex?.projectFilaments.length) {
    for (const filament of bakedIndex.projectFilaments) {
      selections[filament.id] = normalizeSliceFilamentColor(filament.color)
    }
    return selections
  }
  file.projectFilamentChips.forEach((filament, index) => {
    selections[index + 1] = normalizeSliceFilamentColor(filament.color)
  })
  return selections
}

export function buildInitialFilamentToolheadSelection(file: LibraryFile, bakedIndex: ThreeMfIndex | null): Record<number, string> {
  const selections: Record<number, string> = {}
  if (bakedIndex?.projectFilaments.length) {
    for (const filament of bakedIndex.projectFilaments) {
      if (filament.nozzleId != null) selections[filament.id] = buildSliceToolheadId(filament.nozzleId)
    }
  }
  return selections
}

/**
 * Whether a plate carries real slice metadata. An UNSLICED plate's filament list
 * is only a geometry estimate built from each object's `extruder` metadata, which
 * captures the base extruder but NOT colour-PAINTED filaments — so it must not be
 * trusted to narrow a project's material/mapping list (it would hide a painted
 * secondary colour). A SLICED plate's `slice_info` records exact per-plate usage.
 */
export function plateHasSliceData(plate: ThreeMfPlate | null | undefined): boolean {
  if (!plate) return false
  return plate.weight != null
    || plate.prediction != null
    || plate.filaments.some((filament) => filament.usedGrams != null)
}

export function buildSliceDialogProjectFilaments(
  file: LibraryFile,
  bakedIndex: ThreeMfIndex | null,
  selectedPlate: number
): Array<{ projectFilamentId: number; label: string; color: string | null; nozzleId: number | null; usedOnSelectedPlate: boolean }> {
  if (bakedIndex?.projectFilaments.length) {
    // BambuStudio shows every project material at all times; we mirror that and
    // flag which ones the currently-selected plate actually uses (material/color
    // edits affect the 3D preview regardless of the active plate).
    const selectedPlateData = bakedIndex.plates.find((plate) => plate.index === selectedPlate)
    // Only trust the plate's filament list to flag per-plate usage when the plate is
    // actually sliced. An UNSLICED plate's list is a geometry estimate from object
    // extruder ids that misses colour-PAINTED filaments, so narrowing to it would
    // wrongly drop a painted secondary colour (e.g. black on a white base) from the
    // print/slice material list. With no trustworthy per-plate data, treat every
    // project material as in use.
    const platedFilamentIds = plateHasSliceData(selectedPlateData)
      ? selectedPlateData!.filaments.map((filament) => filament.id)
      : []
    const usedOnPlate = new Set(platedFilamentIds)
    // Support materials are referenced by process SETTINGS (support_filament /
    // support_interface_filament), not by any object's extruder id, so a plate's sliced
    // filament list omits them until a slice actually consumed them. Without this a material
    // assigned as the support interface is missing from the print dialog entirely — it cannot be
    // mapped to a tray, and the print goes out without it. Union only when the plate HAS slice
    // data: with none, every material is already treated as in use below.
    if (platedFilamentIds.length > 0) {
      for (const id of bakedIndex.supportFilamentIds ?? []) usedOnPlate.add(id)
    }
    return bakedIndex.projectFilaments.map((filament) => ({
      projectFilamentId: filament.id,
      label: filament.filamentName ?? filament.filamentType ?? `Filament ${filament.id}`,
      color: filament.color,
      nozzleId: filament.nozzleId ?? null,
      usedOnSelectedPlate: platedFilamentIds.length === 0 ? true : usedOnPlate.has(filament.id)
    }))
  }
  return file.projectFilamentChips.map((filament, index) => ({
    ...filament,
    projectFilamentId: index + 1,
    nozzleId: null,
    usedOnSelectedPlate: true
  }))
}

export function buildFilamentMappings(
  projectFilaments: Array<{ projectFilamentId: number; label: string; color: string | null; nozzleId: number | null }>,
  optionIds: Record<number, string>,
  colors: Record<number, string>,
  toolheadIds: Record<number, string>,
  materialOptions: SliceMaterialOption[],
  /** Per-material filament setting overrides (from the material "tune" dialog), keyed by projectFilamentId. */
  settingOverridesById: Record<number, Record<string, string | string[]>> = {}
) {
  return projectFilaments.flatMap((filament) => {
    const optionId = optionIds[filament.projectFilamentId]
    if (!optionId) return []
    const option = materialOptions.find((entry) => entry.id === optionId)
    if (!option) return []
    const overrides = settingOverridesById[filament.projectFilamentId]
    return [{
      projectFilamentId: filament.projectFilamentId,
      profileId: option.profileId ?? undefined,
      source: option.source,
      trayId: option.trayId,
      toolheadId: toolheadIds[filament.projectFilamentId] || option.toolheadId || (filament.nozzleId != null ? buildSliceToolheadId(filament.nozzleId) : undefined),
      material: option.material ?? option.label ?? filament.label,
      color: normalizeSliceFilamentColor(colors[filament.projectFilamentId] ?? filament.color),
      settingOverrides: overrides && Object.keys(overrides).length > 0 ? overrides : undefined
    }]
  })
}

export function buildSliceMaterialOptions(profiles: SlicingProfileSummary[], loadedMaterials: SliceMaterialOption[]): SliceMaterialOption[] {
  const profileOptions = profiles.map((profile) => ({
    id: buildProfileMaterialOptionId(profile.id),
    label: formatSlicingProfileDisplayName(profile),
    group: isProjectSlicingProfile(profile) ? '3MF project profiles' : profile.source === 'custom' ? 'Workspace profiles' : 'Built-in profiles',
    materialType: resolveProfileMaterialType(profile),
    brand: resolveProfileMaterialBrand(profile),
    profileId: isProjectSlicingProfile(profile) ? null : profile.id,
    material: profile.name,
    color: null,
    colors: [],
    source: 'manual' as const,
    trayId: null,
    nozzleId: null,
    toolheadId: null,
    metadata: formatSlicingProfileMetadata(profile),
    slotLabel: null,
    presetLabel: formatSlicingProfileDisplayName(profile),
    colorName: null,
    remainingGrams: null,
    remainPercent: null
  }))
  return [...loadedMaterials, ...dedupeSliceMaterialProfileOptions(profileOptions)]
}

/**
 * Find a filament profile by name — full name or vendor-stripped display name —
 * e.g. a spool's pinned slicing preset. Display-name matching lets a pin like
 * "Generic PLA" resolve to whichever machine-compatible variant is in the
 * (already machine-filtered) list, so pins stay portable across printers.
 */
function findProfileByName(profiles: SlicingProfileSummary[], name: string | null | undefined): SlicingProfileSummary | null {
  const normalized = name ? normalizeProfileText(name) : ''
  if (!normalized) return null
  return profiles.find((profile) => profile.kind === 'filament' && normalizeProfileText(profile.name) === normalized)
    ?? profiles.find((profile) => profile.kind === 'filament' && normalizeProfileText(formatSlicingProfileDisplayName(profile)) === normalized)
    ?? null
}

export function dedupeSliceMaterialProfileOptions(options: SliceMaterialOption[]): SliceMaterialOption[] {
  const byDisplayKey = new Map<string, SliceMaterialOption>()
  for (const option of options) {
    const key = [option.group, option.label, option.materialType, option.brand, option.metadata].join('\u0000')
    if (!byDisplayKey.has(key)) byDisplayKey.set(key, option)
  }
  return [...byDisplayKey.values()]
}

/**
 * The slice of a printer's status that drives loaded-material options. Extracted
 * so the material dropdown only re-derives when the AMS / external spool / nozzle
 * data changes, instead of on every status frame (temperatures, progress, etc.).
 */
export interface LoadedMaterialSource {
  ams: PrinterStatus['ams']
  externalSpools: PrinterStatus['externalSpools']
  nozzleCount: number | null
}

export function buildLoadedPrinterMaterialOptions(
  source: LoadedMaterialSource | null,
  profiles: SlicingProfileSummary[],
  selectedMachineProfile: SlicingProfileSummary | null,
  selectedPrinterModel: string,
  /** Tracked-spool resolution (core slotFilamentIdentity registry); optional so pure callers/tests can omit it. */
  spoolContext?: { printerId: string | null; resolveSpool: SlotFilamentIdentityLookup } | null
): SliceMaterialOption[] {
  if (!source) return []
  const options: SliceMaterialOption[] = []
  const nozzleCount = source.nozzleCount
  for (const unit of source.ams) {
    const group = formatPrinterMaterialSourceGroup(`AMS ${amsUnitLetter(unit.unitId)}`, unit.nozzleId, nozzleCount)
    for (const slot of unit.slots) {
      if (slot.occupied === false || !hasLoadedMaterialDetails(slot.trayName, slot.filamentType, slot.color)) continue
      const fallbackLabel = slot.trayName?.trim() || slot.filamentType?.trim() || `AMS ${unit.unitId + 1} slot ${slot.slot + 1}`
      // The FILAMENT's own resolved identity — tracked spool first, then the
      // tray — is authoritative for who the filament is (label, brand, colour
      // naming); a matched profile only decides which slicing preset to use.
      // Deriving the brand/label from the profile is what labelled custom
      // filament "Bambu Lab ..." and unlocked marketing colours.
      const spool = spoolContext?.resolveSpool(spoolContext.printerId, unit.unitId, slot.slot) ?? null
      const identity = resolveFilamentIdentity({ ...slot, spool })
      // A spool pinned to a slicing preset uses it outright (the caller's profile
      // list is already machine-filtered, so an incompatible pin simply doesn't
      // resolve and falls back to the auto-match).
      const pinnedProfile = findProfileByName(profiles, spool?.slicingPresetName)
      const preset = pinnedProfile
        ? { name: pinnedProfile.name, profile: pinnedProfile }
        : resolveLoadedMaterialPreset(profiles, {
            trayName: slot.trayName,
            trayInfoIdx: slot.trayInfoIdx,
            trayFilamentType: slot.filamentType,
            selectedMachineProfile,
            selectedPrinterModel
          })
      const identityMaterial = identity.presetName
        ?? ([identity.brand, identity.subtype ?? identity.type].filter(Boolean).join(' ') || null)
      // A tracked spool names the row outright ("Michael's PLA"); otherwise the
      // matched preset names it, with the tray identity as the last fallback.
      const label = spool
        ? identityMaterial ?? fallbackLabel
        : preset.profile ? formatSlicingProfileDisplayName(preset.profile) : identityMaterial ?? fallbackLabel
      const color = normalizeSliceFilamentColor(identity.colorHex ?? slot.color ?? slot.colors[0] ?? null)
      const trayId = amsTrayIndex(unit.type, unit.unitId, slot.slot)
      options.push({
        id: `loaded:ams:${unit.unitId}:${slot.slot}:${preset.profile?.id ?? preset.name ?? fallbackLabel}:${color}`,
        label,
        group,
        materialType: resolveLoadedMaterialType(slot.filamentType, preset.profile, preset.name ?? label),
        brand: identity.brand ?? '',
        profileId: preset.profile?.id ?? null,
        material: preset.profile ? preset.name ?? label : identityMaterial ?? slot.filamentType?.trim() ?? label,
        color,
        colors: identity.colors.length > 0 ? identity.colors : slot.colors,
        source: 'ams',
        trayId,
        nozzleId: unit.nozzleId,
        toolheadId: unit.nozzleId != null ? buildSliceToolheadId(unit.nozzleId) : null,
        metadata: [
          `Slot ${slot.slot + 1}`,
          identity.colorName,
          spool && preset.profile ? formatSlicingProfileDisplayName(preset.profile) : null
        ].filter(Boolean).join(' - '),
        slotLabel: `${amsUnitLetter(unit.unitId)}${slot.slot + 1}`,
        presetLabel: preset.profile ? formatSlicingProfileDisplayName(preset.profile) : null,
        colorName: identity.colorName,
        remainingGrams: spool?.remainingGrams ?? null,
        remainPercent: spool?.remainPercent ?? null
      })
    }
  }
  for (const spool of source.externalSpools) {
    if (!hasLoadedMaterialDetails(spool.trayName, spool.filamentType, spool.color)) continue
    const fallbackLabel = spool.trayName?.trim() || spool.filamentType?.trim() || 'External spool'
    // Same rule as AMS slots: the filament's identity (tracked spool first,
    // then the tray) names the row; the matched profile only supplies the
    // slicing preset. External spools track with a null slot id.
    const trackedSpool = spoolContext?.resolveSpool(spoolContext.printerId, spool.amsId, null) ?? null
    const identity = resolveFilamentIdentity({ ...spool, spool: trackedSpool })
    const pinnedProfile = findProfileByName(profiles, trackedSpool?.slicingPresetName)
    const preset = pinnedProfile
      ? { name: pinnedProfile.name, profile: pinnedProfile }
      : resolveLoadedMaterialPreset(profiles, {
          trayName: spool.trayName,
          trayInfoIdx: spool.trayInfoIdx,
          trayFilamentType: spool.filamentType,
          selectedMachineProfile,
          selectedPrinterModel
        })
    const identityMaterial = identity.presetName
      ?? ([identity.brand, identity.subtype ?? identity.type].filter(Boolean).join(' ') || null)
    const label = trackedSpool
      ? identityMaterial ?? fallbackLabel
      : preset.profile ? formatSlicingProfileDisplayName(preset.profile) : identityMaterial ?? fallbackLabel
    const color = normalizeSliceFilamentColor(identity.colorHex ?? spool.color ?? spool.colors[0] ?? null)
    const sourceLabel = spool.amsId === 254 ? 'Left external spool' : spool.amsId === 255 ? 'Right external spool' : 'External spool'
    options.push({
      id: `loaded:external:${spool.amsId}:${preset.profile?.id ?? preset.name ?? fallbackLabel}:${color}`,
      label,
      group: formatPrinterMaterialSourceGroup(sourceLabel, spool.nozzleId, nozzleCount),
      materialType: resolveLoadedMaterialType(spool.filamentType, preset.profile, preset.name ?? label),
      brand: identity.brand ?? '',
      profileId: preset.profile?.id ?? null,
      material: preset.profile ? preset.name ?? label : identityMaterial ?? spool.filamentType?.trim() ?? label,
      color,
      colors: identity.colors.length > 0 ? identity.colors : spool.colors,
      source: 'externalSpool',
      trayId: spool.amsId,
      nozzleId: spool.nozzleId,
      toolheadId: spool.nozzleId != null ? buildSliceToolheadId(spool.nozzleId) : null,
      metadata: [
        sourceLabel,
        identity.colorName,
        trackedSpool && preset.profile ? formatSlicingProfileDisplayName(preset.profile) : null
      ].filter(Boolean).join(' - '),
      slotLabel: source.externalSpools.length > 1 ? (spool.amsId === 255 ? 'Ext-R' : 'Ext-L') : 'Ext',
      presetLabel: preset.profile ? formatSlicingProfileDisplayName(preset.profile) : null,
      colorName: identity.colorName,
      remainingGrams: trackedSpool?.remainingGrams ?? null,
      remainPercent: trackedSpool?.remainPercent ?? null
    })
  }
  return options
}

export function formatPrinterMaterialSourceGroup(label: string, nozzleId: number | null, nozzleCount: number | null): string {
  const nozzleLabel = formatPrinterMaterialNozzleLabel(nozzleId, 'long', nozzleCount)
  return [label, nozzleLabel].filter(Boolean).join(' · ')
}

export function formatPrinterMaterialNozzleLabel(nozzleId: number | null, variant: 'short' | 'long', nozzleCount: number | null): string | null {
  if (nozzleCount == null || nozzleCount <= 1) return null
  return formatNozzleLabel(nozzleId, variant, nozzleCount)
}

export function groupSliceMaterialOptionsByGroup(options: SliceMaterialOption[]): Array<{ label: string; options: SliceMaterialOption[] }> {
  const groups: Array<{ label: string; options: SliceMaterialOption[] }> = []
  for (const option of options) {
    const label = option.group || 'Loaded in selected printer'
    let group = groups.find((entry) => entry.label === label)
    if (!group) {
      group = { label, options: [] }
      groups.push(group)
    }
    group.options.push(option)
  }
  return groups
}

export function resolveMaterialTypeOptions(options: SliceMaterialOption[]): string[] {
  return sortMaterialTypesByBambuStudioOrder(Array.from(new Set(options.map((option) => option.materialType).filter(Boolean))))
}

export function sortMaterialTypesByBambuStudioOrder(values: string[]): string[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  return [...values].sort((left, right) => {
    const leftRank = bambuStudioMaterialTypeRank(left)
    const rightRank = bambuStudioMaterialTypeRank(right)
    if (leftRank !== rightRank) return leftRank - rightRank
    return collator.compare(left, right)
  })
}

export function bambuStudioMaterialTypeRank(value: string): number {
  const normalized = normalizedProfileText(value).toUpperCase()
  const exactRank = BAMBU_STUDIO_MATERIAL_TYPE_ORDER.indexOf(normalized)
  if (exactRank !== -1) return exactRank
  const familyRank = BAMBU_STUDIO_MATERIAL_TYPE_ORDER.findIndex((type) => normalized.startsWith(`${type} `))
  if (familyRank !== -1) return familyRank
  if (normalized === 'OTHER') return 100
  return 99
}

export function narrowMaterialOptions(options: SliceMaterialOption[], materialType: string, keepId?: string | null): SliceMaterialOption[] {
  // Always keep the currently-selected option even when the type filter would exclude it,
  // so it stays visible in the dropdown and the Autocomplete's value is never absent from
  // its options (which otherwise logs a "value provided is invalid" warning). Filtering the
  // already-grouped `options` in place preserves group ordering, so no duplicate headers.
  return options.filter((option) => !materialType || option.materialType === materialType || option.id === keepId)
}

export function resolveProfileMaterialType(profile: SlicingProfileSummary): string {
  return normalizeMaterialTypeLabel(profile.filamentType) ?? extractMaterialType(profile.name)
}

export function resolveLoadedMaterialType(filamentType: string | null | undefined, profile: SlicingProfileSummary | null | undefined, fallbackLabel: string): string {
  return normalizeMaterialTypeLabel(filamentType)
    ?? normalizeMaterialTypeLabel(profile?.filamentType)
    ?? extractMaterialType(fallbackLabel)
}

export function extractMaterialType(value: string): string {
  // Fallback only: BambuStudio's `filament_type` is preferred when present,
  // but project profiles from 3MFs may only expose a display name. This list
  // mirrors BambuStudio's filament_type enum, with local AMS families appended.
  const normalized = normalizedProfileText(value).toUpperCase()
  if (normalized.includes('SUPPORT')) return 'SUPPORT'
  for (const type of BAMBU_STUDIO_MATERIAL_TYPE_MATCH_ORDER) {
    const normalizedType = normalizedProfileText(type).toUpperCase()
    if (new RegExp(`(^|[^A-Z0-9])${escapeRegExp(normalizedType)}([^A-Z0-9]|$)`).test(normalized)) return type
  }
  return 'Other'
}

export function normalizeMaterialTypeLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed || normalizedProfileText(trimmed) === 'other') return null
  return trimmed
}

export const BAMBU_STUDIO_MATERIAL_TYPE_ORDER = [
  'PLA', 'ABS', 'ASA', 'ASA-CF', 'PETG', 'PCTG', 'TPU', 'TPU-AMS', 'PC', 'PA', 'PA-CF', 'PA-GF', 'PA6-CF',
  'PLA-CF', 'PET-CF', 'PETG-CF', 'PVA', 'HIPS', 'PLA-AERO', 'PPS', 'PPS-CF', 'PPA-CF', 'PPA-GF', 'ABS-GF',
  'ASA-AERO', 'PE', 'PP', 'EVA', 'PHA', 'BVOH', 'PE-CF', 'PP-CF', 'PP-GF', 'PA6-GF', 'PAHT-CF', 'PA12-CF', 'PA612-CF', 'PETG-ESD'
]

export const BAMBU_STUDIO_MATERIAL_TYPE_MATCH_ORDER = [...BAMBU_STUDIO_MATERIAL_TYPE_ORDER].sort((left, right) => right.length - left.length)

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function resolveProfileMaterialBrand(profile: SlicingProfileSummary): string {
  return profile.filamentVendor?.trim() || extractMaterialBrand(profile.name)
}

export function extractMaterialBrand(value: string): string {
  // Fallback only: BambuStudio's `filament_vendor` is preferred when present.
  // Internal ids such as `fdm_filament_*` are profile keys, not user brands.
  const beforeAt = value.split('@')[0]?.trim() ?? value
  const words = beforeAt.split(/\s+/).filter(Boolean)
  if (words.length === 0) return 'Other'
  const first = words[0] as string
  if (/^(?:fdm_)?filament_/i.test(first)) return 'Other'
  if (/^(generic|bambu|polymaker|esun|sunlu|overture|prusament|hatchbox|flashforge)$/i.test(first)) {
    return first.replace(/^bambu$/i, 'Bambu')
  }
  return /^[A-Z0-9-]+$/.test(first) ? 'Other' : first
}

export function buildProfileMaterialOptionId(profileId: string): string {
  return `profile:${profileId}`
}

export function hasLoadedMaterialDetails(trayName: string | null, filamentType: string | null, color: string | null): boolean {
  return Boolean(trayName?.trim() || filamentType?.trim() || color?.trim())
}

export function normalizeSliceFilamentColor(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? ''
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase()
  if (/^[0-9a-fA-F]{6}$/.test(trimmed)) return `#${trimmed.toLowerCase()}`
  if (/^#[0-9a-fA-F]{8}$/.test(trimmed)) return `#${trimmed.slice(1, 7).toLowerCase()}`
  if (/^[0-9a-fA-F]{8}$/.test(trimmed)) return `#${trimmed.slice(0, 6).toLowerCase()}`
  return '#808080'
}

export function ensureOptionValues(values: string[], fallbacks: string[]): string[] {
  return Array.from(new Set([...values.filter(Boolean), ...fallbacks]))
}

export function resolveInitialManualPrinterModel(file: LibraryFile, machineProfiles: SlicingProfileSummary[], fallback?: Printer['model']): string {
  // Default to the 3MF's own printer model so the editor bed matches the project
  // (e.g. an H2D 3MF shows an H2D plate), not whichever model sorts first once the
  // user's connected printers are merged into the option list.
  const source = normalizeBambuStudioPrinterModelOption(file.compatiblePrinterModels[0] ?? '')
  if (isVisibleBambuStudioPrinterModel(source)) return source
  return ensurePrinterModelOptions(file.compatiblePrinterModels, fallback, machineProfiles)[0] ?? 'unknown'
}

export function ensurePrinterModelOptions(values: readonly string[], fallback?: string, machineProfiles: SlicingProfileSummary[] = []): string[] {
  const machineModels = machineProfiles.flatMap(extractMachineProfilePrinterModelOptions)
  const knownModels = [...values, fallback, ...machineModels]
    .map((value) => normalizeBambuStudioPrinterModelOption(value ?? ''))
    .filter(isVisibleBambuStudioPrinterModel)
  const uniqueKnownModels = Array.from(new Set(knownModels))
  return uniqueKnownModels.length > 0 ? sortPrinterModelOptions(uniqueKnownModels) : ['unknown']
}

export function extractMachineProfilePrinterModelOptions(profile: SlicingProfileSummary): string[] {
  const fromName = extractPrinterModelLabelFromProfileName(profile.name)
  return [...(profile.printerModels ?? []), ...(fromName ? [fromName] : [])]
}

export function extractPrinterModelLabelFromProfileName(value: string): string | null {
  if (looksLikeBambuStudioBaseMachineProfile(value)) return null
  const label = normalizeBambuStudioPrinterModelOption(value)
    .replace(/\b\d+(?:\.\d+)?\s*(?:mm\s*)?nozzle\b/gi, '')
    .replace(/@BBL\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  return isVisibleBambuStudioPrinterModel(label) ? label : null
}

export function isVisibleBambuStudioPrinterModel(value: string): boolean {
  if (!value || value === 'unknown') return false
  const normalized = normalizedProfileText(value)
  if (!normalized) return false
  if (looksLikeBambuStudioBaseMachineProfile(value)) return false
  if (/^(?:fdm|template|default|generic)(?:_|\b)/.test(normalized)) return false
  if (normalized.includes('template')) return false
  return /^(?:a|p|h|x)\d/.test(normalized)
}

export function looksLikeBambuStudioBaseMachineProfile(value: string): boolean {
  const normalized = normalizedProfileText(value)
  const compacted = compactProfileText(value)
  return /^(?:fdm|template|default|generic)(?:_|\b)/.test(value.trim().toLowerCase())
    || /^(?:fdm|template|default|generic)(?:\s|$)/.test(normalized)
    || compacted.includes('template')
}

export function sortPrinterModelOptions(values: string[]): string[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  return [...values].sort((left, right) => {
    const leftRank = printerModelSortRank(left)
    const rightRank = printerModelSortRank(right)
    if (leftRank !== rightRank) return leftRank - rightRank
    return collator.compare(formatPrinterModelLabel(left), formatPrinterModelLabel(right))
  })
}

export function printerModelSortRank(value: string): number {
  const normalized = normalizedProfileText(value)
  if (normalized.startsWith('a')) return 0
  if (normalized.startsWith('p')) return 1
  if (normalized.startsWith('h')) return 2
  if (normalized.startsWith('x')) return 3
  if (normalized === 'unknown') return 100
  return 50
}

export function formatSlicingProfileMetadata(profile: SlicingProfileSummary): string {
  const parts = [
    profile.nozzleDiameters?.length ? `Nozzle ${profile.nozzleDiameters.map((entry) => `${entry} mm`).join(', ')}` : null,
    profile.plateTypes?.length ? profile.plateTypes.map(formatPlateTypeLabel).join(', ') : null,
    profile.compatiblePrintersCondition ? 'Conditional printer compatibility' : null,
    profile.compatiblePrintsCondition ? 'Conditional quality compatibility' : null
  ].filter((entry): entry is string => Boolean(entry))
  return parts.length > 0 ? parts.join(' · ') : isProjectSlicingProfile(profile) ? '3MF project profile' : profile.source === 'custom' ? 'Workspace profile' : 'Built-in profile'
}

export function dedupeVisibleProcessProfiles(
  profiles: SlicingProfileSummary[],
  selectedMachineProfile: SlicingProfileSummary | null,
  model: string
): SlicingProfileSummary[] {
  const byDisplayName = new Map<string, SlicingProfileSummary>()
  for (const profile of profiles) {
    const key = formatSlicingProfileDisplayName(profile).trim().toLowerCase()
    const existing = byDisplayName.get(key)
    if (!existing) {
      byDisplayName.set(key, profile)
      continue
    }
    // The 3MF-embedded (project:) profile carries the project's overridden settings.
    // BambuStudio loads those embedded settings on open even when a same-named installed
    // preset exists, so never let a same-named installed preset displace it.
    const profileIsProject = isProjectSlicingProfile(profile)
    const existingIsProject = isProjectSlicingProfile(existing)
    if (profileIsProject !== existingIsProject) {
      if (profileIsProject) byDisplayName.set(key, profile)
      continue
    }
    if (scoreVisibleProcessProfile(profile, selectedMachineProfile, model) > scoreVisibleProcessProfile(existing, selectedMachineProfile, model)) {
      byDisplayName.set(key, profile)
    }
  }
  return [...byDisplayName.values()]
}

export function scoreVisibleProcessProfile(
  profile: SlicingProfileSummary,
  selectedMachineProfile: SlicingProfileSummary | null,
  model: string
): number {
  let score = profile.source === 'custom' ? 100 : 0
  if (matchesSelectedProcessPrimaryPrinterModel(profile, model)) score += 50
  if (matchesSelectedProcessMachineProfile(profile, selectedMachineProfile, model)) score += 30
  if (matchesSelectedProcessCompatiblePrinter(profile, model)) score += 20
  if ((profile.printerModels?.length ?? 0) > 0) score += 10
  if ((profile.compatiblePrinters?.length ?? 0) > 0) score += 5
  score -= (profile.printerModels?.length ?? 0) + (profile.compatiblePrinters?.length ?? 0)
  return score
}

export function matchesSelectedProcessPrimaryPrinterModel(profile: SlicingProfileSummary, model: string): boolean {
  if (model === 'unknown') return false
  const modelTargets = new Set(printerModelTextCandidates(model))
  return [profile.name, ...(profile.printerModels ?? [])].some((entry) => profileTextCandidates(entry).some((candidate) => modelTargets.has(candidate)))
}

export function matchesSelectedProcessCompatiblePrinter(profile: SlicingProfileSummary, model: string): boolean {
  if (model === 'unknown') return false
  const modelTargets = new Set(printerModelTextCandidates(model))
  return (profile.compatiblePrinters ?? []).some((entry) => profileTextCandidates(entry).some((candidate) => modelTargets.has(candidate)))
}

export function matchesSelectedProcessMachineProfile(
  profile: SlicingProfileSummary,
  selectedMachineProfile: SlicingProfileSummary | null,
  model: string
): boolean {
  if (!selectedMachineProfile) return false
  const selectedTargets = selectedPrinterCompatibilityTargets(selectedMachineProfile, model)
  return (profile.compatiblePrinters ?? []).some((entry) => entry.trim() === selectedMachineProfile.name || profileTargetMatchesSelectedPrinter(entry, selectedTargets))
}

export function formatPlateTypeLabel(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.toUpperCase() === 'PEI' ? 'PEI' : part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function formatPrinterModelLabel(value: string): string {
  return value === 'unknown' ? 'Unknown' : value
}
