import { DemoBridgeSimulator } from './demo-simulator.js'
import { env } from './env.js'
import { BridgeRuntimeClient } from './runtime.js'

const runtime = new BridgeRuntimeClient({
  simulator: new DemoBridgeSimulator({ statusIntervalMs: env.BRIDGE_SIMULATOR_STATUS_INTERVAL_MS })
})

runtime.start().catch((error) => {
  console.error('Demo bridge runtime exited unexpectedly', error)
  process.exit(1)
})