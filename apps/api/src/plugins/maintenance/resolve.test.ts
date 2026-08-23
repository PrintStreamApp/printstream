import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolvePrinterTasks } from './resolve.js'
import { nextClearedIntervals, type MaintenanceLogRow, type MaintenanceTaskRow } from './store.js'
import type { PrinterUsageCounters } from './usage.js'

const NOW = new Date('2026-08-12T12:00:00.000Z')
const SERIAL = 'AC12345678'
const USAGE: PrinterUsageCounters = { printHours: 500, filamentKilograms: 40 }

function taskRow(overrides: Partial<MaintenanceTaskRow> = {}): MaintenanceTaskRow {
  return {
    id: 'row-1',
    printerSerial: SERIAL,
    taskKey: 'z-lead-screw',
    customTitle: null,
    customLubricant: null,
    intervalDays: null,
    intervalPrintHours: null,
    intervalFilamentKilograms: null,
    intervalsCleared: [],
    disabledAt: null,
    ...overrides
  }
}

function completion(overrides: Partial<MaintenanceLogRow> = {}): MaintenanceLogRow {
  return {
    id: 'log-1',
    printerSerial: SERIAL,
    taskKey: 'z-lead-screw',
    completedAt: new Date('2026-08-01T12:00:00.000Z'),
    printHours: 400,
    filamentKilograms: 30,
    note: null,
    performedByUserId: null,
    ...overrides
  }
}

function resolve(input: {
  model?: string
  overrides?: MaintenanceTaskRow[]
  completions?: Map<string, MaintenanceLogRow>
  usage?: PrinterUsageCounters
  hms?: string[]
}) {
  return resolvePrinterTasks({
    printerModel: input.model ?? 'X1C',
    overrides: input.overrides ?? [],
    completions: input.completions ?? new Map(),
    usage: input.usage ?? USAGE,
    activeHmsCodes: input.hms ?? [],
    now: NOW
  })
}

function findTask(input: Parameters<typeof resolve>[0], key: string) {
  const task = resolve(input).tasks.find((entry) => entry.key === key)
  assert.ok(task, `no task ${key}`)
  return task
}

test('an untouched printer gets the catalog schedule with no rows stored', () => {
  const { schedule, tasks } = resolve({ model: 'X1C' })
  assert.equal(schedule.id, 'x1')
  assert.ok(tasks.length > 0)
  const leadScrew = tasks.find((task) => task.key === 'z-lead-screw')
  assert.equal(leadScrew?.intervals.days, 90)
  assert.equal(leadScrew?.customized, false)
  assert.equal(leadScrew?.source, 'catalog')
})

test('an override interval replaces the catalog one and marks the task customized', () => {
  const task = findTask({ overrides: [taskRow({ intervalDays: 30 })] }, 'z-lead-screw')
  assert.equal(task.intervals.days, 30)
  assert.equal(task.catalogIntervals.days, 90)
  assert.equal(task.customized, true)
})

test('a cleared interval stays off instead of re-inheriting the catalog value', () => {
  // The subtle one: the column is null AND the catalog has 90, so only the
  // cleared list can say the user turned it off.
  const task = findTask({ overrides: [taskRow({ intervalDays: null, intervalsCleared: ['days'] })] }, 'z-lead-screw')
  assert.equal(task.intervals.days, null)
  assert.equal(task.catalogIntervals.days, 90)
  assert.equal(task.customized, true)
  assert.equal(task.triggers.length, 0)
})

test('a row that changes nothing about intervals is not reported as customized', () => {
  // Disabling a task writes a row, but the intervals still match the catalog.
  const task = findTask({ overrides: [taskRow({ disabledAt: new Date() })] }, 'z-lead-screw')
  assert.equal(task.customized, false)
  assert.equal(task.disabled, true)
  assert.equal(task.status, 'disabled')
})

test('due status comes from the last completion and the live usage', () => {
  const completions = new Map([['z-lead-screw', completion({ completedAt: new Date('2026-01-01T12:00:00.000Z') })]])
  const task = findTask({ completions }, 'z-lead-screw')
  assert.equal(task.status, 'due')
  assert.ok(task.lastCompletedAt)
  assert.equal(task.dueAt, new Date('2026-04-01T12:00:00.000Z').toISOString())
})

test('a filament-driven task measures kilograms since the completion, not lifetime', () => {
  // 30 kg at completion, 40 kg now = 10 kg elapsed against the X1 cutter's 3 kg.
  const completions = new Map([['filament-cutter', completion({ taskKey: 'filament-cutter', filamentKilograms: 30 })]])
  const task = findTask({ completions }, 'filament-cutter')
  const trigger = task.triggers.find((entry) => entry.kind === 'filamentKilograms')
  assert.equal(trigger?.elapsed, 10)
  assert.equal(task.status, 'due')
})

test('an HMS code the printer is reporting makes the matching task due', () => {
  const completions = new Map([['z-axis', completion({ taskKey: 'z-axis', completedAt: new Date('2026-08-11T12:00:00.000Z') })]])
  const fresh = findTask({ model: 'H2D', completions }, 'z-axis')
  assert.equal(fresh.status, 'ok')

  const asked = findTask({ model: 'H2D', completions, hms: ['0501040000030002'] }, 'z-axis')
  assert.equal(asked.status, 'due')
  assert.equal(asked.printerRequested, true)
})

test('custom tasks are listed alongside catalog ones with no catalog defaults', () => {
  const custom = taskRow({
    taskKey: 'custom:abc',
    customTitle: 'Clean the chamber fan',
    customLubricant: 'oil',
    intervalDays: 60
  })
  const { tasks } = resolve({ overrides: [custom] })
  const task = tasks.find((entry) => entry.key === 'custom:abc')
  assert.ok(task)
  assert.equal(task.source, 'custom')
  assert.equal(task.title, 'Clean the chamber fan')
  assert.equal(task.lubricant, 'oil')
  assert.equal(task.intervals.days, 60)
  // Nothing to reset to, so the UI must not offer a reset.
  assert.deepEqual(task.catalogIntervals, { days: null, printHours: null, filamentKilograms: null })
  assert.equal(task.customized, false)
})

test('a custom task row does not also appear as a catalog task', () => {
  const { tasks } = resolve({ overrides: [taskRow({ taskKey: 'custom:abc', customTitle: 'Thing' })] })
  assert.equal(tasks.filter((task) => task.key === 'custom:abc').length, 1)
})

test('an unknown printer model resolves the generic schedule', () => {
  const { schedule, tasks } = resolve({ model: 'Some 2028 Printer' })
  assert.equal(schedule.generic, true)
  assert.ok(tasks.some((task) => task.key === 'z-lead-screw'))
})

test('clearing an interval records it; setting one removes the record', () => {
  assert.deepEqual(nextClearedIntervals([], { intervalDays: null }), ['days'])
  assert.deepEqual(nextClearedIntervals(['days'], { intervalDays: 30 }), [])
  // An absent field leaves the list untouched, a patch that only flips `disabled`
  // must not resurrect an interval the user cleared earlier.
  assert.deepEqual(nextClearedIntervals(['days'], {}), ['days'])
  assert.deepEqual(
    nextClearedIntervals([], { intervalDays: null, intervalPrintHours: null, intervalFilamentKilograms: null }).sort(),
    ['days', 'filamentKilograms', 'printHours']
  )
})
