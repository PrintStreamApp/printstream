/**
 * STEP tessellation on the MAIN thread: the fallback path only.
 *
 * The normal route is `importStagingWorker.ts`, which runs the same tessellation off-thread; this is
 * what the staging client falls back to when a worker is unavailable (no `Worker` global, a worker
 * module that will not load, a wedged task). Tessellating a real assembly here freezes the tab for
 * seconds, which is why it is the fallback and not the default, but a brief freeze beats an import
 * that cannot happen at all.
 *
 * Only the LOADING is local: the tessellation quality and the per-solid fold come from
 * `@printstream/shared/three-mf` (`step-mesh.ts`), so a STEP imports identically on both hosts and
 * in both contexts.
 *
 * Counterpart: `apps/api/src/lib/mesh-import.ts`.
 */
import { stepMeshFromOcctResult, type ImportedMesh } from '@printstream/shared/three-mf'
import { loadOcctReader } from './occtLoader'

/** Tessellate a STEP file the user picked, in the tab. */
export async function tessellateStepInBrowser(bytes: Uint8Array): Promise<ImportedMesh> {
  const read = await loadOcctReader()
  return stepMeshFromOcctResult(read(bytes))
}
