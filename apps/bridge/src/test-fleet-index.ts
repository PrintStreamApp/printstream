/**
 * Test-fleet bridge entry: a simulator bridge that drives the dev-only test
 * fleet — each printer pinned to one card state (see test-fleet-states.ts) so the
 * whole UI matrix renders at once. Separate from the public demo (demo-index.ts);
 * authenticates as the test-fleet bridge via its own BRIDGE_STATE_FILE.
 */
import { DemoBridgeSimulator } from './demo-simulator.js'
import { env } from './env.js'
import { BridgeRuntimeClient } from './runtime.js'
import { buildTestFleetStatus } from './test-fleet-states.js'

const runtime = new BridgeRuntimeClient({
  simulator: new DemoBridgeSimulator({
    statusIntervalMs: env.BRIDGE_SIMULATOR_STATUS_INTERVAL_MS,
    statusProvider: buildTestFleetStatus
  })
})

runtime.start().catch((error) => {
  console.error('Test-fleet bridge runtime exited unexpectedly', error)
  process.exit(1)
})
