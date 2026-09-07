/**
 * Does a slicing preset target the selected printer?
 *
 * OWNS the text/model matching behind BambuStudio's `compatible_printers` condition: normalizing
 * preset and machine names into comparable candidates, and deciding whether a preset's declared
 * target names the machine actually selected.
 *
 * Extracted from `slicingPresetMatching` so `filamentPresetResolver` can apply compatibility as a
 * FILTER without a cycle, that module imports the resolver, so the resolver could not import the
 * check back. Which is why compatibility used to be a soft RANK inside the resolver rather than a
 * filter: presets targeting other printers stayed eligible and were merely outscored. BambuStudio
 * never offers an incompatible preset in the first place, so a rank was ours, not its.
 *
 * Depends only on `@printstream/shared` and the printer-model alias table, and must stay that way:
 * anything it imports becomes importable by the resolver.
 *
 * EVERYTHING HERE IS MEMOIZED, because this runs over the WHOLE filament catalogue on a hot path.
 * `SliceFileModal`'s `compatibleFilamentProfiles` filters ~2,100 installed presets, and a CPU
 * profile of the editor sitting idle put ~43% of all non-idle samples in this file's three string
 * helpers -- one evaluation of that filter measured 32 ms, of which 31 ms was
 * `extractProfilePrinterTargets`. The work was almost entirely re-derivation: the alias candidates
 * for the 14 known models were rebuilt for every (profile x target) pair, and the same preset names
 * were re-normalized thousands of times per pass. Nothing here depends on anything but its
 * arguments, so all of it caches.
 *
 * THE CACHES ASSUME PRESET DTOs ARE IMMUTABLE. They come from the React Query cache, which treats
 * its data as immutable, so a `SlicingPresetSummary` is never edited in place -- a re-fetch produces
 * a new object. Mutating one after it has been asked about would return stale targets. Revisit if
 * presets ever become editable in place rather than replaced.
 *
 * The cached arrays are shared with every caller and MUST BE TREATED AS READ-ONLY.
 */
import type { SlicingPresetSummary } from '@printstream/shared'
import { KNOWN_BAMBU_PRINTER_MODEL_KEYS, bambuModelKeysAreCompatible, canonicalBambuModelKey, resolveBambuPrinterModelAliases } from './bambuPrinterModels'

/**
 * Cap for the string-keyed caches below.
 *
 * The real input set is bounded (preset and machine names, a few thousand at most), but these are
 * exported helpers and nothing stops a caller passing free text, so the caches drop everything
 * rather than grow without limit. A clear costs one repopulating pass, which is the same work the
 * cache existed to save -- acceptable at a ceiling an ordinary catalogue never reaches.
 */
const MAX_TEXT_CACHE_ENTRIES = 20_000

const normalizedTextCache = new Map<string, string>()
const compactTextCache = new Map<string, string>()

export function normalizedProfileText(value: string): string {
  const cached = normalizedTextCache.get(value)
  if (cached !== undefined) return cached
  const normalized = value.toLowerCase().replace(/bambu\s+lab/g, '').replace(/[^a-z0-9.]+/g, ' ').trim()
  if (normalizedTextCache.size >= MAX_TEXT_CACHE_ENTRIES) normalizedTextCache.clear()
  normalizedTextCache.set(value, normalized)
  return normalized
}

export function compactProfileText(value: string): string {
  const cached = compactTextCache.get(value)
  if (cached !== undefined) return cached
  const compacted = normalizedProfileText(value).replace(/\s+/g, '')
  if (compactTextCache.size >= MAX_TEXT_CACHE_ENTRIES) compactTextCache.clear()
  compactTextCache.set(value, compacted)
  return compacted
}

export function profileTextCandidates(value: string): string[] {
  const normalized = normalizedProfileText(value)
  const compacted = compactProfileText(value)
  return normalized === compacted ? [normalized] : [normalized, compacted]
}

/**
 * Containment that respects token boundaries, so a model name never matches a longer one that
 * merely starts the same way (`A1` inside `A10`). A digit run is never split, and a change of
 * character class counts as a boundary.
 */
export function tokenBoundaryIncludes(container: string, contained: string): boolean {
  if (contained.length === 0 || contained.length > container.length) return false
  const classOf = (char: string): 'letter' | 'digit' | 'other' =>
    /[a-z]/.test(char) ? 'letter' : /[0-9]/.test(char) ? 'digit' : 'other'
  for (let start = container.indexOf(contained); start !== -1; start = container.indexOf(contained, start + 1)) {
    const end = start + contained.length
    const leftBoundary = start === 0
      || classOf(container[start - 1]!) === 'other'
      || classOf(container[start - 1]!) !== classOf(contained[0]!)
    const rightBoundary = end === container.length
      || classOf(container[end]!) === 'other'
      || classOf(container[end]!) !== classOf(contained[contained.length - 1]!)
    if (leftBoundary && rightBoundary) return true
  }
  return false
}

