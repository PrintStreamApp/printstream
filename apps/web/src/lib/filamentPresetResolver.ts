/**
 * The single answer to "which filament preset is this slot?".
 *
 * Owns filament-preset resolution for every slice/print surface: an AMS slot, an
 * external spool, or a 3MF project filament, resolved against the workspace's
 * merged preset catalogue. Replaces the scattered name matchers that each
 * answered the question slightly differently (issue #66).
 *
 * Contract callers rely on:
 * - The result is an **identity**, not a name: a resolved preset id plus its
 *   provenance and the signal that matched it. Names are display text and must
 *   never travel onward as identity — writing a display name where a preset name
 *   belongs is what overwrote a project's `filament_settings_id` with a string no
 *   catalogue contains, failing the settings-repair export and segfaulting the CLI.
 * - **Unresolved is a first-class result, never a silent fallback.** A slot that
 *   matches nothing returns `status: 'unresolved'` with a reason the UI can show
 *   and the request can refuse. There is no "closest preset" consolation match.
 * - Matching prefers real preset fields over text. `filament_id` is an exact join
 *   against the AMS tray id; `filament_type` and `filament_is_support` are hard
 *   vetoes. Name comparison survives only as a last-resort signal for presets that
 *   carry no structured metadata at all (3MF project filaments), and never
 *   contributes to printer-model matching.
 *
 * Counterpart: the catalogue this resolves against comes from `/api/slicing/profiles`
 * (`apps/api/src/routes/slicing.ts`), whose builtin half is minted by the slicer's
 * `listBuiltinProfiles`. `resolveDisplayFilamentType` in `@printstream/shared` is
 * the shared derivation both sides type filaments through.
 */
import {
  canonicalBambuModelKey,
  isSupportDisplayFilamentType,
  normalizeFilamentFamily,
  slicingPresetProvenance,
  type SlicingPresetProvenance,
  type SlicingProfileSummary
} from '@printstream/shared'

/** Which signal identified the preset, strongest first. Surfaced for diagnostics and tests. */
export type FilamentPresetMatchSignal =
  /** The AMS tray's `filament_id` (`GFA00`) joined a preset's `filament_id` exactly. */
  | 'filamentId'
  /** The spool's user-pinned slicing preset. */
  | 'pinnedPreset'
  /** The preset name matched the tray's RFID name or the project's baked preset name. */
  | 'presetName'
  /** Only the filament family agreed (a custom "PLA" tray picking a PLA preset for this machine). */
  | 'filamentFamily'

/** Why a slot could not be identified. Each maps to user-facing copy at the call site. */
export type FilamentPresetUnresolvedReason =
  /** No preset in the catalogue carries any signal this slot identifies with. */
  | 'noMatch'
  /** The catalogue is empty or has not loaded yet — retry rather than report a bad slot. */
  | 'noCatalogue'

export type FilamentPresetResolution =
  | {
      status: 'resolved'
      /** The preset's id. This, not `profile.name`, is what travels in a slice request. */
      profileId: string
      provenance: SlicingPresetProvenance
      matchedBy: FilamentPresetMatchSignal
      profile: SlicingProfileSummary
    }
  | {
      status: 'unresolved'
      reason: FilamentPresetUnresolvedReason
    }

export interface FilamentPresetQuery {
  /** The tray's RFID/user-set name, if any. */
  trayName: string | null
  /** The tray's Bambu filament id (`GFA00`); the strongest available signal. */
  trayInfoIdx: string | null
  /** The tray's reported filament type, in BambuStudio's DERIVED spelling (`PLA-S`). */
  trayFilamentType: string | null
  /** A spool's user-pinned preset name, which wins outright when it resolves. */
  pinnedPresetName?: string | null
  /** The selected machine preset, used only to RANK equally-identified presets. */
  selectedMachineProfile: SlicingProfileSummary | null
  /** The selected printer model key, used only to RANK equally-identified presets. */
  selectedPrinterModel: string
}

