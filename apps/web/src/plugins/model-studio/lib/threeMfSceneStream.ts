/**
 * Streams a plated 3MF scene's meshes into a Three.js group, one archive entry at a time.
 *
 * Split out of `PreviewView` so the read-only preview and the public 3MF viewer share one
 * implementation — they differ only in where the mesh bytes come from, which is what
 * {@link ThreeMfEntryBytesLoader} abstracts: a library file streams them from the API's
 * `scene-entry` endpoint, the public viewer reads them out of an archive it unzipped locally and
 * never uploaded. Both yield the SAME unmodified zip-entry XML (`scene-entry` does no server-side
 * parsing), so nothing downstream can tell them apart.
 *
 * Progress is reported per PART, not per entry, because one entry commonly holds many parts and a
 * per-entry counter sits at 0 through the expensive stretch.
 */
import * as THREE from 'three'
import type { LibraryThreeMfScene } from '@printstream/shared'
import { buildApiUrl } from '../../../lib/apiUrl'
import { fetchModelBytes } from './modelFetch'
import { parseThreeMfModelEntryAsync } from './meshParseClient'
import { createThreeMfMatrix, createThreeMfPartObject } from './threeMfScene'

/** Resolves one of a 3MF's mesh entries (`3D/Objects/*.model`) to its raw bytes. */
export type ThreeMfEntryBytesLoader = (entryPath: string, signal?: AbortSignal) => Promise<Uint8Array>

/**
 * Mesh entries of a library-stored 3MF, fetched through the API.
 *
 * @param resourceBase `/api/library/:id` or `/api/library/versions/:versionId`.
 */
export function createLibraryThreeMfEntryBytesLoader(resourceBase: string): ThreeMfEntryBytesLoader {
  return async (entryPath, signal) => await fetchModelBytes(
    buildApiUrl(`${resourceBase}/scene-entry?path=${encodeURIComponent(entryPath)}`),
    { credentials: 'include', signal }
  )
}

/**
 * Parse and place every part of `scene` into `plateGroup`.
 *
 * @throws when the plate yielded no placeable geometry — the caller surfaces that as "nothing to
 *   preview" rather than showing an empty plate that looks like a rendering failure.
 */
export async function streamThreeMfSceneParts(
  loadEntryBytes: ThreeMfEntryBytesLoader,
  scene: LibraryThreeMfScene,
  plateGroup: THREE.Object3D,
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void
): Promise<void> {
  const partsByEntry = new Map<string, LibraryThreeMfScene['parts']>()
  for (const part of scene.parts) {
    const list = partsByEntry.get(part.entryPath)
    if (list) list.push(part)
    else partsByEntry.set(part.entryPath, [part])
  }

  const total = scene.parts.length
  let done = 0
  let placed = 0
  onProgress(0, total)

  await Promise.all([...partsByEntry.entries()].map(async ([entryPath, parts]) => {
    const bytes = await loadEntryBytes(entryPath, signal)
    const modelMap = await parseThreeMfModelEntryAsync(bytes)
    if (signal.aborted) {
      // The viewer moved on (plate/file switch) — drop the freshly parsed geometry rather than
      // attaching it to a group that's about to be disposed.
      for (const geometry of modelMap.values()) geometry.dispose()
      return
    }
    for (const part of parts) {
      const geometry = modelMap.get(part.objectId)
      done += 1
      if (geometry) {
        plateGroup.add(createThreeMfPartObject(geometry, {
          // Parts without an extruder render in the DEFAULT filament, like Bambu Studio.
          color: part.color ?? scene.projectFilaments?.[0]?.color ?? null,
          transform: createThreeMfMatrix(part.transform),
          // Without the subtype a support blocker / modifier / negative volume renders as an
          // ordinary opaque part in the default filament — it reads as printed geometry that
          // isn't in the file. The editor has always passed this; the preview must match, or
          // the same project looks different depending on which surface opened it.
          subtype: part.subtype,
          colorPaintFilaments: scene.projectFilaments ?? null
        }))
        placed += 1
      }
      onProgress(done, total)
    }
  }))

  if (placed === 0) {
    throw new Error('This plate does not include previewable mesh geometry.')
  }
}
