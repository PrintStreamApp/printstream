import { BridgeRuntimeClient } from './runtime.js'

const runtime = new BridgeRuntimeClient()

runtime.start().catch((error) => {
  console.error('Bridge runtime exited unexpectedly', error)
  process.exit(1)
})