/**
 * Resolve the filament preset for one slot.
 *
 * Machine compatibility only ever RANKS presets the slot already identifies; it
 * can never select one on its own. Without that rule an unidentified custom tray
 * took whichever machine-compatible preset sorted first, mislabelling a plain PLA
 * spool as "ASA - Custom".
 */
export function resolveFilamentPreset(
  profiles: SlicingProfileSummary[],
  query: FilamentPresetQuery
): FilamentPresetResolution {
  const filamentProfiles = profiles.filter((profile) => profile.kind === 'filament')
  if (filamentProfiles.length === 0) return { status: 'unresolved', reason: 'noCatalogue' }

  // A user's explicit pin outranks every derived signal. The caller's catalogue is
  // already machine-filtered, so a pin that no longer applies simply misses here
  // and falls through to the derived match rather than forcing an invalid preset.
  const pinned = findPresetByName(filamentProfiles, query.pinnedPresetName)
  if (pinned) return resolved(pinned, 'pinnedPreset')

  let best: { profile: SlicingProfileSummary; signal: FilamentPresetMatchSignal; score: number } | null = null
  for (const profile of filamentProfiles) {
    const candidate = scoreFilamentPreset(profile, query)
    if (!candidate) continue
    if (best && candidate.score <= best.score) continue
    best = { profile, signal: candidate.signal, score: candidate.score }
  }

  if (!best) return { status: 'unresolved', reason: 'noMatch' }
  return resolved(best.profile, best.signal)
}

function resolved(profile: SlicingProfileSummary, matchedBy: FilamentPresetMatchSignal): FilamentPresetResolution {
  return {
    status: 'resolved',
    profileId: profile.id,
    // A catalogue preset that predates the unified id codec still classifies by its
    // `custom:`/`builtin:` prefix; anything unrecognised is treated as workspace-owned.
    provenance: slicingPresetProvenance(profile.id) ?? (profile.source === 'builtin' ? 'builtin' : 'workspace'),
    matchedBy,
    profile
  }
}

interface FilamentPresetScore {
  signal: FilamentPresetMatchSignal
  score: number
}

/**
 * Score one preset against the slot, or return `null` when the preset is vetoed
 * or carries no identifying signal at all.
 */
function scoreFilamentPreset(profile: SlicingProfileSummary, query: FilamentPresetQuery): FilamentPresetScore | null {
  if (isVetoedByMaterial(profile, query.trayFilamentType)) return null

  const identity = scoreIdentity(profile, query)
  if (!identity) return null

  return { signal: identity.signal, score: identity.score + scoreMachineRank(profile, query) }
}

/**
 * Hard material vetoes. A preset of a different polymer family can never
 * represent the tray no matter how machine-compatible it is, and a dedicated
 * support filament is not interchangeable with a model filament of the same
 * polymer — a `PLA-S` tray resolving to "Bambu PLA Basic" would slice supports
 * with model material (and vice versa) with no warning.
 */
function isVetoedByMaterial(profile: SlicingProfileSummary, trayFilamentType: string | null): boolean {
  const trayFamily = normalizeFilamentFamily(trayFilamentType)
  const profileFamily = normalizeFilamentFamily(profile.filamentType ?? null)
  if (trayFamily && profileFamily && profileFamily !== trayFamily) return true

  // Only veto on the support axis when the tray actually states a type; a tray
  // with no reported type tells us nothing about which side it belongs on.
  if (!trayFilamentType?.trim()) return false
  // An ABSENT flag means unknown, never "not support" — a preset catalogue served
  // by a slicer older than `filamentIsSupport` carries none, and inferring `false`
  // there would veto every preset for a support tray and block the slice outright.
  // Unknown stays lenient; the veto engages once the flag is actually carried.
  if (profile.filamentIsSupport == null) return false
  return isSupportDisplayFilamentType(trayFilamentType) !== profile.filamentIsSupport
}

/**
 * The identifying signal, strongest first. Scores are spaced so a stronger signal
 * always beats a weaker one plus any machine ranking (max 100 below).
 */
