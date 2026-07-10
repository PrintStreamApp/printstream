import { env } from './env.js'
import { BridgeRuntimeClient } from './runtime.js'
import { createDockerBundleUpdateDriver } from './update-driver-docker-bundle.js'

// Fatal-fault handling (log + record the crash for reporting, then exit for a
// clean restart) is installed by BridgeRuntimeClient.start() so the Docker and
// standalone packagings share one implementation — see crash-tracker.ts. Keeping
// it there (rather than inline here) also lets the handler record the crash
// reason into the run-state marker so the next run can report it to the cloud.
//
// Driver selection: the slim bridge image bakes BRIDGE_BUNDLE_SELF_UPDATE and
// runs under the launcher, so it can activate signed app bundles in place;
// everywhere else (combined image's bridge role, source runs) the default
// report-only image-pull driver applies. BRIDGE_DISABLE_SELF_UPDATE pins a
// bundle-capable bridge to its current build (parity with the SEA packaging).
const runtime = new BridgeRuntimeClient(
  env.BRIDGE_BUNDLE_SELF_UPDATE && !env.BRIDGE_DISABLE_SELF_UPDATE
    ? { updateDriver: createDockerBundleUpdateDriver() }
    : {}
)

runtime.start().catch((error) => {
  console.error('Bridge runtime exited unexpectedly', error)
  process.exit(1)
})
