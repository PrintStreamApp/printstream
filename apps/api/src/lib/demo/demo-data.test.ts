import assert from 'node:assert/strict'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach } from 'node:test'
import { test } from 'node:test'
import { DEMO_PRINTER_SEEDS } from './demo-printers.js'
import {
  buildDemoFinishedJobSeeds,
  findDemoPlaylistJob,
  findDemoLibraryFile,
  findDemoLibraryReconcileFile,
  findDemoLibraryEntryName,
  getDemoAutoStartDelayMs,
  getNextDemoPlaylistJob,
  normalizeDemoLibraryDisplayName,
  resolveDemoLibraryDir,
  seedDemoJobs,
  selectDemoFinishedSnapshotName
} from './demo-data.js'
import { readPrintJobSnapshot } from '../print-job-snapshots.js'
import { rootPrisma } from '../prisma.js'
import { restorePrismaMethodsAfterEach } from '../../test-utils/prisma-stubs.js'

const originalPrinter = rootPrisma.printer
const originalLibraryFile = rootPrisma.libraryFile
const originalPrintJob = rootPrisma.printJob
const originalTenantStats = rootPrisma.tenantStats
const originalPrinterStats = rootPrisma.printerStats
const tempDirs = new Set<string>()

// Auto-restore the rootPrisma delegates these tests swap out (the consts above are still spread into
// each mock), replacing the per-method restore block.
restorePrismaMethodsAfterEach([
  [rootPrisma, 'tenant'],
  [rootPrisma, 'printer'],
  [rootPrisma, 'libraryFile'],
  [rootPrisma, 'printJob'],
  [rootPrisma, 'tenantStats'],
  [rootPrisma, 'printerStats']
])

afterEach(async () => {
  await Promise.all(Array.from(tempDirs, async (dir) => rm(dir, { recursive: true, force: true })))
  tempDirs.clear()
})

function stubDemoStatsWrites(): void {
  Object.defineProperty(rootPrisma, 'tenantStats', {
    configurable: true,
    value: {
      ...originalTenantStats,
      upsert: async (input: unknown) => input
    }
  })
  Object.defineProperty(rootPrisma, 'printerStats', {
    configurable: true,
    value: {
      ...originalPrinterStats,
      upsert: async (input: unknown) => input
    }
  })
}

test('normalizeDemoLibraryDisplayName strips generated upload prefixes', () => {
  assert.equal(normalizeDemoLibraryDisplayName('1777174072904-Storage_Box.gcode.3mf'), 'Storage_Box.gcode.3mf')
  assert.equal(normalizeDemoLibraryDisplayName('74e6cf47eafde1fb-Tests_H2D.gcode.3mf'), 'Tests_H2D.gcode.3mf')
  assert.equal(normalizeDemoLibraryDisplayName('Needle_Lift_Tool.gcode.3mf'), 'Needle_Lift_Tool.gcode.3mf')
})

test('findDemoLibraryEntryName matches a display name against timestamped stored filenames', () => {
  const matched = findDemoLibraryEntryName([
    '1777174072904-Storage_Box.gcode.3mf',
    '1777174072916-Latch_Needle_Handle.gcode.3mf'
  ], 'Storage_Box.gcode.3mf')

  assert.equal(matched, '1777174072904-Storage_Box.gcode.3mf')
  assert.equal(findDemoLibraryEntryName(['Needle_Lift_Tool.gcode.3mf'], 'Missing.gcode.3mf'), null)
})

test('findDemoLibraryFile matches a library row by normalized stored path when the display name differs', () => {
  const matched = findDemoLibraryFile([
    {
      id: 'file-1',
      name: 'Storage Box',
      sizeBytes: 2048,
      storedPath: '1777174072904-Storage_Box.gcode.3mf'
    }
  ], 'Storage_Box.gcode.3mf')

  assert.deepEqual(matched, {
    id: 'file-1',
    name: 'Storage Box',
    sizeBytes: 2048,
    storedPath: '1777174072904-Storage_Box.gcode.3mf'
  })
})

