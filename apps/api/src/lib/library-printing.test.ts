process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, beforeEach, mock, test } from 'node:test'
import type { PrintDispatchJob, PrintFromLibrary, Printer } from '@printstream/shared'
import { bridgeSessionManager } from './bridge-session-manager.js'
import { enqueueLibraryPrint, validateLibraryPrint } from './library-printing.js'
import { printDispatcher } from './print-dispatcher.js'
import { printerManager } from './printer-manager.js'
import { prisma, rootPrisma } from './prisma.js'
import { withWorkspaceRequestContext } from './workspace-context.js'
import { usePrismaStubs } from '../test-utils/prisma-stubs.js'

const stub = usePrismaStubs()
beforeEach(() => { stub(prisma.workspaceTag, 'findMany', async () => []) })

const originalLibraryFileFindFirst = prisma.libraryFile.findFirst
const originalLibraryFileFindMany = prisma.libraryFile.findMany
const originalPrinterFindFirst = prisma.printer.findFirst
const originalIsConnected = bridgeSessionManager.isConnected
const originalGetPrinter = printerManager.getPrinter
const originalEnqueueSnapshotPrint = printDispatcher.enqueueSnapshotPrint

afterEach(() => {
  prisma.libraryFile.findFirst = originalLibraryFileFindFirst
  prisma.libraryFile.findMany = originalLibraryFileFindMany
  prisma.printer.findFirst = originalPrinterFindFirst
  bridgeSessionManager.isConnected = originalIsConnected
  printerManager.getPrinter = originalGetPrinter
  printDispatcher.enqueueSnapshotPrint = originalEnqueueSnapshotPrint
})

test('library print uses a unique connected replacement for stale disconnected bridge files', async () => {
  prisma.libraryFile.findFirst = ((async () => makeLibraryFile({
    id: 'old-file',
    ownerBridgeId: 'old-bridge',
    storedPath: 'old.gcode',
    snapshotKey: 'old-snapshot'
  })) as unknown) as typeof prisma.libraryFile.findFirst
  prisma.libraryFile.findMany = ((async () => [
    makeLibraryFile({
      id: 'new-file',
      ownerBridgeId: 'new-bridge',
      storedPath: 'new.gcode',
      snapshotKey: 'new-snapshot'
    })
  ]) as unknown) as typeof prisma.libraryFile.findMany
  prisma.printer.findFirst = ((async () => makePrinter()) as unknown) as typeof prisma.printer.findFirst
  bridgeSessionManager.isConnected = ((bridgeId: string) => bridgeId === 'new-bridge') as typeof bridgeSessionManager.isConnected
  printerManager.getPrinter = (() => makePrinter()) as typeof printerManager.getPrinter

  let dispatchedSnapshot: { id: string; ownerBridgeId?: string | null; storedPath: string } | null = null
  printDispatcher.enqueueSnapshotPrint = (async (input) => {
    dispatchedSnapshot = {
      id: input.snapshot.id,
      ownerBridgeId: input.snapshot.ownerBridgeId,
      storedPath: input.snapshot.storedPath
    }
    return makeJob()
  }) as typeof printDispatcher.enqueueSnapshotPrint

  await enqueueLibraryPrint(makePrintInput(), 'workspace-1')

  assert.deepEqual(dispatchedSnapshot, {
    id: 'new-file',
    ownerBridgeId: 'new-bridge',
    storedPath: 'new.gcode'
  })
})

test('library print recovers hidden stale snapshots with a unique connected replacement', async () => {
  prisma.libraryFile.findFirst = ((async () => makeLibraryFile({
    id: 'old-hidden-file',
    ownerBridgeId: 'old-bridge',
    storedPath: 'old-hidden.gcode',
    snapshotKey: 'old-hidden-snapshot',
    hidden: true
  })) as unknown) as typeof prisma.libraryFile.findFirst
  prisma.libraryFile.findMany = ((async () => [
    makeLibraryFile({
      id: 'new-visible-file',
      ownerBridgeId: 'new-bridge',
      storedPath: 'new-visible.gcode',
      snapshotKey: null
    })
  ]) as unknown) as typeof prisma.libraryFile.findMany
  prisma.printer.findFirst = ((async () => makePrinter()) as unknown) as typeof prisma.printer.findFirst
  bridgeSessionManager.isConnected = ((bridgeId: string) => bridgeId === 'new-bridge') as typeof bridgeSessionManager.isConnected
  printerManager.getPrinter = (() => makePrinter()) as typeof printerManager.getPrinter

  let dispatchedSnapshot: { id: string; ownerBridgeId?: string | null; storedPath: string } | null = null
  printDispatcher.enqueueSnapshotPrint = (async (input) => {
    dispatchedSnapshot = {
      id: input.snapshot.id,
      ownerBridgeId: input.snapshot.ownerBridgeId,
      storedPath: input.snapshot.storedPath
    }
    return makeJob()
  }) as typeof printDispatcher.enqueueSnapshotPrint

  await enqueueLibraryPrint(makePrintInput(), 'workspace-1')

  assert.deepEqual(dispatchedSnapshot, {
    id: 'new-visible-file',
    ownerBridgeId: 'new-bridge',
    storedPath: 'new-visible.gcode'
  })
})

