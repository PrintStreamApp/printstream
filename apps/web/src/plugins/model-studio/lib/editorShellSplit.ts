/**
 * Prepares connected printable shells for the editor's two Split actions. Both discard helper
 * volumes, enforce the same shell limit, and stage through the host's import store. Split to
 * objects normalizes each shell independently; Split to parts keeps all shells in one vanilla
 * 3MF so their relative positions and per-solid identities survive normalization.
 */
import { buildVanillaThreeMfEntries } from '@printstream/shared/three-mf'
import type { StagedImport } from '@printstream/shared'
import * as THREE from 'three'
import type { EditorImportStore } from './editorImportStore'
import { collectWorldTriangles, rebaseTriangleSoup, splitTriangleSoup, triangleSoupToBinaryStl } from './meshCut'
import { zipArchiveEntries } from './zipArchiveClient'

export const MAX_SPLIT_SHELLS = 50
export type ShellSplitTarget = 'objects' | 'parts'

/** Split printed geometry only and report the user-facing reason when the action is unavailable. */
export function prepareEditorShellSplit(
  group: THREE.Group,
  name: string,
  target: ShellSplitTarget
): { shells: Float32Array[]; error: null } | { shells: null; error: string } {
  const shells = splitTriangleSoup(collectWorldTriangles(group))
  if (shells.length < 2) {
    return { shells: null, error: `${name} is already a single connected part.` }
  }
  if (shells.length > MAX_SPLIT_SHELLS) {
    return { shells: null, error: `${name} has ${shells.length} shells, too many to split into ${target}.` }
  }
  return { shells, error: null }
}

export interface StagedObjectShell {
  import: StagedImport
  offset: { x: number; y: number; z: number }
}

/** Stage each rebased shell as its own ordinary object, retaining its world placement offset. */
export async function stageEditorObjectShells(
  shells: readonly Float32Array[],
  name: string,
  store: Pick<EditorImportStore, 'stageFile'>
): Promise<StagedObjectShell[]> {
  return Promise.all(shells.map(async (soup, index) => {
    const { offset } = rebaseTriangleSoup(soup)
    const stl = triangleSoupToBinaryStl(soup)
    const file = new File([stl], `${name} (part ${index + 1}).stl`, { type: 'application/octet-stream' })
    return { import: await store.stageFile(file, 'object'), offset }
  }))
}

/** Stage one multi-solid import; staging shells separately would stack them at the origin. */
export async function stageEditorPartShells(
  shells: readonly Float32Array[],
  name: string,
  store: Pick<EditorImportStore, 'stageFile'>
): Promise<StagedImport> {
  const entries = buildVanillaThreeMfEntries(shells.map((triangles, index) => ({
    name: `${name}_${index + 1}`,
    triangles
  })))
  // This archive exists for one hop into staging. Compressing generated XML delays that hop.
  const encoder = new TextEncoder()
  const zipEntries: Record<string, Uint8Array> = {}
  for (const [entryName, text] of Object.entries(entries)) zipEntries[entryName] = encoder.encode(text)
  const bytes = await zipArchiveEntries(zipEntries, 0)
  const file = new File([bytes.slice().buffer as ArrayBuffer], `${name}.3mf`, { type: 'application/octet-stream' })
  return store.stageFile(file, 'object')
}