test('findDemoLibraryReconcileFile keeps hidden one-off uploads matched by exact stored path', () => {
  const matched = findDemoLibraryReconcileFile([
    {
      id: 'file-visible',
      name: 'Card Holder (3 rows)',
      sizeBytes: 1024,
      storedPath: 'Card Holder (3 rows).gcode.3mf',
      hidden: false
    },
    {
      id: 'file-hidden',
      name: 'Card Holder (3 rows).gcode.3mf',
      sizeBytes: 2048,
      storedPath: 'faeae66bbb0c95ae-Card_Holder_3_rows_.gcode.3mf',
      hidden: true
    },
    {
      id: 'file-duplicate',
      name: 'Card_Holder_3_rows_.gcode.3mf',
      sizeBytes: 2048,
      storedPath: 'faeae66bbb0c95ae-Card_Holder_3_rows_.gcode.3mf',
      hidden: false
    }
  ], 'faeae66bbb0c95ae-Card_Holder_3_rows_.gcode.3mf')

  assert.deepEqual(matched, {
    id: 'file-hidden',
    name: 'Card Holder (3 rows).gcode.3mf',
    sizeBytes: 2048,
    storedPath: 'faeae66bbb0c95ae-Card_Holder_3_rows_.gcode.3mf',
    hidden: true
  })
})

test('findDemoLibraryReconcileFile ignores hidden rows when matching visible curated demo files by display name', () => {
  const matched = findDemoLibraryReconcileFile([
    {
      id: 'file-visible',
      name: 'Tire Rotation Markers',
      sizeBytes: 1024,
      storedPath: 'Tire Rotation Markers.gcode.3mf',
      hidden: false
    },
    {
      id: 'file-hidden',
      name: 'Tire Rotation Markers.gcode.3mf',
      sizeBytes: 2048,
      storedPath: 'eb48ae27a44a3350-Tire_Rotation_Markers.gcode.3mf',
      hidden: true
    }
  ], 'Tire Rotation Markers.gcode.3mf')

  assert.deepEqual(matched, {
    id: 'file-visible',
    name: 'Tire Rotation Markers',
    sizeBytes: 1024,
    storedPath: 'Tire Rotation Markers.gcode.3mf',
    hidden: false
  })
})

test('buildDemoFinishedJobSeeds creates one library-backed finished job per seeded printer', () => {
  const seeds = buildDemoFinishedJobSeeds(Date.UTC(2026, 4, 1))

  assert.equal(seeds.length, DEMO_PRINTER_SEEDS.length)
  assert.deepEqual(
    [...new Set(seeds.map((seed) => seed.printerSerial))].sort(),
    DEMO_PRINTER_SEEDS.map((seed) => seed.serial).sort()
  )
  assert.equal(seeds.every((seed) => seed.fileName.endsWith('.gcode.3mf')), true)
})

test('buildDemoFinishedJobSeeds follows the provided demo file set', () => {
  const seeds = buildDemoFinishedJobSeeds(Date.UTC(2026, 4, 1), [
    'Card Holder (3 rows).gcode.3mf',
    'Number Plates.gcode.3mf',
    'Tire Rotation Markers.gcode.3mf'
  ])

  assert.equal(seeds[0]?.fileName, 'Card Holder (3 rows).gcode.3mf')
  assert.equal(seeds[0]?.jobName, 'Card Holder (3 rows)')
  assert.equal(typeof seeds[0]?.filamentUsedGrams, 'number')
  assert.equal(typeof seeds[0]?.filamentUsedMeters, 'number')
  assert.equal(seeds[1]?.fileName, 'Number Plates.gcode.3mf')
  assert.equal(seeds[2]?.fileName, 'Card Holder (3 rows).gcode.3mf')
})

test('selectDemoFinishedSnapshotName deterministically rotates seeded demo snapshot assets', () => {
  assert.equal(selectDemoFinishedSnapshotName('DEMO-X1C-001'), 'chamber-blue-bin.jpg')
  assert.equal(selectDemoFinishedSnapshotName('DEMO-H2D-001'), 'chamber-green-bin.jpg')
  assert.equal(selectDemoFinishedSnapshotName('DEMO-P1S-001'), 'chamber-purple-part.jpg')
  assert.equal(selectDemoFinishedSnapshotName('DEMO-P1S-002'), 'chamber-purple-part.jpg')
})