test('validateLibraryPrint runs the pre-flight checks but never dispatches', async () => {
  prisma.libraryFile.findFirst = ((async () => makeLibraryFile({ id: 'file-1', snapshotKey: null })) as unknown) as typeof prisma.libraryFile.findFirst
  prisma.printer.findFirst = ((async () => makePrinter()) as unknown) as typeof prisma.printer.findFirst
  bridgeSessionManager.isConnected = (() => true) as typeof bridgeSessionManager.isConnected
  printerManager.getPrinter = (() => makePrinter()) as typeof printerManager.getPrinter
  let dispatched = false
  printDispatcher.enqueueSnapshotPrint = (async () => { dispatched = true; return makeJob() }) as typeof printDispatcher.enqueueSnapshotPrint

  await validateLibraryPrint(makePrintInput(), 'workspace-1') // resolves, all checks pass
  assert.equal(dispatched, false) // ...and it never starts a real print
})

test('validateLibraryPrint surfaces a missing file', async () => {
  prisma.libraryFile.findFirst = ((async () => null) as unknown) as typeof prisma.libraryFile.findFirst
  await assert.rejects(validateLibraryPrint(makePrintInput(), 'workspace-1'), /File not found/)
})

test('validateLibraryPrint surfaces a disconnected target printer', async () => {
  prisma.libraryFile.findFirst = ((async () => makeLibraryFile({ id: 'file-1', snapshotKey: null })) as unknown) as typeof prisma.libraryFile.findFirst
  prisma.printer.findFirst = ((async () => makePrinter()) as unknown) as typeof prisma.printer.findFirst
  bridgeSessionManager.isConnected = (() => true) as typeof bridgeSessionManager.isConnected
  printerManager.getPrinter = (() => undefined) as typeof printerManager.getPrinter // not connected
  await assert.rejects(validateLibraryPrint(makePrintInput(), 'workspace-1'), /not connected/)
})

test('library print carries the printed file\'s re-slice provenance onto the dispatch', async () => {
  // This is the only seam between "the slice preserved a project" and "print history can offer
  // Slice again": every print entrypoint funnels through here, and the fields ride the dispatch
  // onto the PrintJob row. Dropped here, the feature is invisible everywhere.
  prisma.libraryFile.findFirst = ((async () => makeLibraryFile({
    id: 'output-file',
    sourceProjectFileId: 'project-snapshot',
    sliceSettingsJson: '{"plate":2}'
  })) as unknown) as typeof prisma.libraryFile.findFirst
  prisma.printer.findFirst = ((async () => makePrinter()) as unknown) as typeof prisma.printer.findFirst
  bridgeSessionManager.isConnected = (() => true) as typeof bridgeSessionManager.isConnected
  printerManager.getPrinter = (() => makePrinter()) as typeof printerManager.getPrinter

  let dispatched: { sourceProjectFileId?: string | null; sliceSettingsJson?: string | null } | null = null
  printDispatcher.enqueueSnapshotPrint = (async (input) => {
    dispatched = {
      sourceProjectFileId: input.sourceProjectFileId,
      sliceSettingsJson: input.sliceSettingsJson
    }
    return makeJob()
  }) as typeof printDispatcher.enqueueSnapshotPrint

  await enqueueLibraryPrint(makePrintInput(), 'workspace-1')

  assert.deepEqual(dispatched, {
    sourceProjectFileId: 'project-snapshot',
    sliceSettingsJson: '{"plate":2}'
  })
})