function scoreIdentity(profile: SlicingProfileSummary, query: FilamentPresetQuery): FilamentPresetScore | null {
  // Exact id join. Bambu filament ids are opaque tokens (`GFA00`), so they are
  // compared verbatim — normalizing them, or routing them through a catalogue
  // NAME and re-matching that, only loses precision.
  const trayFilamentId = query.trayInfoIdx?.trim()
  if (trayFilamentId && (profile.filamentIds ?? []).includes(trayFilamentId)) {
    return { signal: 'filamentId', score: 1000 }
  }

  const trayName = normalizePresetText(query.trayName)
  if (trayName && normalizePresetText(profile.name) === trayName) {
    return { signal: 'presetName', score: 500 }
  }

  // Weakest signal: the families simply agree. Enough to pick a sensible preset for
  // a custom/unbranded spool, never enough to claim a specific product.
  const trayFamily = normalizeFilamentFamily(query.trayFilamentType)
  const profileFamily = normalizeFilamentFamily(profile.filamentType ?? null)
  if (trayFamily && profileFamily && trayFamily === profileFamily) {
    return { signal: 'filamentFamily', score: 200 }
  }

  return null
}

/**
 * Rank among equally-identified presets by how specifically they target the
 * selected machine. Never selects on its own — see {@link scoreFilamentPreset}.
 *
 * Deliberately reads only declared compatibility fields. Including the preset
 * NAME here made any preset whose name happened to contain "H2D" claim H2D
 * compatibility even with an empty `printer_model`.
 */
function scoreMachineRank(profile: SlicingProfileSummary, query: FilamentPresetQuery): number {
  const machineName = query.selectedMachineProfile?.name
  const compatiblePrinters = profile.compatiblePrinters ?? []

  if (machineName && compatiblePrinters.some((entry) => normalizePresetText(entry) === normalizePresetText(machineName))) {
    return 100
  }
  if (matchesSelectedModel(profile, query)) return 60
  // A preset that declares any targeting at all is a safer pick than a wholly
  // generic one when nothing more specific matched.
  if (compatiblePrinters.length > 0) return 10
  if ((profile.printerModels ?? []).length > 0) return 5
  return 0
}

/**
 * Whether the preset declares compatibility with the selected printer model.
 *
 * Model keys are compared through `canonicalBambuModelKey` + the family table
 * rather than by substring: `"A1"`.includes-matching `"A1 mini"` (and `H2D` /
 * `H2D Pro`) conflates genuinely different machines.
 */
function matchesSelectedModel(profile: SlicingProfileSummary, query: FilamentPresetQuery): boolean {
  const selectedKey = canonicalBambuModelKey(query.selectedPrinterModel)
    ?? canonicalBambuModelKey(query.selectedMachineProfile?.name)
  if (!selectedKey) return false
  const declaredTargets = [...(profile.printerModels ?? []), ...(profile.compatiblePrinters ?? [])]
  return declaredTargets.some((entry) => {
    const entryKey = canonicalBambuModelKey(entry)
    return entryKey != null && entryKey === selectedKey
  })
}

/**
 * Find a preset by an exact name, for the one case where a NAME is the user's
 * stored intent rather than a derived guess: a spool pinned to a preset.
 *
 * Kept deliberately strict (exact, normalized) — the pin is stored text, so a
 * fuzzy match here would silently substitute a different product.
 */
function findPresetByName(profiles: SlicingProfileSummary[], name: string | null | undefined): SlicingProfileSummary | null {
  const normalized = normalizePresetText(name)
  if (!normalized) return null
  return profiles.find((profile) => normalizePresetText(profile.name) === normalized) ?? null
}

/**
 * Case- and punctuation-insensitive preset-name normalization.
 *
 * The single normalizer for preset text. Three near-duplicates used to exist with
 * subtly different rules (one stripped `bambu lab`, one kept `@`), so a name
 * normalized by one was not comparable to the same name normalized by another.
 */
export function normalizePresetText(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
}