test('resolveDemoLibraryDir treats relative demo-library paths as repo-root relative', () => {
  const resolved = resolveDemoLibraryDir('./data/demo-library')

  assert.equal(path.isAbsolute(resolved), true)
  assert.equal(resolved.endsWith('/data/demo-library'), true)
})

test('getNextDemoPlaylistJob rotates through each printer\'s deterministic demo playlist', () => {
  assert.equal(getNextDemoPlaylistJob('DEMO-X1C-001', null)?.jobName, 'Card Holder (3 rows)')
  assert.equal(getNextDemoPlaylistJob('DEMO-X1C-001', 'Card Holder (3 rows)')?.jobName, 'Tire Rotation Markers')
  assert.equal(getNextDemoPlaylistJob('DEMO-X1C-001', 'Number Plates')?.jobName, 'Card Holder (3 rows)')
})

test('seedDemoJobs creates active unfinished rows for seeded demo printers with matching local library files', async () => {
  const printers = [
    {
      id: 'printer-p1s',
      tenantId: 'tenant-1',
      serial: 'DEMO-P1S-001',
      model: 'P1S',
      position: 2
    },
    {
      id: 'printer-h2d',
      tenantId: 'tenant-1',
      serial: 'DEMO-H2D-002',
      model: 'H2D',
      position: 4
    }
  ]
  const files = [
    {
      id: 'file-card-holder',
      name: 'Card Holder (3 rows)',
      storedPath: 'Card Holder (3 rows).gcode.3mf',
      sizeBytes: 1024,
      uploadedAt: new Date('2026-05-01T00:00:00.000Z'),
      hidden: false
    },
    {
      id: 'file-number-plates',
      name: 'Number Plates',
      storedPath: 'Number Plates.gcode.3mf',
      sizeBytes: 2048,
      uploadedAt: new Date('2026-05-01T00:01:00.000Z'),
      hidden: false
    },
    {
      id: 'file-tire-rotation',
      name: 'Tire Rotation Markers',
      storedPath: 'Tire Rotation Markers.gcode.3mf',
      sizeBytes: 3072,
      uploadedAt: new Date('2026-05-01T00:02:00.000Z'),
      hidden: false
    },
    {
      id: 'file-rail-mount',
      name: 'Rail Mount',
      storedPath: 'Rail Mount.gcode.3mf',
      sizeBytes: 4096,
      uploadedAt: new Date('2026-05-01T00:03:00.000Z'),
      hidden: false
    }
  ]
  const creates: Array<Record<string, unknown>> = []
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = []

  Object.defineProperty(rootPrisma, 'printer', {
    configurable: true,
    value: {
      ...originalPrinter,
      findMany: async () => printers
    }
  })
  Object.defineProperty(rootPrisma, 'libraryFile', {
    configurable: true,
    value: {
      ...originalLibraryFile,
      findMany: async () => files
    }
  })
  Object.defineProperty(rootPrisma, 'printJob', {
    configurable: true,
    value: {
      ...originalPrintJob,
      findMany: async ({ where }: { where: { finishedAt?: null | { not: null }; printerId?: { in: string[] } } }) => {
        if (where.finishedAt && typeof where.finishedAt === 'object' && 'not' in where.finishedAt) {
          return []
        }
        return []
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        creates.push(data)
        return { id: `job-${creates.length}`, ...data }
      },
      update: async (input: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push(input)
        return { id: input.where.id, ...input.data }
      },
      updateMany: async () => ({ count: 0 }),
      deleteMany: async () => ({ count: 0 })
    }
  })
  stubDemoStatsWrites()

  await seedDemoJobs({ tenantId: 'tenant-1' })

  const activeRows = creates.filter((row) => row.finishedAt === null)
  const finishedRows = creates.filter((row) => row.finishedAt != null)
  assert.equal(activeRows.length, 2)
  assert.equal(finishedRows.every((row) => typeof row.filamentUsedGrams === 'number' && typeof row.filamentUsedMeters === 'number'), true)
  assert.equal(activeRows.some((row) => row.printerId === 'printer-p1s' && row.fileName === 'Card Holder (3 rows)' && typeof row.taskId === 'string'), true)
  assert.equal(activeRows.some((row) => row.printerId === 'printer-h2d' && row.fileName === 'Rail Mount' && typeof row.taskId === 'string'), true)
  assert.equal(updates.some((entry) => typeof entry.data.thumbnailPath === 'string'), true)
})

