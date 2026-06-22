import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getPrinterRecoveryActions,
  isPausedFilamentRunout,
  printerStatusSchema,
  TEST_FLEET_SEEDS,
  type Printer,
  type TestFleetSeed
} from '@printstream/shared'
import { buildTestFleetStatus } from './test-fleet-states.js'

function printerFromSeed(seed: TestFleetSeed): Printer {
  return {
    id: `printer-${seed.serial}`,
    name: seed.name,
    host: seed.host,
    serial: seed.serial,
    accessCode: seed.accessCode,
    model: seed.model,
    currentPlateType: seed.currentPlateType,
    currentNozzleDiameters: seed.currentNozzleDiameters,
    bridgeId: 'test-fleet-bridge',
    position: seed.position,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

const statusByScenario = new Map(
  TEST_FLEET_SEEDS.map((seed) => [seed.scenario, buildTestFleetStatus(printerFromSeed(seed), null)] as const)
)

test('every roster scenario builds a schema-valid status', () => {
  for (const seed of TEST_FLEET_SEEDS) {
    const status = buildTestFleetStatus(printerFromSeed(seed), null)
    // stamp() already parses, but assert explicitly so a regression is obvious.
    assert.doesNotThrow(() => printerStatusSchema.parse(status), `scenario ${seed.scenario} produced an invalid status`)
  }
  assert.equal(statusByScenario.size, new Set(TEST_FLEET_SEEDS.map((s) => s.scenario)).size)
})

test('only the offline scenario is offline; everything else is online', () => {
  for (const [scenario, status] of statusByScenario) {
    assert.equal(status.online, scenario !== 'offline', `scenario ${scenario} online mismatch`)
  }
})

test('paused-runout drives the filament-runout recovery (Load filament)', () => {
  const status = statusByScenario.get('paused-runout')!
  assert.equal(status.stage, 'paused')
  assert.equal(isPausedFilamentRunout(status), true)
  assert.ok(getPrinterRecoveryActions(status).some((action) => action.id === 'loadFilament'))
})

test('check-assistant exposes the Check assistant recovery action', () => {
  const status = statusByScenario.get('check-assistant')!
  assert.ok(getPrinterRecoveryActions(status).some((action) => action.id === 'checkAssistant'))
})

test('stage scenarios pin the expected stage', () => {
  assert.equal(statusByScenario.get('printing-early')!.stage, 'printing')
  assert.equal(statusByScenario.get('heating')!.stage, 'heating')
  assert.equal(statusByScenario.get('preparing')!.stage, 'preparing')
  assert.equal(statusByScenario.get('finished')!.stage, 'finished')
  assert.equal(statusByScenario.get('failed')!.stage, 'failed')
  assert.notEqual(statusByScenario.get('failed')!.deviceError, null)
})

test('attention/connection/AMS scenarios carry their distinguishing state', () => {
  assert.equal(statusByScenario.get('hms-multi')!.hmsErrors.length, 2)
  assert.equal(statusByScenario.get('lan-mode')!.connectionWarnings.length, 1)
  assert.equal(statusByScenario.get('external-spool')!.ams.length, 0)
  assert.ok(statusByScenario.get('ams-drying')!.ams.some((unit) => unit.dryingActive))
  assert.ok(statusByScenario.get('ams-dual-units')!.ams.length >= 2)
})

test('live printers advance their layer on the next tick', () => {
  const seed = TEST_FLEET_SEEDS.find((entry) => entry.live)!
  const first = buildTestFleetStatus(printerFromSeed(seed), null)
  const second = buildTestFleetStatus(printerFromSeed(seed), first)
  assert.equal(first.stage, 'printing')
  assert.ok((second.currentLayer ?? 0) >= (first.currentLayer ?? 0))
})