/** Two-way token-boundary containment (either text containing the other counts as a match). */
export function textCandidatesMatch(a: string, b: string): boolean {
  return tokenBoundaryIncludes(a, b) || tokenBoundaryIncludes(b, a)
}

const NO_TEXT_CANDIDATES: string[] = []
const modelTextCandidateCache = new Map<string, string[]>()

/** Read-only: the returned array is shared with every other caller for the same model. */
export function printerModelTextCandidates(model: string): string[] {
  if (model === 'unknown') return NO_TEXT_CANDIDATES
  const cached = modelTextCandidateCache.get(model)
  if (cached !== undefined) return cached
  const candidates = Array.from(new Set(resolveBambuPrinterModelAliases(model).flatMap(profileTextCandidates)))
  if (modelTextCandidateCache.size >= MAX_TEXT_CACHE_ENTRIES) modelTextCandidateCache.clear()
  modelTextCandidateCache.set(model, candidates)
  return candidates
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

/**
 * One-entry memo. The selected machine and model are FIXED across a catalogue filter, so this was
 * being rebuilt identically once per preset -- 2,100 times per pass, twice each (once for
 * `matchesCompatiblePrinters` and once for `matchesProfilePrinterTarget`).
 */
let lastSelectedTargets: { profile: SlicingPresetSummary | null; model: string; targets: string[] } | null = null

/** Read-only: the returned array is shared with every caller for the same (machine, model) pair. */
export function selectedPrinterCompatibilityTargets(selectedMachineProfile: SlicingPresetSummary | null, model: string): string[] {
  if (lastSelectedTargets && lastSelectedTargets.profile === selectedMachineProfile && lastSelectedTargets.model === model) {
    return lastSelectedTargets.targets
  }
  const targets = Array.from(new Set([
    ...(selectedMachineProfile ? [selectedMachineProfile.name, ...(selectedMachineProfile.printerModels ?? [])].flatMap(profileTextCandidates) : []),
    ...printerModelCompatibleTextCandidates(model)
  ]))
  lastSelectedTargets = { profile: selectedMachineProfile, model, targets }
  return targets
}

export function profileTargetMatchesSelectedPrinter(target: string, selectedTargets: string[]): boolean {
  const targetCandidates = profileTextCandidates(target)
  return targetCandidates.some((targetCandidate) => selectedTargets.some((selectedTarget) => textCandidatesMatch(targetCandidate, selectedTarget)))
}

/**
 * Whether a preset's declared `compatible_printers` names the selected machine.
 *
 * Absence is NOT a mismatch: a preset declaring no targets stays eligible, since plenty of
 * user-authored presets carry none and refusing them would resolve nothing.
 */
export function matchesCompatiblePrinters(profile: SlicingPresetSummary, selectedMachineProfile: SlicingPresetSummary | null, model: string): boolean {
  const compatiblePrinters = profile.compatiblePrinters ?? []
  if (compatiblePrinters.length === 0) return true
  if (!selectedMachineProfile) return model === 'unknown'
  const selectedTargets = selectedPrinterCompatibilityTargets(selectedMachineProfile, model)
  // The machine profile is what is actually sent to the slicer, so it is the
  // authority for compatibility. Deriving the key from `model` first let a
  // model/machine mismatch (e.g. model "A1" while the machine profile is "A1 mini")
  // accept a full-A1 filament against an A1-mini machine: BambuStudio then rejects
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

export function looksLikeGenericPrinterTarget(value: string): boolean {
  const normalized = normalizedProfileText(value)
  return normalized === 'default' || normalized === 'default printer' || normalized === 'any printer'
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

/**
 * Alias candidates for every known model, derived once.
 *
 * Was `KNOWN_BAMBU_PRINTER_MODEL_KEYS.flatMap(...)` INSIDE the per-target loop below, so the whole
 * 14-model table was rebuilt for every declared target of every preset in the catalogue.
 */
let knownModelAliasCandidates: string[][] | null = null

function knownModelAliases(): string[][] {
  knownModelAliasCandidates ??= KNOWN_BAMBU_PRINTER_MODEL_KEYS.map((model) => printerModelTextCandidates(model))
  return knownModelAliasCandidates
}

/**
 * Keyed on the preset OBJECT, which is safe only because preset DTOs are immutable (see the module
 * header). Weak so a stale catalogue is collectable rather than pinned for the session.
 */
const profileTargetCache = new WeakMap<SlicingPresetSummary, string[]>()

/** Read-only: the returned array is shared with every caller asking about this preset. */
export function extractProfilePrinterTargets(profile: SlicingPresetSummary): string[] {
  const cached = profileTargetCache.get(profile)
  if (cached !== undefined) return cached
  const targets = computeProfilePrinterTargets(profile)
  profileTargetCache.set(profile, targets)
  return targets
}

function computeProfilePrinterTargets(profile: SlicingPresetSummary): string[] {
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
    return knownModelAliases().flatMap((aliases) => (
      aliases.some((candidate) => hasProfileToken(normalized, candidate)) ? aliases : []
    ))
  })
  return Array.from(new Set(matches))
}

export function matchesProfilePrinterTarget(profile: SlicingPresetSummary, selectedMachineProfile: SlicingPresetSummary | null, model: string): boolean {
  if (model === 'unknown' && !selectedMachineProfile) return true
  const selectedTargets = selectedPrinterCompatibilityTargets(selectedMachineProfile, model)
  if (selectedTargets.length === 0) return true
  const profileTargets = extractProfilePrinterTargets(profile)
  if (profileTargets.length === 0) return true
  return profileTargets.some((target) => profileTargetMatchesSelectedPrinter(target, selectedTargets))
}

/**
 * True when the preset DECLARES which printer models it is for, and the selected machine is none
 * of them.
 *
 * Reads the raw declared fields rather than {@link extractProfilePrinterTargets}, whose alias
 * expansion folds "Bambu Lab A1 mini" into A1's own alias family: the exact conflation this
 * rejects. Model KEYS, not text: `tokenBoundaryIncludes` accepts "a1" inside "a1 mini" because the
 * space is a legitimate token boundary, so text alone cannot separate a model from a longer one
 * that contains it.
 *
 * A preset declaring no model at all is not rejected; absence of evidence is not a mismatch.
 */
export function declaresIncompatiblePrinterModel(
  profile: SlicingPresetSummary,
  selectedMachineProfile: SlicingPresetSummary | null,
  model: string
): boolean {
  const selectedKey = canonicalBambuModelKey(selectedMachineProfile?.name) ?? canonicalBambuModelKey(model)
  if (!selectedKey) return false
  const declaredKeys = [...(profile.printerModels ?? []), ...(profile.compatiblePrinters ?? [])]
    .map((entry) => canonicalBambuModelKey(entry))
    .filter((key): key is string => key != null)
  if (declaredKeys.length === 0) return false
  return !declaredKeys.some((key) => bambuModelKeysAreCompatible(selectedKey, key))
}

export function nozzleDiameterToken(value: number): string {
  return Number(value).toFixed(3)
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

export function matchesNozzleDiameters(profile: SlicingPresetSummary, nozzleDiameters: number[]): boolean {
  if (!profile.nozzleDiameters || profile.nozzleDiameters.length === 0 || nozzleDiameters.length === 0) return true
  return profile.nozzleDiameters.some((profileDiameter) => nozzleDiameters.some((selectedDiameter) => Math.abs(profileDiameter - selectedDiameter) < 0.001))
}

export function resolveMachineProfileNozzleDiameters(profile: SlicingPresetSummary): number[] {
  const explicit = profile.nozzleDiameters ?? []
  const fromName = extractNozzleDiameterTokens(normalizedProfileText(profile.name)).map((entry) => Number.parseFloat(entry))
  return [...explicit, ...fromName].filter((entry) => Number.isFinite(entry) && entry > 0)
}

/**
 * Does the preset positively identify a DIFFERENT nozzle from the one selected?
 *
 * The narrow half of {@link matchesProfileNozzleTarget}, for presets that carry no declared fields
 * to judge: a `project:` preset is minted from a 3MF with nothing but a NAME, so every other axis
 * has no evidence and passes by default. Its name usually still says which nozzle it was authored
 * for ("0.10mm Standard @BBL A1 0.2 nozzle"), and a process tuned for 0.2 is not a process for 0.8.
 *
 * Positive identification only, matching the model rule beside it: a preset stating no nozzle is
 * never dropped, so a hand-named or custom preset cannot be discarded for saying too little.
 */
export function statesADifferentNozzle(profile: SlicingPresetSummary, nozzleDiameters: number[]): boolean {
  if (nozzleDiameters.length === 0) return false
  const stated = extractNozzleDiameterTokens(normalizedProfileText(profile.name))
    .filter((entry): entry is string => Boolean(entry))
  if (stated.length === 0) return false
  const selected = nozzleDiameters.map(nozzleDiameterToken)
  return !stated.some((entry) => selected.includes(entry))
}

export function matchesProfileNozzleTarget(profile: SlicingPresetSummary, selectedMachineProfile: SlicingPresetSummary | null, nozzleDiameters: number[]): boolean {
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
