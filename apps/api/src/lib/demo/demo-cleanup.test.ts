process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { after, beforeEach, mock, test } from 'node:test'
import { restorePrismaMethodsAfterEach } from '../../test-utils/prisma-stubs.js'

const testRoot = mkdtempSync(path.join(tmpdir(), 'bambu-demo-cleanup-test-'))
process.env.LIBRARY_DIR = path.join(testRoot, 'library')

const { pruneSeededDemoData } = await import('./demo-data.js')
const { DEMO_PRINTER_SEEDS } = await import('./demo-printers.js')
const { rootPrisma } = await import('../prisma.js')
const { getPrintJobThumbnailDir } = await import('../print-job-thumbnails.js')

// Auto-restore the rootPrisma delegates this test swaps out (it still spreads the real delegate into
// each mock), replacing the per-test try/finally restore block.
restorePrismaMethodsAfterEach([
  [rootPrisma, 'tenant'],
  [rootPrisma, 'printJob'],
  [rootPrisma, 'printer']
])

after(async () => {
  mock.restoreAll()
  await rm(testRoot, { recursive: true, force: true })
})

beforeEach(async () => {
  mock.restoreAll()
  await rm(testRoot, { recursive: true, force: true })
  await mkdir(process.env.LIBRARY_DIR!, { recursive: true })
})

test('pruneSeededDemoData removes persisted demo thumbnails and seeded printers', async () => {
  const storedPath = 'demo-job.png'
  const thumbnailPath = path.join(getPrintJobThumbnailDir(), storedPath)
  await mkdir(path.dirname(thumbnailPath), { recursive: true })
  await writeFile(thumbnailPath, Buffer.from('png'))

  const originalTenant = rootPrisma.tenant
  const originalPrintJob = rootPrisma.printJob
  const originalPrinter = rootPrisma.printer
  const deleteManyCalls: Array<unknown> = []

  Object.defineProperty(rootPrisma, 'tenant', {
    configurable: true,
    value: {
      ...originalTenant,
      findUnique: async () => ({ id: 'tenant-1' }),
      findFirst: async () => ({ id: 'tenant-1' })
    }
  })
  Object.defineProperty(rootPrisma, 'printJob', {
    configurable: true,
    value: {
      ...originalPrintJob,
      findMany: async () => [{ thumbnailPath: storedPath }]
    }
  })
  Object.defineProperty(rootPrisma, 'printer', {
    configurable: true,
    value: {
      ...originalPrinter,
      deleteMany: async (input: unknown) => {
        deleteManyCalls.push(input)
        return { count: DEMO_PRINTER_SEEDS.length }
      }
    }
  })

  const result = await pruneSeededDemoData()

  assert.deepEqual(result, {
    printersRemoved: DEMO_PRINTER_SEEDS.length,
    thumbnailsRemoved: 1
  })
  assert.equal(deleteManyCalls.length, 1)
  assert.deepEqual(deleteManyCalls[0], {
    where: { tenantId: 'tenant-1', serial: { in: DEMO_PRINTER_SEEDS.map((seed) => seed.serial) } }
  })
  await assert.rejects(stat(thumbnailPath), /ENOENT/)
})