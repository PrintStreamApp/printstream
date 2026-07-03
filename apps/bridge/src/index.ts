import { BridgeRuntimeClient } from './runtime.js'

// Fatal-fault handling (log + record the crash for reporting, then exit for a
// clean restart) is installed by BridgeRuntimeClient.start() so the Docker and
// standalone packagings share one implementation — see crash-tracker.ts. Keeping
// it there (rather than inline here) also lets the handler record the crash
// reason into the run-state marker so the next run can report it to the cloud.
const runtime = new BridgeRuntimeClient()

runtime.start().catch((error) => {
  console.error('Bridge runtime exited unexpectedly', error)
  process.exit(1)
})
