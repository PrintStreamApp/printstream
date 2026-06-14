/**
 * Shared 3MF inspection helpers for library-backed print flows.
 *
 * Library dispatch, print recording, and future analytics all need the same
 * logic: resolve a library file from local or bridge-backed storage, then
 * inspect its 3MF metadata without duplicating that transport branching.
 */
import type { LibraryFile } from '@printstream/shared'
import { inspectBridgeLibraryThreeMf, resolveLibraryFileToLocalPath } from './bridge-library-files.js'
import { readPlateIndex } from './three-mf.js'

type LibraryThreeMfIndex = Awaited<ReturnType<typeof inspectBridgeLibraryThreeMf>>

export async function readLibraryThreeMfIndex(file: {
  ownerBridgeId?: string | null
  storedPath: string
}): Promise<LibraryThreeMfIndex> {
  if (file.ownerBridgeId) {
    return await inspectBridgeLibraryThreeMf(file)
  }
  const resolvedPath = await resolveLibraryFileToLocalPath(file)
  return await readPlateIndex(resolvedPath)
}

export async function readLibraryProjectFilamentChips(file: {
  ownerBridgeId?: string | null
  storedPath: string
  kind: string
}): Promise<LibraryFile['projectFilamentChips']> {
  if (file.kind !== '3mf' && file.kind !== 'gcode') return []

  const index = await readLibraryThreeMfIndex(file)
  const seen = new Set<string>()
  const ordered: LibraryFile['projectFilamentChips'] = []
  const projectFilamentsById = new Map(index.projectFilaments.map((filament) => [filament.id, filament]))

  for (const plate of index.plates) {
    for (const filament of plate.filaments) {
      const projectFilament = projectFilamentsById.get(filament.id)
      const label = normalizeProjectFilamentLabel(
        projectFilament?.filamentName
        ?? filament.filamentName
        ?? projectFilament?.filamentType
        ?? filament.filamentType
        ?? ''
      )
      const color = normalizeProjectFilamentColor(projectFilament?.color ?? filament.color ?? null)
      const key = `${label}::${color ?? ''}`
      if (!label || seen.has(key)) continue
      seen.add(key)
      ordered.push({ label, color })
    }
  }

  return ordered
}

export async function readLibraryThreeMfPlateUsage(file: {
  ownerBridgeId?: string | null
  storedPath: string
}, plate: number | null | undefined): Promise<{
  usedGrams: number | null
  usedMeters: number | null
} | null> {
  if (plate == null) return null

  const index = await readLibraryThreeMfIndex(file)
  const plateEntry = index.plates.find((entry) => entry.index === plate)
  if (!plateEntry) return null

  let gramTotal = 0
  let meterTotal = 0
  let hasGramUsage = false
  let hasMeterUsage = false

  for (const filament of plateEntry.filaments) {
    if (filament.usedGrams != null) {
      gramTotal += filament.usedGrams
      hasGramUsage = true
    }
    if (filament.usedMeters != null) {
      meterTotal += filament.usedMeters
      hasMeterUsage = true
    }
  }

  return {
    usedGrams: hasGramUsage ? gramTotal : null,
    usedMeters: hasMeterUsage ? meterTotal : null
  }
}

function normalizeProjectFilamentLabel(value: string): string {
  return value
    .trim()
    .replace(/\s*\([^)]*\.(?:3mf|gcode(?:\.3mf)?)\)$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeProjectFilamentColor(value: string | null): string | null {
  const normalized = value?.trim().toUpperCase() ?? ''
  if (!normalized) return null
  if (!/^#[0-9A-F]{6}$/.test(normalized)) return null
  return normalized
}