test('library print takes the re-slice provenance from the file it actually dispatches', async () => {
  // A disconnected owner makes this substitute a duplicate on a connected bridge. That copy is a
  // different file with its own history, so the provenance must follow the substitution: reading
  // it off the requested file would attribute one project's settings to another file's bytes.
  prisma.libraryFile.findFirst = ((async () => makeLibraryFile({
    id: 'old-file',
    ownerBridgeId: 'old-bridge',
    storedPath: 'old.gcode',
    sourceProjectFileId: 'requested-project'
  })) as unknown) as typeof prisma.libraryFile.findFirst
  prisma.libraryFile.findMany = ((async () => [
    makeLibraryFile({
      id: 'new-file',
      ownerBridgeId: 'new-bridge',
      storedPath: 'new.gcode',
      snapshotKey: 'new-snapshot',
      sourceProjectFileId: 'dispatched-project'
    })
  ]) as unknown) as typeof prisma.libraryFile.findMany
  prisma.printer.findFirst = ((async () => makePrinter()) as unknown) as typeof prisma.printer.findFirst
  bridgeSessionManager.isConnected = ((bridgeId: string) => bridgeId === 'new-bridge') as typeof bridgeSessionManager.isConnected
  printerManager.getPrinter = (() => makePrinter()) as typeof printerManager.getPrinter

  let dispatchedProjectId: string | null | undefined
  printDispatcher.enqueueSnapshotPrint = (async (input) => {
    dispatchedProjectId = input.sourceProjectFileId
    return makeJob()
  }) as typeof printDispatcher.enqueueSnapshotPrint

  await enqueueLibraryPrint(makePrintInput(), 'workspace-1')

  assert.equal(dispatchedProjectId, 'dispatched-project')
})

function makeLibraryFile(overrides: Partial<{
  id: string
  ownerBridgeId: string | null
  storedPath: string
  snapshotKey: string | null
  hidden: boolean
  sourceProjectFileId: string | null
  sliceSettingsJson: string | null
}> = {}) {
  return {
    id: overrides.id ?? 'file-1',
    workspaceId: 'workspace-1',
    ownerBridgeId: overrides.ownerBridgeId ?? 'bridge-1',
    name: 'part.gcode',
    storedPath: overrides.storedPath ?? 'part.gcode',
    sizeBytes: 123,
    kind: 'gcode',
    thumbnailPath: null,
    uploadedAt: new Date('2026-05-08T18:00:00.000Z'),
    currentVersionNumber: 1,
    folderId: null,
    snapshotKey: overrides.snapshotKey ?? 'snapshot-1',
    hidden: overrides.hidden ?? false,
    sourceProjectFileId: overrides.sourceProjectFileId ?? null,
    sliceSettingsJson: overrides.sliceSettingsJson ?? null
  }
}

function makePrinter(): Printer {
  return {
    id: 'printer-1',
    name: 'Printer One',
    host: 'printer-one.local',
    serial: 'SERIAL-1',
    accessCode: 'secret',
    model: 'P1S',
    bridgeId: 'new-bridge',
    currentPlateType: null,
    currentNozzleDiameters: [],
    position: 0,
    createdAt: '2026-05-08T18:00:00.000Z',
    updatedAt: '2026-05-08T18:00:00.000Z'
  }
}

function makePrintInput(): PrintFromLibrary {
  return {
    fileId: 'old-file',
    printerId: 'printer-1',
    useAms: true,
    bedLevel: 'on',
    vibrationCompensation: false,
    flowCalibration: 'off',
    firstLayerInspection: true,
    timelapse: false,
    timelapseStorage: 'external',
    externalFilamentChangeAssist: false,
    filamentDynamicsCalibration: false,
    nozzleOffsetCalibration: 'auto',
    allowIncompatibleFilament: false,
    allowPlateTypeMismatch: false,
    allowPrinterModelMismatch: false,
    allowFilamentTrackSwitchMismatch: false,
    allowInsufficientFilament: false,
    allowBlacklistedFilament: false,
    currentPlateType: null,
    currentNozzleDiameters: [],
    plate: 1
  }
}

function makeJob(): PrintDispatchJob {
  return {
    id: 'job-1',
    printJobId: 'print-job-1',
    printerId: 'printer-1',
    printerName: 'Printer One',
    fileId: 'new-file',
    fileName: 'part.gcode',
    jobName: 'part.gcode',
    fileSizeBytes: 123,
    sourceKind: 'gcode',
    projectFilamentChips: [],
    plate: 1,
    plateName: null,
    useAms: true,
    bedLevel: 'on',
    amsMapping: null,
    status: 'queued',
    progressMessage: '',
    uploadAttempt: 0,
    uploadMaxAttempts: 3,
    uploadBytesSent: 0,
    uploadTotalBytes: null,
    uploadPercent: null,
    error: null,
    createdAt: new Date('2026-05-08T18:00:00.000Z').toISOString(),
    updatedAt: new Date('2026-05-08T18:00:00.000Z').toISOString(),
    startedAt: null,
    finishedAt: null,
    cancelRequested: false
  }
}

