/**
 * Bridge library assignment recovery.
 *
 * Bridge-owned library metadata follows the physical bridge when it is
 * detached from one workspace and later connected to another.
 */
import { rootPrisma } from './prisma.js'

export interface BridgeLibraryAssignmentRecoveryResult {
  files: number
  folders: number
  versions: number
  replicas: number
}

export async function recoverBridgeLibraryAssignments(input: {
  workspaceId: string
  bridgeId: string
}): Promise<BridgeLibraryAssignmentRecoveryResult> {
  const [files, folders, versions, replicas] = await Promise.all([
    rootPrisma.libraryFile.updateMany({
      where: {
        ownerBridgeId: input.bridgeId,
        workspaceId: { not: input.workspaceId }
      },
      data: { workspaceId: input.workspaceId }
    }),
    rootPrisma.libraryFolder.updateMany({
      where: {
        ownerBridgeId: input.bridgeId,
        workspaceId: { not: input.workspaceId }
      },
      data: { workspaceId: input.workspaceId }
    }),
    rootPrisma.libraryFileVersion.updateMany({
      where: {
        ownerBridgeId: input.bridgeId,
        workspaceId: { not: input.workspaceId }
      },
      data: { workspaceId: input.workspaceId }
    }),
    rootPrisma.libraryFileReplica.updateMany({
      where: {
        bridgeId: input.bridgeId,
        workspaceId: { not: input.workspaceId }
      },
      data: { workspaceId: input.workspaceId }
    })
  ])

  return {
    files: files.count,
    folders: folders.count,
    versions: versions.count,
    replicas: replicas.count
  }
}

export function recoveredBridgeLibraryAssignmentCount(result: BridgeLibraryAssignmentRecoveryResult): number {
  return result.files + result.folders + result.versions + result.replicas
}