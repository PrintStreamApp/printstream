/**
 * Transient, tenant-scoped store for foreign geometry staged by the 3D editor.
 *
 * When a user imports an STL/STEP (from disk or the library), it is parsed to a mesh and held here
 * keyed by a generated `importId`. The editor references the import by id in its `SceneEdit`; the
 * mesh is baked into the output 3MF only when the arrangement is sliced or saved. Entries are
 * deliberately ephemeral (in-memory, LRU + TTL) — losing them on restart just means re-importing.
 */
import { randomUUID } from 'node:crypto'
import { MemoryLruCache, type SceneEdit, type StagedImport, type StagedImportFormat } from '@printstream/shared'
import { badRequest } from './http-error.js'
import type { ImportedMesh } from './mesh-import.js'
import type { ImportedObjectInput } from './three-mf.js'

interface StagedImportRecord {
  importId: string
  tenantId: string
  name: string
  format: StagedImportFormat
  mesh: ImportedMesh
}

const STAGED_IMPORT_MAX_ENTRIES = 128
const STAGED_IMPORT_TTL_MS = 2 * 60 * 60 * 1000

const store = new MemoryLruCache<string, StagedImportRecord>({
  maxEntries: STAGED_IMPORT_MAX_ENTRIES,
  ttlMs: STAGED_IMPORT_TTL_MS
})

function toSummary(record: StagedImportRecord): StagedImport {
  // A multi-solid import lists its named solids; a single-solid one lists itself as one
  // part named after the import, so the editor always has a uniform `parts` array.
  const parts = record.mesh.parts && record.mesh.parts.length > 1
    ? record.mesh.parts.map((part) => ({
        name: part.name,
        triangleCount: Math.floor(part.mesh.indices.length / 3),
        bounds: part.mesh.bounds
      }))
    : [{ name: record.name, triangleCount: Math.floor(record.mesh.indices.length / 3), bounds: record.mesh.bounds }]
  return {
    importId: record.importId,
    name: record.name,
    format: record.format,
    triangleCount: Math.floor(record.mesh.indices.length / 3),
    bounds: record.mesh.bounds,
    parts
  }
}

/** Stage a parsed mesh and return its summary (id + bounds + triangle count). */
export function stageImport(input: {
  tenantId: string
  name: string
  format: StagedImportFormat
  mesh: ImportedMesh
}): StagedImport {
  const record: StagedImportRecord = {
    importId: randomUUID(),
    tenantId: input.tenantId,
    name: input.name,
    format: input.format,
    mesh: input.mesh
  }
  store.set(record.importId, record)
  return toSummary(record)
}

/** Fetch a staged import's full record, scoped to the owning tenant. */
export function getStagedImport(importId: string, tenantId: string): StagedImportRecord | null {
  const record = store.get(importId)
  if (!record || record.tenantId !== tenantId) return null
  return record
}

/**
 * Resolve the unique imports referenced by a scene edit into the mesh inputs the 3MF builder bakes
 * in. Throws `badRequest` if an instance references an import that is missing or expired so the
 * caller fails the save/slice rather than silently dropping geometry.
 */
export function resolveSceneEditImports(tenantId: string, edit: SceneEdit): ImportedObjectInput[] {
  const importIds = new Set<string>()
  for (const instance of edit.instances) {
    if (instance.importId) importIds.add(instance.importId)
  }
  for (const part of edit.addedParts ?? []) {
    importIds.add(part.importId)
  }
  const resolved: ImportedObjectInput[] = []
  for (const importId of importIds) {
    const record = getStagedImport(importId, tenantId)
    if (!record) throw badRequest('An imported model is no longer available. Re-add it and try again.')
    const parts = record.mesh.parts && record.mesh.parts.length > 1 ? record.mesh.parts : undefined
    resolved.push({ importId: record.importId, name: record.name, mesh: record.mesh, parts })
  }
  return resolved
}