/**
 * Every `allow*` consent the wire accepts must reach the compatibility guard.
 *
 * `assertLibraryPrintSourceReady` projects the input field by field, so a flag added to
 * `printFromLibrarySchema` but not to that projection reaches the guard as `undefined` and the
 * dialog's confirmation becomes inert: the user ticks the box and still gets a 409 they cannot get
 * past. That happened to `allowBlacklistedFilament`, and it typechecked perfectly, because the
 * target field is optional. This reads the source rather than exercising a dispatch because the
 * omission is invisible at runtime unless the specific guard it feeds happens to fire.
 */
test('every consent flag on the wire is forwarded to the compatibility guard', async () => {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const { printFromLibrarySchema } = await import('@printstream/shared')

  const source = await readFile(fileURLToPath(new URL('./library-printing.ts', import.meta.url)), 'utf8')
  const consentFlags = Object.keys(printFromLibrarySchema.shape).filter((key) => key.startsWith('allow'))
  assert.ok(consentFlags.length >= 5, 'expected the schema to carry the consent flags')

  for (const flag of consentFlags) {
    assert.ok(
      source.includes(`${flag}: input.${flag}`),
      `library-printing.ts must forward ${flag} to assertLibraryPrintCompatibilityForIndex`
    )
  }
})

test('dispatch preserves live source identity across snapshot deduplication and history reprints', async () => {
  const source = { ...makeLibraryFile({ id: 'original-file' }), snapshotKey: null }
  const snapshot = makeLibraryFile({ id: 'shared-snapshot', snapshotKey: 'dedupe-key', hidden: true })
  prisma.libraryFile.findFirst = (async () => source) as typeof prisma.libraryFile.findFirst
  stub(prisma.printer, 'findFirst', async () => makePrinter())
  bridgeSessionManager.isConnected = () => true
  printerManager.getPrinter = () => makePrinter()
  stub(rootPrisma.libraryFile, 'update', async () => snapshot)
  const rpc = mock.method(bridgeSessionManager, 'requestRpc', async (_bridgeId: string, method: string) => {
    if (method === 'library.stat') return { sizeBytes: 123, contentSha256: 'a'.repeat(64) }
    if (method === 'library.copy') return { ok: true }
    throw new Error(`Unexpected RPC ${method}`)
  })
  const dispatched: Array<{ snapshotId: string; sourceId: string | null | undefined }> = []
  printDispatcher.enqueueSnapshotPrint = async (input) => {
    dispatched.push({ snapshotId: input.snapshot.id, sourceId: input.sourceLibraryFileId })
    return makeJob()
  }
  try {
    await withWorkspaceRequestContext({ id: 'workspace-1', slug: 'test', name: 'Test' } as Parameters<typeof withWorkspaceRequestContext>[0], async () => {
      await enqueueLibraryPrint(makePrintInput(), 'workspace-1')
      prisma.libraryFile.findFirst = (async () => snapshot) as typeof prisma.libraryFile.findFirst
      await enqueueLibraryPrint(makePrintInput(), 'workspace-1', 'original-file')
      await enqueueLibraryPrint(makePrintInput(), 'workspace-1')
    })
    assert.deepEqual(dispatched, [
      { snapshotId: 'shared-snapshot', sourceId: 'original-file' },
      { snapshotId: 'shared-snapshot', sourceId: 'original-file' },
      { snapshotId: 'shared-snapshot', sourceId: null }
    ])
  } finally {
    rpc.mock.restore()
  }
})


test('slice-and-print carries source project vocabulary independently of source deletion', async () => {
  const saved = { id: 'source-tag', entityKind: 'file', name: 'Original project', group: 'Customer', color: '#123456' }
  stub(prisma.libraryFile, 'findFirst', async () => ({
    ...makeLibraryFile({ snapshotKey: 'existing-byte-snapshot' }),
    sourceTagSnapshotJson: JSON.stringify({ tags: [saved], spoolIds: [] })
  }))
  stub(prisma.printer, 'findFirst', async () => makePrinter())
  stub(prisma.workspaceTag, 'findMany', async () => [])
  bridgeSessionManager.isConnected = (() => true) as typeof bridgeSessionManager.isConnected
  printerManager.getPrinter = (() => makePrinter()) as typeof printerManager.getPrinter
  printDispatcher.enqueueSnapshotPrint = (async (input) => {
    assert.deepEqual(input.tagSnapshot, [saved])
    return makeJob()
  }) as typeof printDispatcher.enqueueSnapshotPrint
  await enqueueLibraryPrint(makePrintInput(), 'workspace-1')
})
