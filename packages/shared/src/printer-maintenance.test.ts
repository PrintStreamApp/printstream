import assert from 'node:assert/strict'
import { test } from 'node:test'
import { KNOWN_BAMBU_PRINTER_MODEL_KEYS } from './bambu-model-keys.js'
import {
  GENERIC_MAINTENANCE_SCHEDULE,
  MODEL_MAINTENANCE_SCHEDULE_IDS,
  PRINTER_MAINTENANCE_SCHEDULES,
  evaluateMaintenanceTask,
  isMaintenanceAttentionStatus,
  resolveMaintenanceSchedule,
  unclassifiedMaintenanceModelKeys,
  type MaintenanceCompletion,
  type MaintenanceUsage
} from './printer-maintenance.js'

const NOW = new Date('2026-08-12T12:00:00.000Z')

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000)
}

function completion(overrides: Partial<MaintenanceCompletion> = {}): MaintenanceCompletion {
  return { completedAt: daysAgo(10), printHours: 100, filamentKilograms: 5, ...overrides }
}

const USAGE: MaintenanceUsage = { printHours: 120, filamentKilograms: 6 }

// This is the guard that keeps adding a printer model cheap: a key added to
// bambu-model-keys.ts with no schedule fails here rather than silently shipping
// a printer whose maintenance list is the generic stand-in.
test('every known Bambu model key maps to a maintenance schedule', () => {
  assert.deepEqual(unclassifiedMaintenanceModelKeys(), [])
  for (const key of KNOWN_BAMBU_PRINTER_MODEL_KEYS) {
    const scheduleId = MODEL_MAINTENANCE_SCHEDULE_IDS[key]
    assert.ok(scheduleId, `${key} has no maintenance schedule`)
    assert.ok(PRINTER_MAINTENANCE_SCHEDULES[scheduleId], `${key} maps to unknown schedule ${scheduleId}`)
  }
})

test('schedules carry a source URL and non-empty, uniquely keyed tasks', () => {
  for (const schedule of Object.values(PRINTER_MAINTENANCE_SCHEDULES)) {
    assert.ok(schedule.wikiUrl.startsWith('https://wiki.bambulab.com/'), `${schedule.id} has no Bambu source`)
    assert.ok(schedule.tasks.length > 0, `${schedule.id} has no tasks`)
    const keys = schedule.tasks.map((task) => task.key)
    assert.equal(new Set(keys).size, keys.length, `${schedule.id} has duplicate task keys`)
    for (const task of schedule.tasks) {
      const hasInterval = task.intervalDays != null || task.intervalPrintHours != null || task.intervalFilamentKilograms != null
      assert.ok(hasInterval || (task.hmsCodes?.length ?? 0) > 0, `${schedule.id}/${task.key} has no trigger at all`)
    }
  }
})

test('resolves schedules from model names, aliases, and device codes', () => {
  assert.equal(resolveMaintenanceSchedule('Bambu Lab X1 Carbon').id, 'x1')
  assert.equal(resolveMaintenanceSchedule('P1S').id, 'p1')
  assert.equal(resolveMaintenanceSchedule('A1 mini').id, 'a1')
  assert.equal(resolveMaintenanceSchedule('X2D').id, 'p2s')
  assert.equal(resolveMaintenanceSchedule('H2D Pro').id, 'h2d')
})

test('H2 models keep their own schedules rather than sharing one family', () => {
  // H2D services Y and Z monthly where H2C/H2S service them quarterly. They are
  // one family for slicing and three schedules for maintenance.
  const yInterval = (id: string) =>
    PRINTER_MAINTENANCE_SCHEDULES[id].tasks.find((task) => task.key === 'y-axis')?.intervalDays
  assert.equal(yInterval('h2d'), 30)
  assert.equal(yInterval('h2c'), 90)
  assert.equal(yInterval('h2s'), 90)
})

test('X1 and P1 carbon rods are marked as taking no lubricant', () => {
  // Greasing a carbon rod damages it; the catalog has to say so, not stay silent.
  for (const id of ['x1', 'p1']) {
    const task = PRINTER_MAINTENANCE_SCHEDULES[id].tasks.find((entry) => entry.key === 'x-axis')
    assert.equal(task?.lubricant, 'none')
  }
  // The A1 X rail is the opposite case: oil, and grease is prohibited.
  assert.equal(PRINTER_MAINTENANCE_SCHEDULES.a1.tasks.find((task) => task.key === 'x-axis')?.lubricant, 'oil')
})

test('an unrecognized model falls back to the generic schedule, flagged as generic', () => {
  const schedule = resolveMaintenanceSchedule('Some Printer From 2027')
  assert.equal(schedule.id, GENERIC_MAINTENANCE_SCHEDULE.id)
  assert.equal(schedule.generic, true)
  assert.equal(resolveMaintenanceSchedule(null).id, 'generic')
  assert.equal(resolveMaintenanceSchedule(undefined).id, 'generic')
})

test('a task that has never been logged is not-logged, not due', () => {
  const result = evaluateMaintenanceTask({
    definition: { intervalDays: 90 },
    completion: null,
    usage: USAGE,
    now: NOW
  })
  assert.equal(result.status, 'not-logged')
  assert.equal(result.progress, null)
  assert.equal(result.dueAt, null)
})

