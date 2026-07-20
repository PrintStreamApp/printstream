/**
 * Per-kind filter facets for the slicing-profile manager.
 *
 * The three profile kinds carry genuinely different metadata — a nozzle diameter means nothing to
 * a filament preset, a material type means nothing to a printer preset — so the manager shows one
 * kind at a time (a tab per kind) with only the facets that apply to it. This module owns which
 * facets each kind has and how a profile's values are read; the UI only renders what it is given.
 *
 * Facet values are display-ready strings on purpose: the option list and the match test then use
 * the exact same value, so there is no formatter to keep in sync between them.
 *
 * Counterpart: `apps/web/src/components/settings/slicing-profiles/` renders these; the profile
 * metadata itself comes from `slicingProfileSummarySchema` in `@printstream/shared`.
 */
import type { SlicingProfileSummary } from '@printstream/shared'
import { filterSlicingProfiles, type SlicingProfileKind } from './slicingProfileDirectory'
import { resolveProfileLayerHeight } from './slicingProfileSelection'

/** Selected values per facet id. A facet absent (or empty) constrains nothing. */
export type SlicingProfileFacetSelections = Record<string, string[]>

export interface SlicingProfileFacet {
  id: string
  /** Field label, e.g. "Printer model". */
  label: string
  /** Select placeholder shown when nothing is picked, e.g. "All printer models". */
  placeholder: string
  /** The profile's display-ready values for this facet; empty means it matches no selection. */
  valuesOf: (profile: SlicingProfileSummary) => string[]
}

function uniqueStrings(values: ReadonlyArray<string | undefined | null>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value && value.trim()))))
}

const MACHINE_FACETS: ReadonlyArray<SlicingProfileFacet> = [
  {
    id: 'printerModel',
    label: 'Printer model',
    placeholder: 'All printer models',
    valuesOf: (profile) => uniqueStrings(profile.printerModels ?? [])
  },
  {
    id: 'nozzle',
    label: 'Nozzle',
    placeholder: 'All nozzles',
    // Rendered with its unit so the option reads as a nozzle size rather than a bare number.
    valuesOf: (profile) => uniqueStrings((profile.nozzleDiameters ?? []).map((diameter) => `${diameter} mm`))
  }
]

const PROCESS_FACETS: ReadonlyArray<SlicingProfileFacet> = [
  {
    id: 'compatiblePrinter',
    label: 'Compatible printer',
    placeholder: 'All printers',
    valuesOf: (profile) => uniqueStrings(profile.compatiblePrinters ?? [])
  },
  {
    id: 'layerHeight',
    label: 'Layer height',
    placeholder: 'All layer heights',
    // The preset's real `layer_height`, falling back to the name token for presets
    // that carry none (3MF project profiles) — same rule as the slice picker.
    valuesOf: (profile) => uniqueStrings([resolveProfileLayerHeight(profile)])
  }
]

const FILAMENT_FACETS: ReadonlyArray<SlicingProfileFacet> = [
  {
    id: 'filamentType',
    label: 'Material',
    placeholder: 'All materials',
    valuesOf: (profile) => uniqueStrings([profile.filamentType])
  },
  {
    id: 'filamentVendor',
    label: 'Brand',
    placeholder: 'All brands',
    valuesOf: (profile) => uniqueStrings([profile.filamentVendor])
  }
]

export const SLICING_PROFILE_FACETS: Record<SlicingProfileKind, ReadonlyArray<SlicingProfileFacet>> = {
  machine: MACHINE_FACETS,
  process: PROCESS_FACETS,
  filament: FILAMENT_FACETS
}

/**
 * The values actually present in `profiles`, per facet, sorted for display. Only offering values
 * that exist keeps a tab from listing filters that can only ever return nothing.
 */
export function collectSlicingProfileFacetOptions(
  profiles: ReadonlyArray<SlicingProfileSummary>,
  facets: ReadonlyArray<SlicingProfileFacet>
): Record<string, string[]> {
  const options: Record<string, string[]> = {}
  for (const facet of facets) {
    const values = new Set<string>()
    for (const profile of profiles) {
      for (const value of facet.valuesOf(profile)) values.add(value)
    }
    options[facet.id] = Array.from(values).sort((left, right) =>
      left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }))
  }
  return options
}

/** How many facets currently constrain the list; drives the toolbar's active-filter badge. */
export function countActiveSlicingProfileFacets(selections: SlicingProfileFacetSelections): number {
  return Object.values(selections).filter((values) => values.length > 0).length
}

/** The facet `facetId` of `kind`, or null when it does not apply (e.g. a stale stored value). */
export function findSlicingProfileFacet(kind: SlicingProfileKind, facetId: string): SlicingProfileFacet | null {
  return SLICING_PROFILE_FACETS[kind].find((facet) => facet.id === facetId) ?? null
}

export interface SlicingProfileGroup {
  key: string
  label: string
  profiles: SlicingProfileSummary[]
}

/** Bucket for profiles carrying no value for the grouped facet; always sorted last. */
const UNGROUPED_LABEL = 'Unspecified'

/**
 * Buckets `profiles` by a facet's values.
 *
 * A profile with SEVERAL values for the facet appears under each of them — a quality preset
 * compatible with six printers shows up under all six, which is the point of grouping by
 * compatible printer ("what can I use on the X1C?"). Rows are therefore not a partition of the
 * list, and the group counts can exceed the total. Selection is by profile id, so a profile
 * selected in one group reads as selected in the others too.
 */
export function groupSlicingProfilesByFacet(
  profiles: ReadonlyArray<SlicingProfileSummary>,
  facet: SlicingProfileFacet
): SlicingProfileGroup[] {
  const buckets = new Map<string, SlicingProfileGroup>()
  for (const profile of profiles) {
    const values = facet.valuesOf(profile)
    for (const label of values.length > 0 ? values : [UNGROUPED_LABEL]) {
      const key = label.toLowerCase()
      const bucket = buckets.get(key) ?? { key, label, profiles: [] }
      bucket.profiles.push(profile)
      buckets.set(key, bucket)
    }
  }
  return Array.from(buckets.values()).sort((left, right) => {
    if (left.label === UNGROUPED_LABEL) return 1
    if (right.label === UNGROUPED_LABEL) return -1
    return left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: 'base' })
  })
}

/**
 * Profiles of `kind` matching the search text and every constrained facet. Facets combine with
 * AND (each must match) while values within one facet combine with OR, which is what a
 * multi-select filter row reads as.
 */
export function filterSlicingProfilesForKind(
  profiles: ReadonlyArray<SlicingProfileSummary>,
  kind: SlicingProfileKind,
  search: string,
  selections: SlicingProfileFacetSelections
): SlicingProfileSummary[] {
  const facets = SLICING_PROFILE_FACETS[kind]
  return filterSlicingProfiles([...profiles], search, [kind]).filter((profile) =>
    facets.every((facet) => {
      const selected = selections[facet.id] ?? []
      if (selected.length === 0) return true
      return facet.valuesOf(profile).some((value) => selected.includes(value))
    }))
}
