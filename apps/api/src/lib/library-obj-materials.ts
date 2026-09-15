/**
 * Resolves material libraries beside a library-backed OBJ.
 *
 * Library folders are database metadata and bridge storage is flat, so a filesystem-relative read
 * would be both wrong and unsafe. Candidates are restricted to the OBJ's workspace, owning bridge
 * and logical folder, then read through the existing bridge-aware file helper.
 */
import { readFile } from 'node:fs/promises'
import {
  MAX_OBJ_MATERIAL_BYTES,
  MAX_OBJ_MATERIAL_FILES,
  MAX_OBJ_TEXTURE_BYTES,
  MAX_OBJ_TEXTURE_FILES,
  normalizeObjMaterialLibraryName,
  normalizeObjResourceName,
  parseObjMaterials,
  referencedObjTextures,
  referencedObjMaterialLibraries
} from '@printstream/shared/three-mf'
import { resolveLibraryFileToLocalPath } from './bridge-library-files.js'
import { badRequest, HttpError } from './http-error.js'
import { prisma } from './prisma.js'

interface LibraryObjLocation {
  workspaceId: string
  ownerBridgeId: string | null
  folderId: string | null
}

export interface LibraryObjMaterialCandidate {
  name: string
  ownerBridgeId: string | null
  storedPath: string
  sizeBytes: number
}

/**
 * Match requested basenames case-insensitively and reject an ambiguous or oversized result.
 * Missing references are deliberately omitted, leaving an ordinary geometry-only OBJ import.
 */
export function selectLibraryObjMaterialFiles(
  objBytes: Uint8Array,
  candidates: readonly LibraryObjMaterialCandidate[]
): LibraryObjMaterialCandidate[] {
  const requested = new Set(referencedObjMaterialLibraries(objBytes).map(normalizeObjMaterialLibraryName))
  if (requested.size > MAX_OBJ_MATERIAL_FILES) {
    throw badRequest(`An OBJ can reference at most ${MAX_OBJ_MATERIAL_FILES} material files`)
  }
  const byName = new Map<string, LibraryObjMaterialCandidate[]>()
  for (const candidate of candidates) {
    const key = normalizeObjMaterialLibraryName(candidate.name)
    if (!requested.has(key)) continue
    const matches = byName.get(key) ?? []
    matches.push(candidate)
    byName.set(key, matches)
  }

  let totalBytes = 0
  const selected: LibraryObjMaterialCandidate[] = []
  for (const requestedName of requested) {
    const matches = byName.get(requestedName) ?? []
    if (matches.length > 1) throw badRequest(`More than one library material file matches ${requestedName}`)
    const match = matches[0]
    if (!match) continue
    totalBytes += match.sizeBytes
    if (match.sizeBytes > MAX_OBJ_MATERIAL_BYTES || totalBytes > MAX_OBJ_MATERIAL_BYTES) {
      throw new HttpError(413, 'OBJ material files exceed the 16 MB combined limit')
    }
    selected.push(match)
  }
  return selected
}

/** Select texture siblings named by the resolved MTL documents. */
export function selectLibraryObjTextureFiles(
  textureNames: readonly string[],
  candidates: readonly LibraryObjMaterialCandidate[]
): LibraryObjMaterialCandidate[] {
  const requested = new Set(textureNames.map(normalizeObjResourceName))
  if (requested.size > MAX_OBJ_TEXTURE_FILES) {
    throw badRequest(`An OBJ can reference at most ${MAX_OBJ_TEXTURE_FILES} texture files`)
  }
  let totalBytes = 0
  const selected: LibraryObjMaterialCandidate[] = []
  for (const requestedName of requested) {
    const matches = candidates.filter((candidate) => normalizeObjResourceName(candidate.name) === requestedName)
    if (matches.length > 1) throw badRequest(`More than one library texture file matches ${requestedName}`)
    const match = matches[0]
    if (!match) continue
    totalBytes += match.sizeBytes
    if (match.sizeBytes > MAX_OBJ_TEXTURE_BYTES || totalBytes > MAX_OBJ_TEXTURE_BYTES) {
      throw new HttpError(413, 'OBJ textures exceed the 64 MB combined limit')
    }
    selected.push(match)
  }
  return selected
}

/** Find and read material and texture resources from the OBJ's own logical library directory. */
export async function resolveLibraryObjMaterialCompanions(
  libraryFile: LibraryObjLocation,
  objBytes: Buffer
): Promise<Array<{ name: string; bytes: Buffer }>> {
  if (referencedObjMaterialLibraries(objBytes).length === 0) return []
  const candidates = await prisma.libraryFile.findMany({
    where: {
      workspaceId: libraryFile.workspaceId,
      ownerBridgeId: libraryFile.ownerBridgeId,
      folderId: libraryFile.folderId,
      hidden: false,
      deletedAt: null,
      OR: [
        { name: { endsWith: '.mtl', mode: 'insensitive' } },
        { name: { endsWith: '.png', mode: 'insensitive' } },
        { name: { endsWith: '.jpg', mode: 'insensitive' } },
        { name: { endsWith: '.jpeg', mode: 'insensitive' } }
      ]
    },
    select: { name: true, ownerBridgeId: true, storedPath: true, sizeBytes: true }
  })
  const selectedMaterials = selectLibraryObjMaterialFiles(objBytes, candidates)
  const companions: Array<{ name: string; bytes: Buffer }> = []
  for (const match of selectedMaterials) {
    companions.push({
      name: match.name,
      bytes: await readFile(await resolveLibraryFileToLocalPath(match))
    })
  }
  const textureNames = companions.flatMap((companion) => referencedObjTextures(parseObjMaterials(companion.bytes)))
  for (const match of selectLibraryObjTextureFiles(textureNames, candidates)) {
    companions.push({
      name: match.name,
      bytes: await readFile(await resolveLibraryFileToLocalPath(match))
    })
  }
  return companions
}
