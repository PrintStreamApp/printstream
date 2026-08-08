/**
 * Standalone entry: the slicer as its own process (what the container runs).
 *
 * Thin on purpose. Everything is in `index.ts`, which exports
 * {@link startSlicerServer} so the native self-hosted app can host the same
 * server in-process instead of running a sidecar. This file is only the
 * "be a service" half — bind the configured port and die loudly if it fails.
 */
import { startSlicerServer } from './index.js'

startSlicerServer().catch((error: unknown) => {
  console.error('[slicer] failed to start:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