test('seedDemoJobs deletes stale synthetic active rows and finished unknown remnants', async () => {
  const printers = [
    {
      id: 'printer-p1s',
      tenantId: 'tenant-1',
      serial: 'DEMO-P1S-001',
      model: 'P1S',
      position: 2
    },
    {
      id: 'printer-h2d',
      tenantId: 'tenant-1',
      serial: 'DEMO-H2D-002',
      model: 'H2D',
      position: 4
    },
    {
      id: 'printer-idle',
      tenantId: 'tenant-1',
      serial: 'DEMO-P1S-002',
      model: 'P1S',
      position: 5
    }
  ]
  const files = [
    {
      id: 'file-card-holder',
      name: 'Card Holder (3 rows)',
      storedPath: 'Card Holder (3 rows).gcode.3mf',
      sizeBytes: 1024,
      uploadedAt: new Date('2026-05-01T00:00:00.000Z'),
      hidden: false
    },
    {
      id: 'file-number-plates',
      name: 'Number Plates',
      storedPath: 'Number Plates.gcode.3mf',
      sizeBytes: 2048,
      uploadedAt: new Date('2026-05-01T00:01:00.000Z'),
      hidden: false
    }
  ]
  const deleteManyCalls: Array<Record<string, unknown>> = []

  Object.defineProperty(rootPrisma, 'printer', {
    configurable: true,
    value: {
      ...originalPrinter,
      findMany: async () => printers
    }
  })
  Object.defineProperty(rootPrisma, 'libraryFile', {
    configurable: true,
    value: {
      ...originalLibraryFile,
      findMany: async () => files
    }
  })
  Object.defineProperty(rootPrisma, 'printJob', {
    configurable: true,
    value: {
      ...originalPrintJob,
      findMany: async ({ where }: { where: { finishedAt?: null | { not: null }; printerId?: { in: string[] } } }) => {
        if (where.finishedAt && typeof where.finishedAt === 'object' && 'not' in where.finishedAt) {
          return []
        }
        return [{
          id: 'stale-active',
          printerId: 'printer-idle',
          taskId: 'demo-task-DEMO-P1S-002-Tire Rotation Markers.gcode.3mf-plate-1',
          thumbnailPath: 'thumb.png'
        }]
      },
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'created-job', ...data }),
      update: async (input: { where: { id: string }; data: Record<string, unknown> }) => ({ id: input.where.id, ...input.data }),
      updateMany: async () => ({ count: 0 }),
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        deleteManyCalls.push(where)
        return { count: 1 }
      }
    }
  })
  stubDemoStatsWrites()

  await seedDemoJobs({ tenantId: 'tenant-1' })

  assert.equal(deleteManyCalls.length, 2)
  assert.deepEqual(deleteManyCalls[0], { id: { in: ['stale-active'] } })
  assert.deepEqual(deleteManyCalls[1], {
    tenantId: 'tenant-1',
    printerId: { in: ['printer-p1s', 'printer-h2d', 'printer-idle'] },
    taskId: { startsWith: 'demo-task-' },
    finishedAt: { not: null },
    result: 'unknown',
    progressPercent: null,
    durationSeconds: null
  })
})

