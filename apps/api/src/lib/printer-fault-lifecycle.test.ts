/** PostgreSQL acceptance fixtures for durable fault identity, uncertainty and tenant constraints. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { Client } from 'pg'
import { PrismaClient } from '@prisma/client'
import type { PrinterStatus } from '@printstream/shared'
import { applyPendingMigrations } from './apply-migrations.js'
import { makeOfflineStatus } from './bambu-report-parser.js'
import { PrinterFaultRecorder } from './printer-fault-recorder.js'
import { persistFaultObservation, linkRecordedJobFaults } from './printer-fault-store.js'
import { deleteClearedPrinterFault, readJobFaults, readStandaloneFaultHistory } from './printer-fault-history.js'
import { registerPendingPrintJobSource, clearAllPendingPrintJobSources } from './pending-print-job-source.js'
import { prisma } from './prisma.js'
import { usePrismaStubs } from '../test-utils/prisma-stubs.js'

// Deliberately require an explicit fixture administrator URL, never infer live DATABASE_URL.
const adminUrl = process.env.TEST_ADMIN_DATABASE_URL
const fixture = { skip: !adminUrl }
let admin: Client
let db: PrismaClient
const name = `fault_fixture_${randomUUID().replace(/-/g, '')}`
const stub = usePrismaStubs()
const printer = {
  id: 'p', name: 'Fixture', serial: '094fixture', host: '127.0.0.1', accessCode: 'fixture',
  model: 'P1S' as const, currentPlateType: null, currentNozzleDiameters: [], position: 0,
  createdAt: '2026-10-25T12:00:00.000Z', updatedAt: '2026-10-25T12:00:00.000Z'
}
const at = (minute: number) => new Date(Date.UTC(2026, 9, 25, 16, minute))
function status(minute: number, stage: PrinterStatus['stage'] = 'idle', taskId: string | null = null): PrinterStatus {
  return { ...makeOfflineStatus(printer), online: true, stage, taskId, observedAt: at(minute).toISOString() }
}
const hms = { code: '0700801100020001', message: 'Filament exhausted' }
const device = { code: '07008011', message: 'Extrusion fault' }
const event = (minute: number, sources: Parameters<PrinterFaultRecorder['observe']>[0]['sources'], stage: PrinterStatus['stage'] = 'idle', taskId: string | null = null) => ({ workspaceId: 'w', status: status(minute, stage, taskId), sources })
async function job(id: string, minute: number, taskId = id) {
  return await db.printJob.create({ data: { id, workspaceId: 'w', printerId: 'p', jobName: id, startedAt: at(minute), taskId } })
}

before(async () => {
  if (!adminUrl) {
    assert.notEqual(process.env.PRINTSTREAM_REQUIRE_TEST_DATABASE, '1', 'fixture PostgreSQL is required for validation')
    return
  }
  admin = new Client({ connectionString: adminUrl })
  await admin.connect()
  await admin.query(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  await applyPendingMigrations({ databaseUrl: url.toString() })
  db = new PrismaClient({ datasources: { db: { url: url.toString() } } })
})
after(async () => {
  await db?.$disconnect()
  if (admin) {
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)
    await admin.end()
  }
})
beforeEach(async () => {
  if (!db) return
  await db.workspace.deleteMany()
  await db.workspace.createMany({ data: [{ id: 'w', name: 'Fixture', slug: 'fixture' }, { id: 'other', name: 'Other', slug: 'other' }] })
  await db.printer.create({ data: { id: 'p', workspaceId: 'w', name: 'Fixture', serial: 'fixture', host: '127.0.0.1', accessCode: 'fixture' } })
  stub(prisma.printerFault, 'findMany', (args) => db.printerFault.findMany(args))
  stub(prisma.printerFault, 'findFirst', (args) => db.printerFault.findFirst(args))
  stub(prisma.printerFault, 'deleteMany', (args) => db.printerFault.deleteMany(args))
  stub(prisma.printJobFault, 'findMany', (args) => db.printJobFault.findMany(args))
})

afterEach(() => { clearAllPendingPrintJobSources(); mock.restoreAll() })

test('source-specific reconnect preserves identity and the gap; a later confirmed recurrence is new', fixture, async () => {
  const changed: string[] = []
  const recorder = new PrinterFaultRecorder(db, (workspace) => changed.push(workspace))
  await recorder.observe(event(0, { hms: [hms, hms], device_error: [device, device] }))
  await recorder.observe(event(1, { hms: [hms], device_error: [device] }))
  const initial = await db.printerFault.findMany({ orderBy: { source: 'asc' } })
  assert.equal(initial.length, 2)
  await recorder.gap({ workspaceId: 'w', printerId: 'p', observedAt: at(2).toISOString() })
  await recorder.observe(event(3, {}))
  await recorder.observe(event(4, { hms: [hms] }))
  const rows = await db.printerFault.findMany({ include: { gaps: true } })
  assert.equal(rows.find((row) => row.source === 'hms')?.id, initial.find((row) => row.source === 'hms')?.id)
  assert.equal(rows.find((row) => row.source === 'hms')?.gaps[0]?.endedAt?.toISOString(), at(4).toISOString())
  assert.equal(rows.find((row) => row.source === 'device_error')?.gaps[0]?.endedAt, null)
  await recorder.observe(event(5, { hms: [] }))
  assert.equal(await db.printerFault.count({ where: { observedClearedAt: null } }), 1)
  await recorder.observe(event(6, { hms: [hms], device_error: [] }))
  assert.equal(await db.printerFault.count(), 3)
  assert.ok(changed.every((workspace) => workspace === 'w'))
  assert.equal((await db.printerFaultGap.count()), 2, 'reconciled gaps remain historical')
})

test('restart records uncertainty and same-code replay continues the old occurrence', fixture, async () => {
  const first = new PrinterFaultRecorder(db, () => {})
  await first.observe(event(0, { device_error: [device] }))
  const original = await db.printerFault.findFirstOrThrow()
  const second = new PrinterFaultRecorder(db, () => {})
  await second.recover()
  let history = await readStandaloneFaultHistory('w')
  assert.equal(history[0]?.fault.state, 'uncertain')
  await second.observe(event(3, { device_error: [device] }))
  assert.equal(await db.printerFault.count(), 1)
  history = await readStandaloneFaultHistory('w')
  assert.equal(history[0]?.fault.id, original.id)
  assert.equal(history[0]?.fault.state, 'active')
  assert.equal(history[0]?.fault.gaps[0]?.reason, 'restart')
  assert.equal(history[0]?.fault.gaps[0]?.startedAt, at(0).toISOString())
  await assert.rejects(deleteClearedPrinterFault('w', original.id), /Only cleared/)
})

test('one continuous occurrence spans preparation, pauses, two jobs and subsequent idle gaps', fixture, async () => {
  await persistFaultObservation(db, event(0, { hms: [hms] }))
  await job('a', 1)
  await linkRecordedJobFaults(db, 'w', 'p', 'a')
  await persistFaultObservation(db, { ...event(2, { hms: [hms] }), preparingJobId: 'a' })
  assert.equal(await db.printerFaultIdlePeriod.count({ where: { endedAt: null } }), 0, 'reservation is preparation before MQTT stage changes')
  await persistFaultObservation(db, event(3, { hms: [hms] }, 'paused', 'a'))
  await db.printJob.update({ where: { id: 'a' }, data: { finishedAt: at(4), result: 'success' } })
  await linkRecordedJobFaults(db, 'w', 'p', 'a')
  await persistFaultObservation(db, event(4, {}))
  await job('b', 5)
  await linkRecordedJobFaults(db, 'w', 'p', 'b')
  await persistFaultObservation(db, event(6, { hms: [hms] }, 'preparing', 'b'))
  await db.printJob.update({ where: { id: 'b' }, data: { finishedAt: at(7), result: 'cancelled' } })
  await linkRecordedJobFaults(db, 'w', 'p', 'b')
  await persistFaultObservation(db, event(7, {}))
  await persistFaultObservation(db, event(8, { hms: [] }))
  const links = await db.printJobFault.findMany()
  assert.equal(links.length, 2)
  assert.equal(new Set(links.map((link) => link.faultId)).size, 1)
  assert.ok(links.every((link) => link.alreadyPresent))
  const periods = await readStandaloneFaultHistory('w')
  assert.deepEqual(periods.map((period) => [period.startedAt, period.endedAt]), [[0, 1], [4, 5], [7, 8]].map(([start, end]) => [at(start!).toISOString(), at(end!).toISOString()]))
  assert.equal((await db.printJob.findUniqueOrThrow({ where: { id: 'b' } })).result, 'cancelled')
})

test('late external activation catches a fault already cleared, and job deletion leaves accessible history', fixture, async () => {
  await persistFaultObservation(db, event(1, { device_error: [device] }, 'printing', 'short'))
  await persistFaultObservation(db, event(2, { device_error: [] }, 'printing', 'short'))
  await job('short', 1)
  await db.printJob.update({ where: { id: 'short' }, data: { finishedAt: at(3) } })
  await linkRecordedJobFaults(db, 'w', 'p', 'short')
  const links = await readJobFaults('w', ['short'])
  assert.equal(links.get('short')?.length, 1)
  assert.equal(links.get('short')?.[0]?.alreadyPresent, false)
  assert.equal((await readStandaloneFaultHistory('w')).length, 0)
  await db.printJob.delete({ where: { id: 'short' } })
  const orphan = await readStandaloneFaultHistory('w')
  assert.equal(orphan.length, 1)
  assert.equal(orphan[0]?.fault.id, links.get('short')?.[0]?.id)
  await assert.rejects(deleteClearedPrinterFault('other', orphan[0]!.fault.id), /not found/)
  await deleteClearedPrinterFault('w', orphan[0]!.fault.id)
  assert.equal(await db.printerFault.count(), 0)
})

test('delayed reservation removes idle references that fall inside the observed job interval', fixture, async () => {
  await persistFaultObservation(db, event(2, { hms: [hms] }))
  await job('delayed', 1)
  await linkRecordedJobFaults(db, 'w', 'p', 'delayed')
  assert.equal((await readStandaloneFaultHistory('w')).length, 0)
  await db.printJob.update({ where: { id: 'delayed' }, data: { finishedAt: at(3) } })
  await linkRecordedJobFaults(db, 'w', 'p', 'delayed')
  await persistFaultObservation(db, event(4, { hms: [] }))
  const periods = await readStandaloneFaultHistory('w')
  assert.equal(periods[0]?.startedAt, at(3).toISOString())
})

test('partial uniqueness and composite foreign keys protect active identity and tenancy', fixture, async () => {
  await persistFaultObservation(db, event(0, { device_error: [device] }))
  const fault = await db.printerFault.findFirstOrThrow()
  await assert.rejects(db.printerFault.create({ data: { workspaceId: 'w', printerId: 'p', source: fault.source, code: fault.code, firstObservedAt: at(1), lastObservedAt: at(1) } }), /Unique constraint/)
  await assert.rejects(db.printerFault.create({ data: { workspaceId: 'other', printerId: 'p', source: fault.source, code: 'OTHER', firstObservedAt: at(1), lastObservedAt: at(1) } }), /Foreign key constraint/)
  await job('j', 1)
  await assert.rejects(db.printJobFault.create({ data: { workspaceId: 'other', jobId: 'j', faultId: fault.id, alreadyPresent: true } }), /Foreign key constraint/)
  await persistFaultObservation(db, event(2, { device_error: [] }))
  await deleteClearedPrinterFault('w', fault.id)
  assert.equal(await db.printerFaultIdlePeriod.count(), 0)
})

test('cancellation codes create no fault and unknown HMS cannot falsely clear a recorded code', fixture, async () => {
  await persistFaultObservation(db, event(0, { hms: [{ code: 'unknown', message: null }], device_error: [{ code: '0300400C', message: 'Cancelled' }] }))
  assert.equal(await db.printerFault.count(), 0)
  await persistFaultObservation(db, event(1, { hms: [hms] }))
  await persistFaultObservation(db, event(2, { hms: [{ ...hms, message: null }] }))
  assert.equal(await db.printerFault.count({ where: { observedClearedAt: null } }), 1)
})


test('late activation and finalization reveal a cleared post-job idle reference without losing evidence', fixture, async () => {
  await persistFaultObservation(db, event(0, { hms: [hms] }))
  await persistFaultObservation(db, event(1, {}, 'printing', 'late'))
  await persistFaultObservation(db, event(4, {}))
  await persistFaultObservation(db, event(5, { hms: [] }))
  await job('late', 1)
  await linkRecordedJobFaults(db, 'w', 'p', 'late')
  assert.equal((await readStandaloneFaultHistory('w')).length, 1, 'open job coverage temporarily hides the later idle reference')
  await db.printJob.update({ where: { id: 'late' }, data: { finishedAt: at(3) } })
  await linkRecordedJobFaults(db, 'w', 'p', 'late')
  const periods = await readStandaloneFaultHistory('w')
  assert.deepEqual(periods.map((period) => [period.startedAt, period.endedAt]), [[at(0).toISOString(), at(1).toISOString()], [at(4).toISOString(), at(5).toISOString()]])
  await db.printJob.delete({ where: { id: 'late' } })
  assert.deepEqual((await readStandaloneFaultHistory('w')).map((period) => [period.startedAt, period.endedAt]), periods.map((period) => [period.startedAt, period.endedAt]), 'job deletion retains coverage boundaries')
})


test('terminal observation outranks still-pending tracked activation until a fresh reservation', fixture, async () => {
  const recorder = new PrinterFaultRecorder(db, () => {})
  await recorder.observe(event(0, { hms: [hms] }))
  await job('tracked', 1)
  registerPendingPrintJobSource('p', {
    jobId: 'tracked', taskId: 'tracked', jobKind: 'file', fileId: null, fileName: 'fixture.gcode',
    fileSizeBytes: null, sourceKind: 'gcode', plate: 1, useAms: null, bedLevel: null, amsMapping: null, calibrationOption: null
  })
  await recorder.observe(event(2, {}, 'preparing', 'tracked'))
  await recorder.observe({ ...event(3, {}, 'finished', 'tracked'), jobEnded: true })
  await recorder.observe(event(4, {}, 'finished', 'tracked'))
  await recorder.observe(event(5, { hms: [] }, 'finished', 'tracked'))
  const idle = await db.printerFaultIdlePeriod.findMany({ orderBy: { startedAt: 'asc' } })
  assert.equal(idle.at(-1)?.startedAt.toISOString(), at(3).toISOString())
  assert.equal(idle.at(-1)?.endedAt?.toISOString(), at(5).toISOString())
})

test('failed collection retries in order, logs failure and never rejects a dispatch caller', fixture, async () => {
  const errors: unknown[] = []
  mock.method(console, 'error', (...args: unknown[]) => errors.push(args))
  const recorder = new PrinterFaultRecorder(db, () => {})
  await recorder.recover()
  stub(db, '$transaction', async () => { throw new Error('fixture storage unavailable') })
  await assert.doesNotReject(recorder.linkJob('w', 'p', 'missing'))
  assert.equal(errors.length, 3)
})
