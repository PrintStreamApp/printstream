process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  recoverBridgeLibraryAssignments,
  recoveredBridgeLibraryAssignmentCount
} from './bridge-library-assignment-recovery.js'
import { rootPrisma } from './prisma.js'

const originalLibraryFileUpdateMany = rootPrisma.libraryFile.updateMany
const originalLibraryFolderUpdateMany = rootPrisma.libraryFolder.updateMany
const originalLibraryFileVersionUpdateMany = rootPrisma.libraryFileVersion.updateMany
const originalLibraryFileReplicaUpdateMany = rootPrisma.libraryFileReplica.updateMany

afterEach(() => {
  rootPrisma.libraryFile.updateMany = originalLibraryFileUpdateMany
  rootPrisma.libraryFolder.updateMany = originalLibraryFolderUpdateMany
  rootPrisma.libraryFileVersion.updateMany = originalLibraryFileVersionUpdateMany
  rootPrisma.libraryFileReplica.updateMany = originalLibraryFileReplicaUpdateMany
})

test('recoverBridgeLibraryAssignments moves bridge-owned library metadata to the new tenant', async () => {
  const calls: Array<[string, unknown]> = []
  rootPrisma.libraryFile.updateMany = ((async (args: unknown) => {
    calls.push(['files', args])
    return { count: 2 }
  }) as unknown) as typeof rootPrisma.libraryFile.updateMany
  rootPrisma.libraryFolder.updateMany = ((async (args: unknown) => {
    calls.push(['folders', args])
    return { count: 1 }
  }) as unknown) as typeof rootPrisma.libraryFolder.updateMany
  rootPrisma.libraryFileVersion.updateMany = ((async (args: unknown) => {
    calls.push(['versions', args])
    return { count: 3 }
  }) as unknown) as typeof rootPrisma.libraryFileVersion.updateMany
  rootPrisma.libraryFileReplica.updateMany = ((async (args: unknown) => {
    calls.push(['replicas', args])
    return { count: 4 }
  }) as unknown) as typeof rootPrisma.libraryFileReplica.updateMany

  const result = await recoverBridgeLibraryAssignments({
    tenantId: 'tenant-home',
    bridgeId: 'bridge-home'
  })

  assert.deepEqual(result, {
    files: 2,
    folders: 1,
    versions: 3,
    replicas: 4
  })
  assert.equal(recoveredBridgeLibraryAssignmentCount(result), 10)
  assert.deepEqual(calls, [
    ['files', {
      where: {
        ownerBridgeId: 'bridge-home',
        tenantId: { not: 'tenant-home' }
      },
      data: { tenantId: 'tenant-home' }
    }],
    ['folders', {
      where: {
        ownerBridgeId: 'bridge-home',
        tenantId: { not: 'tenant-home' }
      },
      data: { tenantId: 'tenant-home' }
    }],
    ['versions', {
      where: {
        ownerBridgeId: 'bridge-home',
        tenantId: { not: 'tenant-home' }
      },
      data: { tenantId: 'tenant-home' }
    }],
    ['replicas', {
      where: {
        bridgeId: 'bridge-home',
        tenantId: { not: 'tenant-home' }
      },
      data: { tenantId: 'tenant-home' }
    }]
  ])
})