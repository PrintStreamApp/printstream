/**
 * Object -> generic (vanilla) 3MF export: BambuStudio's "Export Generic 3MF", the interchange
 * counterpart of `objectExport.ts`'s STL.
 *
 * WHY A SECOND FORMAT AT ALL. STL is the only thing this editor could hand another tool, and it
 * loses everything a multi-object selection knows: the objects merge into one anonymous shell, or
 * they go out as N separate downloads that whoever receives them has to re-assemble by hand. A
 * core-spec 3MF carries several NAMED objects, each with its own build placement, in ONE file, and
 * declares its units -- so the plate a user is looking at survives the trip to PrusaSlicer, Orca or
 * Cura intact. That is the whole point of the format, and it is why the merged/separate split the
 * STL menu needs does not exist here.
 *
 * DELIBERATELY MORE GENERIC THAN BAMBUSTUDIO'S. Its "Export Generic 3MF" is
 * `export_3mf(path, SaveStrategy::Silence)` (`Plater.cpp:22637`), i.e. an ordinary save minus the
 * PRODUCTION extension -- the file still carries `Metadata/model_settings.config` and
 * `project_settings.config`, so it is "generic" only in the sense of being one `3dmodel.model`
 * rather than split objects. Its own menu tooltip admits this: "without using SOME 3mf-extensions".
 * A file still carrying Bambu project metadata is not what someone exporting FOR ANOTHER SLICER is
 * asking for, so ours writes the core spec and nothing else, through `buildVanillaThreeMfEntries`.
 *
 * WHAT IS LOST, and it is the same list the STL export loses, for the same reason: per-triangle
 * paint, materials, per-object settings, supports and modifiers are all Bambu extensions. A user
 * who wants those keeps the project 3MF. Helper volumes are excluded exactly as
 * `buildObjectStl` excludes them -- there is no client-side mesh boolean, so a negative part
 * written as solid geometry would be wrong rather than merely lossy.
 *
 * Counterpart: `mesh-archive.ts` (the shared writer) and `mesh-extract.ts`'s vanilla-3MF fallback,
 * which is what reads one of these back if it is ever re-imported here.
 */
import type * as THREE from 'three'
import { buildVanillaThreeMfEntries, type ThreeMfArchiveSolid } from '@printstream/shared/three-mf'
import { collectWorldTriangles, rebaseTriangleSoup } from './meshCut'
import { zipArchiveEntries } from './zipArchiveClient'
import { exportBaseName } from './objectExport'

/** Full `<sanitized name>.3mf` filename for a generic-3MF export. */
export function genericThreeMfExportFileName(objectName: string): string {
  return `${exportBaseName(objectName, '.3mf')}.3mf`
}

/**
 * Serialize the given objects' render groups as ONE vanilla 3MF, each object a separately named
 * solid.
 *
 * The groups keep their RELATIVE world placement and the set is re-centred as a whole, matching
 * `buildObjectsStl` so the two exports of one selection describe the same arrangement. Re-centring
 * the set rather than each solid is what preserves that arrangement: rebasing each to its own
 * centre would stack every object on the origin.
 *
 * Returns null when no group holds printed geometry (e.g. a selection of only modifiers), which the
 * caller reports rather than writing an empty archive.
 */
export async function buildGenericThreeMf(
  objects: ReadonlyArray<{ name: string; group: THREE.Object3D }>
): Promise<Uint8Array | null> {
  const solids: ThreeMfArchiveSolid[] = []
  // ONE rebase over the whole set, so the objects keep their relative positions. Collected first,
  // then shifted, because the offset cannot be known until every solid has been seen.
  const soups: Array<{ name: string; soup: Float32Array }> = []
  for (const object of objects) {
    const soup = collectWorldTriangles(object.group)
    if (soup.length > 0) soups.push({ name: object.name, soup })
  }
  if (soups.length === 0) return null

  const combined = new Float32Array(soups.reduce((sum, entry) => sum + entry.soup.length, 0))
  let offset = 0
  for (const entry of soups) { combined.set(entry.soup, offset); offset += entry.soup.length }
  rebaseTriangleSoup(combined)
  // Read the rebased coordinates back out per solid: `rebaseTriangleSoup` works in place over one
  // buffer, and the per-solid views must be the SHIFTED geometry, not the originals.
  offset = 0
  for (const entry of soups) {
    solids.push({ name: entry.name, triangles: combined.subarray(offset, offset + entry.soup.length) })
    offset += entry.soup.length
  }

  const entries = buildVanillaThreeMfEntries(solids)
  const encoder = new TextEncoder()
  return await zipArchiveEntries(
    Object.fromEntries(Object.entries(entries).map(([path, xml]) => [path, encoder.encode(xml)])),
    6
  )
}
