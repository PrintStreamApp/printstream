/**
 * Loads the workspace's filament materials from the Filament Manager library over plain HTTP and
 * dedupes spools into distinct (type + colour) materials for the queue material pickers — carrying
 * each material's aggregate remaining quantity. Never imports the filament-manager plugin
 * (cross-plugin rule); degrades to an empty list when that plugin is disabled/forbidden, so the
 * file-default + Custom paths still work.
 */
import { useQuery } from '@tanstack/react-query'
import { normalizeHexColor, type FilamentSpoolList } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { colorDistance, resolveProjectFilamentColorName } from '../../lib/filamentColor'

export interface LibraryMaterial {
  /** `type|color` identity, matched against a filament's required type+colour. */
  key: string
  filamentType: string
  color: string | null
  brand: string | null
  /** Friendly colour name (Bambu/common), used for display. */
  colorName: string | null
  /** Total remaining grams across this material's non-archived spools (null when none report). */
  remainingGrams: number | null
  /** Aggregate remaining as a percent of total net weight (0-100), null when unknown. */
  remainPercent: number | null
  /** How many spools back this material. */
  spoolCount: number
  /** Remaining grams across only the spools NOT loaded in a machine (null when none report). */
  availableGrams: number | null
  /** That available remaining as a percent of the non-loaded spools' net weight, null when unknown. */
  availablePercent: number | null
  /** How many of this material's spools are currently loaded into a printer. */
  loadedSpoolCount: number
  /** Distinct printer names this material is currently loaded in (for the "loaded" hint). */
  loadedPrinterNames: string[]
}

/** `type|color` identity used to match a required filament against a library material. */
export function materialKey(type: string | null | undefined, color: string | null | undefined): string {
  return `${(type ?? '').trim().toLowerCase()}|${normalizeHexColor(color) ?? ''}`
}

function typeMatches(materialType: string, filamentType: string | null | undefined): boolean {
  const type = (filamentType ?? '').trim().toLowerCase()
  return type === '' || materialType.trim().toLowerCase() === type
}

/**
 * Sort materials by nearness to a target filament: compatible type first, then closest colour.
 * Used for the browse dialog's default "best match" order.
 */
export function rankMaterialsForFilament(
  materials: LibraryMaterial[],
  filamentType: string | null | undefined,
  color: string | null | undefined
): LibraryMaterial[] {
  return [...materials].sort((a, b) => {
    const aCompat = typeMatches(a.filamentType, filamentType)
    const bCompat = typeMatches(b.filamentType, filamentType)
    if (aCompat !== bCompat) return aCompat ? -1 : 1
    return colorDistance(a.color, color) - colorDistance(b.color, color)
  })
}

/**
 * The nearest materials to suggest inline in the dropdown. Type is the primary concern (compatible
 * materials rank first), but colour is weighted heavily within — so the closest-colour matches lead,
 * and a colour-close material still surfaces even when the library has no exact-type match (it just
 * carries the type-mismatch warning when picked).
 */
export function suggestMaterials(
  materials: LibraryMaterial[],
  filamentType: string | null | undefined,
  color: string | null | undefined,
  limit = 5
): LibraryMaterial[] {
  return rankMaterialsForFilament(materials, filamentType, color).slice(0, limit)
}

interface MaterialAccumulator {
  key: string
  filamentType: string
  color: string | null
  brand: string | null
  colorName: string | null
  spoolCount: number
  grams: number
  net: number
  availableGrams: number
  availableNet: number
  loadedSpoolCount: number
  loadedNames: Set<string>
}

function percentOf(grams: number, net: number): number | null {
  return net > 0 ? Math.round((grams / net) * 100) : null
}

export function useFilamentLibrary() {
  const query = useQuery<LibraryMaterial[]>({
    queryKey: ['print-queue', 'material-palette'],
    queryFn: async ({ signal }) => {
      const data = await apiFetch<FilamentSpoolList>('/api/plugins/filament-manager/spools?includeArchived=true', { signal })
      const byKey = new Map<string, MaterialAccumulator>()
      for (const spool of data.spools) {
        if (spool.status === 'archived') continue
        const key = materialKey(spool.filamentType, spool.colorHex)
        // A spool physically in a printer's AMS/external slot — relevant when the user wants to see
        // (or exclude) what's already loaded in their machines.
        const loaded = spool.loadedPrinterId != null
        const existing = byKey.get(key)
        if (existing) {
          existing.spoolCount += 1
          existing.grams += spool.remainingGrams
          existing.net += spool.netWeightGrams
          if (loaded) {
            existing.loadedSpoolCount += 1
            if (spool.loadedPrinterName) existing.loadedNames.add(spool.loadedPrinterName)
          } else {
            existing.availableGrams += spool.remainingGrams
            existing.availableNet += spool.netWeightGrams
          }
          existing.brand = existing.brand ?? spool.brand ?? null
          continue
        }
        const colorName = spool.colorName
          ?? resolveProjectFilamentColorName({ color: spool.colorHex, filamentName: spool.brand, filamentType: spool.filamentType })
          ?? normalizeHexColor(spool.colorHex)
        byKey.set(key, {
          key,
          filamentType: spool.filamentType,
          color: normalizeHexColor(spool.colorHex),
          brand: spool.brand ?? null,
          colorName,
          spoolCount: 1,
          grams: spool.remainingGrams,
          net: spool.netWeightGrams,
          availableGrams: loaded ? 0 : spool.remainingGrams,
          availableNet: loaded ? 0 : spool.netWeightGrams,
          loadedSpoolCount: loaded ? 1 : 0,
          loadedNames: new Set(loaded && spool.loadedPrinterName ? [spool.loadedPrinterName] : [])
        })
      }
      return Array.from(byKey.values())
        .map((material): LibraryMaterial => ({
          key: material.key,
          filamentType: material.filamentType,
          color: material.color,
          brand: material.brand,
          colorName: material.colorName,
          remainingGrams: Math.round(material.grams),
          remainPercent: percentOf(material.grams, material.net),
          spoolCount: material.spoolCount,
          availableGrams: material.loadedSpoolCount < material.spoolCount ? Math.round(material.availableGrams) : null,
          availablePercent: percentOf(material.availableGrams, material.availableNet),
          loadedSpoolCount: material.loadedSpoolCount,
          loadedPrinterNames: [...material.loadedNames]
        }))
        .sort((a, b) => a.filamentType.localeCompare(b.filamentType) || (a.colorName ?? '').localeCompare(b.colorName ?? ''))
    },
    retry: false,
    staleTime: 30_000
  })
  return { materials: query.data ?? [], isLoading: query.isLoading }
}
