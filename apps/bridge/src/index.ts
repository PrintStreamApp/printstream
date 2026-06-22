import { BridgeRuntimeClient } from './runtime.js'

// Log otherwise-silent fatal faults and exit for a clean restart, so a bridge
// crash is diagnosable instead of the process vanishing with only Node's default
// output — the standalone build redirects stdout to an on-disk file the operator
// can't easily reach. (Kept inline rather than importing the API helper: the
// bridge is a separately-deployed workspace.)
process.on('uncaughtException', (error) => {
  console.error('[fatal] Uncaught exception in bridge runtime; exiting for a clean restart', error)
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] Unhandled promise rejection in bridge runtime; exiting for a clean restart', reason)
  process.exit(1)
})

const runtime = new BridgeRuntimeClient()

runtime.start().catch((error) => {
  console.error('Bridge runtime exited unexpectedly', error)
  process.exit(1)
})