// The finished-snapshot backfill reads a bundled demo camera asset: selectDemoFinishedSnapshotName
// maps DEMO-X1C-001 -> chamber-blue-bin.jpg, which is gitignored and absent in fresh checkouts. With
// it missing, persistDemoFinishedSnapshot's readFile threw -> no snapshot update (assertion failure),
// and that error path stalled the test runner when run without instrumentation. We provision the
// asset below so the happy path runs hermetically; the bounded timeout stays as a safety net. (Also
// fixed above: seedDemoJobs called the unmocked rootPrisma.printJob.deleteMany, doing real DB I/O.)
test('seedDemoJobs backfills a fake final snapshot for existing finished demo jobs', { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bambu-demo-finished-job-'))
  tempDirs.add(root)
  process.env.LIBRARY_DIR = path.join(root, 'library')

  const printers = [{
    id: 'printer-1',
    tenantId: 'tenant-1',
    serial: 'DEMO-X1C-001',
    position: 0
  }]
  const files = [{
    id: 'file-1',
    name: 'Card Holder (3 rows)',
    storedPath: 'Card Holder (3 rows).gcode.3mf',
    sizeBytes: 2048,
    uploadedAt: new Date('2026-05-01T00:00:00.000Z'),
    hidden: false
  }]
  const existingJobs = [{
    id: 'job-1',
    printerId: 'printer-1',
    jobName: 'Card Holder (3 rows)',
    fileId: 'file-1',
    fileName: 'Card Holder (3 rows)',
    fileSizeBytes: 2048,
    plate: 2,
    useAms: true,
    bedLevel: true,
    amsMapping: '[0]',
    sourceType: 'library',
    thumbnailPath: 'job-1.png',
    snapshotPath: null
  }]
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = []

  Object.defineProperty(rootPrisma, 'printer', {
    configurable: true,
    value: {
      ...originalPrinter,
      findMany: async () => printers
    }
  })
  Object.defineProperty(rootPrisma, 'libraryFile', {
    configurable: true,
    value: {
      ...originalLibraryFile,
      findMany: async () => files
    }
  })
  Object.defineProperty(rootPrisma, 'printJob', {
    configurable: true,
    value: {
      ...originalPrintJob,
      deleteMany: async () => ({ count: 0 }),
      findMany: async () => existingJobs,
      update: async (input: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push(input)
        return { id: input.where.id, ...input.data }
      },
      create: async () => {
        throw new Error('seedDemoJobs should update the existing finished row in this test')
      }
    }
  })
  stubDemoStatsWrites()

  // Provision the gitignored demo camera asset the backfill reads, so the happy path is exercised
  // without depending on developer-local files (removed afterwards only if we created it).
  const snapshotSource = path.join(
    resolveDemoLibraryDir('./data/demo-camera-snapshots'),
    selectDemoFinishedSnapshotName('DEMO-X1C-001')
  )
  let provisionedSnapshot = false
  if (!existsSync(snapshotSource)) {
    await mkdir(path.dirname(snapshotSource), { recursive: true })
    await writeFile(snapshotSource, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    provisionedSnapshot = true
  }

  try {
    await seedDemoJobs({ tenantId: 'tenant-1' })

    const snapshotUpdate = updates.find((entry) => typeof entry.data.snapshotPath === 'string')
    assert.ok(snapshotUpdate)
    assert.equal(snapshotUpdate?.where.id, 'job-1')
    assert.equal(snapshotUpdate?.data.snapshotPath, 'job-1.jpg')

    const image = await readPrintJobSnapshot('job-1.jpg')
    assert.ok(image)
    assert.equal(image?.length > 0, true)
  } finally {
    if (provisionedSnapshot) await rm(snapshotSource, { force: true })
  }
})

test('findDemoPlaylistJob resolves an existing demo job name for backfilling history metadata', () => {
  assert.deepEqual(findDemoPlaylistJob('DEMO-H2D-002', 'Number Plates'), {
    fileName: 'Number Plates.gcode.3mf',
    jobName: 'Number Plates',
    useAms: true,
    amsMapping: [1, 7],
    plate: 1,
    bedLevel: true
  })
  assert.equal(findDemoPlaylistJob('DEMO-H2D-002', 'Missing Job'), null)
})

test('getDemoAutoStartDelayMs staggers initial and repeat starts by printer position', () => {
  assert.equal(getDemoAutoStartDelayMs('DEMO-X1C-001', 'initial'), 15_000)
  assert.equal(getDemoAutoStartDelayMs('DEMO-P1S-002', 'initial'), 50_000)
  assert.equal(getDemoAutoStartDelayMs('DEMO-X1C-001', 'repeat'), 35_000)
  assert.equal(getDemoAutoStartDelayMs('DEMO-P1S-002', 'repeat'), 70_000)
})