test('a calendar task comes due when its interval elapses', () => {
  const fresh = evaluateMaintenanceTask({
    definition: { intervalDays: 90 },
    completion: completion({ completedAt: daysAgo(10) }),
    usage: USAGE,
    now: NOW
  })
  assert.equal(fresh.status, 'ok')
  assert.equal(fresh.dueAt?.toISOString(), new Date(daysAgo(10).getTime() + 90 * 24 * 60 * 60 * 1000).toISOString())

  assert.equal(evaluateMaintenanceTask({
    definition: { intervalDays: 90 },
    completion: completion({ completedAt: daysAgo(85) }),
    usage: USAGE,
    now: NOW
  }).status, 'due-soon')

  const overdue = evaluateMaintenanceTask({
    definition: { intervalDays: 90 },
    completion: completion({ completedAt: daysAgo(135) }),
    usage: USAGE,
    now: NOW
  })
  assert.equal(overdue.status, 'due')
  assert.equal(overdue.progress, 1.5)
})

test('whichever interval elapses first wins', () => {
  // 5 days into a 90-day interval, but 20 print hours into a 20-hour one.
  const result = evaluateMaintenanceTask({
    definition: { intervalDays: 90, intervalPrintHours: 20 },
    completion: completion({ completedAt: daysAgo(5), printHours: 100 }),
    usage: { printHours: 120, filamentKilograms: 6 },
    now: NOW
  })
  assert.equal(result.status, 'due')
  assert.equal(result.leadingTrigger?.kind, 'printHours')
  // The calendar due date is still reported so the UI can show a date.
  assert.ok(result.dueAt)
})

test('filament kilograms drive the roll-count consumable tasks', () => {
  const result = evaluateMaintenanceTask({
    definition: { intervalFilamentKilograms: 3 },
    completion: completion({ filamentKilograms: 5 }),
    usage: { printHours: 120, filamentKilograms: 8.5 },
    now: NOW
  })
  assert.equal(result.status, 'due')
  assert.equal(result.leadingTrigger?.kind, 'filamentKilograms')
  assert.equal(result.leadingTrigger?.elapsed, 3.5)
})

test('a trigger whose metric is untracked goes inert instead of reading as fresh', () => {
  // No print recorded filament use, so PrinterStats reports null kilograms. The
  // task must not look like it has 0 of 3 kg elapsed.
  const result = evaluateMaintenanceTask({
    definition: { intervalFilamentKilograms: 3 },
    completion: completion({ filamentKilograms: null }),
    usage: { printHours: 120, filamentKilograms: null },
    now: NOW
  })
  assert.equal(result.triggers.length, 1)
  assert.equal(result.triggers[0].unavailable, true)
  assert.equal(result.progress, null)
  assert.equal(result.status, 'ok')
})

test('an active HMS code makes the task due regardless of its interval', () => {
  const result = evaluateMaintenanceTask({
    definition: { intervalDays: 90, hmsCodes: ['0501040000030002'] },
    completion: completion({ completedAt: daysAgo(1) }),
    usage: USAGE,
    activeHmsCodes: ['0501040000030002'],
    now: NOW
  })
  assert.equal(result.status, 'due')
  assert.equal(result.printerRequested, true)
})

test('an HMS code makes a never-logged task due', () => {
  const result = evaluateMaintenanceTask({
    definition: { intervalDays: 90, hmsCodes: ['0501040000030002'] },
    completion: null,
    usage: USAGE,
    activeHmsCodes: ['0501040000030002'],
    now: NOW
  })
  assert.equal(result.status, 'due')
})

test('an unrelated HMS code does not make a task due', () => {
  const result = evaluateMaintenanceTask({
    definition: { intervalDays: 90, hmsCodes: ['0501040000030002'] },
    completion: completion({ completedAt: daysAgo(1) }),
    usage: USAGE,
    activeHmsCodes: ['0300010000010002'],
    now: NOW
  })
  assert.equal(result.status, 'ok')
  assert.equal(result.printerRequested, false)
})

test('overrides replace catalog intervals and null clears one', () => {
  const shortened = evaluateMaintenanceTask({
    definition: { intervalDays: 90 },
    override: { intervalDays: 30 },
    completion: completion({ completedAt: daysAgo(45) }),
    usage: USAGE,
    now: NOW
  })
  assert.equal(shortened.status, 'due')

  const cleared = evaluateMaintenanceTask({
    definition: { intervalDays: 90 },
    override: { intervalDays: null },
    completion: completion({ completedAt: daysAgo(400) }),
    usage: USAGE,
    now: NOW
  })
  assert.equal(cleared.triggers.length, 0)
  assert.equal(cleared.status, 'ok')
})

test('a disabled task reports disabled and never nags', () => {
  const result = evaluateMaintenanceTask({
    definition: { intervalDays: 90, hmsCodes: ['0501040000030002'] },
    override: { disabled: true },
    completion: completion({ completedAt: daysAgo(400) }),
    usage: USAGE,
    activeHmsCodes: ['0501040000030002'],
    now: NOW
  })
  assert.equal(result.status, 'disabled')
  assert.equal(result.triggers.length, 0)
  assert.equal(isMaintenanceAttentionStatus(result.status), false)
})

test('only due and due-soon draw attention', () => {
  assert.equal(isMaintenanceAttentionStatus('due'), true)
  assert.equal(isMaintenanceAttentionStatus('due-soon'), true)
  assert.equal(isMaintenanceAttentionStatus('ok'), false)
  assert.equal(isMaintenanceAttentionStatus('not-logged'), false)
  assert.equal(isMaintenanceAttentionStatus('disabled'), false)
})
