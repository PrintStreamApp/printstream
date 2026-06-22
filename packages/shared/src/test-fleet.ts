/**
 * Test fleet roster: a dev-only fleet of synthetic printers, each pinned to one
 * printer-card state so the whole UI matrix can be exercised at once without
 * hardware. Separate from the public demo (its own tenant + bridge). The bridge
 * simulator builds each printer's status from its `scenario` tag
 * (see apps/bridge/src/test-fleet-states.ts); the API bootstrap seeds the DB rows.
 */
import type { Printer } from './printer-contracts.js'
import type { PrinterNozzleDiameterSelection } from './print-compatibility.js'

export const TEST_FLEET_TENANT_SLUG = 'test'
export const TEST_FLEET_TENANT_NAME = 'PrintStream Test Fleet'
export const TEST_FLEET_BRIDGE_ID = 'test-fleet-bridge'
export const TEST_FLEET_BRIDGE_NAME = 'PrintStream Test Fleet Bridge'

/** Every distinct card state the fleet covers. One printer per scenario. */
export type TestFleetScenario =
  | 'idle'
  | 'heating'
  | 'preparing'
  | 'printing-early'
  | 'printing-mid'
  | 'printing-near-done'
  | 'printing-dual-nozzle'
  | 'paused-manual'
  | 'paused-runout'
  | 'paused-device-error'
  | 'finished'
  | 'failed'
  | 'hms-single'
  | 'hms-multi'
  | 'check-assistant'
  | 'skip-object'
  | 'offline'
  | 'lan-mode'
  | 'external-spool'
  | 'ams-mixed-slots'
  | 'ams-dual-units'
  | 'ams-drying'
  | 'a1-work-light'
  | 'chamber-duct'

export interface TestFleetSeed {
  name: string
  host: string
  serial: string
  accessCode: string
  model: Printer['model']
  currentPlateType: string | null
  currentNozzleDiameters: PrinterNozzleDiameterSelection[]
  position: number
  scenario: TestFleetScenario
  /** When true the simulator advances this printer's progress every tick. */
  live?: boolean
}

const SINGLE_NOZZLE: PrinterNozzleDiameterSelection[] = [{ extruderId: 0, diameter: '0.4' }]
const DUAL_NOZZLE: PrinterNozzleDiameterSelection[] = [
  { extruderId: 0, diameter: '0.4' },
  { extruderId: 1, diameter: '0.4' }
]

let nextPosition = 0
function seed(
  scenario: TestFleetScenario,
  name: string,
  model: Printer['model'],
  overrides: Partial<Omit<TestFleetSeed, 'scenario' | 'name' | 'model' | 'position'>> = {}
): TestFleetSeed {
  const position = nextPosition++
  const dual = model === 'H2D' || model === 'H2DPRO' || model === 'H2C' || model === 'X2D'
  return {
    scenario,
    name,
    model,
    host: `test-${scenario}.local`,
    serial: `TEST-${String(position + 1).padStart(3, '0')}-${scenario.toUpperCase()}`,
    accessCode: 'TEST-FLEET',
    currentPlateType: 'Textured PEI Plate',
    currentNozzleDiameters: dual ? DUAL_NOZZLE : SINGLE_NOZZLE,
    position,
    ...overrides
  }
}

/** The roster — order here is the on-screen order. */
export const TEST_FLEET_SEEDS: TestFleetSeed[] = [
  seed('idle', 'Idle', 'P1S'),
  seed('heating', 'Heating', 'X1C'),
  seed('preparing', 'Preparing', 'P1S'),
  seed('printing-early', 'Printing — early', 'X1C', { live: true }),
  seed('printing-mid', 'Printing — mid', 'P1S', { live: true }),
  seed('printing-near-done', 'Printing — near done', 'P1S'),
  seed('printing-dual-nozzle', 'Printing — dual nozzle', 'H2D'),
  seed('skip-object', 'Printing — skip object', 'X1C'),
  seed('paused-manual', 'Paused — manual', 'X1C'),
  seed('paused-runout', 'Paused — filament runout', 'P1S'),
  seed('paused-device-error', 'Paused — device error', 'H2D'),
  seed('finished', 'Finished', 'P1S'),
  seed('failed', 'Failed', 'X1C'),
  seed('hms-single', 'HMS — single', 'P1S'),
  seed('hms-multi', 'HMS — multiple', 'X1C'),
  seed('check-assistant', 'Needs attention — check assistant', 'H2D'),
  seed('offline', 'Offline', 'P1S'),
  seed('lan-mode', 'LAN mode', 'X1C'),
  seed('external-spool', 'External spool', 'P1S'),
  seed('ams-mixed-slots', 'AMS — mixed slots', 'X1C'),
  seed('ams-dual-units', 'AMS — dual units', 'P1S'),
  seed('ams-drying', 'AMS — drying', 'X1C'),
  seed('chamber-duct', 'Chamber + duct', 'H2D'),
  seed('a1-work-light', 'A1 — work light', 'A1')
]

const SCENARIO_BY_SERIAL = new Map(TEST_FLEET_SEEDS.map((entry) => [entry.serial, entry]))

/** Look up a roster entry by serial (the bridge maps a configured printer back to its scenario). */
export function getTestFleetSeed(serial: string): TestFleetSeed | undefined {
  return SCENARIO_BY_SERIAL.get(serial)
}
