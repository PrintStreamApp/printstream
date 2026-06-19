/**
 * The `run` command: boot the whole self-hosted stack in one process on one port.
 *
 * Almost all the heavy lifting already lives in `@printstream/api/server`, which
 * (with `EMBEDDED_POSTGRES` enabled) starts an embedded Postgres cluster, applies
 * migrations CLI-free, and serves the SPA + `/api` + `/ws` on a single port. This
 * command's job is to point that boot at the server's per-OS data dir and config
 * before importing it — so it must set every env var first and only then pull in
 * the API (which captures its environment at load time).
 */
import { rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolveServerPaths } from './app-identity.js'
import { applyConfigFile, applyServerEnvDefaults, ensureServerDirs, resolvePort } from './config.js'
import { ensureProvisionToken, isManagedBridgeEnabled, startInBoxBridge } from './in-box-bridge.js'
import { prepareSeaRuntime } from './sea-assets.js'
import { writeRunningStatus } from './status.js'

/**
 * Fail fast with a clear message when the serving port is already taken. The API binds
 * the port in-process via a dynamic import whose `listen` error is emitted asynchronously
 * (not a rejected promise), so without this it surfaces as an uncaught crash — an ugly
 * stack trace on the CLI and *nothing at all* in the tray/GUI. Checking up front turns
 * that into a friendly error the CLI/tray error paths can show, before the heavy embedded
 * Postgres boot and before a "running" status file is written.
 */
export async function assertPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tester = createServer()
    tester.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(
          `Port ${port} is already in use — another PrintStream instance or another app is using it. ` +
          'Stop it, or set a different PORT in the server config, then try again.'
        ))
        return
      }
      reject(error)
    })
    tester.once('listening', () => tester.close(() => resolve()))
    tester.listen(port)
  })
}

export async function runServer(): Promise<void> {
  const paths = resolveServerPaths()
  ensureServerDirs(paths)

  // Packaged builds: extract the embedded Prisma client + web bundle and wire up
  // module resolution before anything loads the API (and thus Prisma). No-op in dev.
  await prepareSeaRuntime(paths)

  await applyConfigFile(paths)
  applyServerEnvDefaults(paths)

  // Pre-create the managed-bridge token before the API or bridge reads it, so
  // both agree on the secret without a startup race.
  if (isManagedBridgeEnabled()) {
    ensureProvisionToken(process.env.MANAGED_BRIDGE_TOKEN_FILE as string)
  }

  const port = resolvePort()
  // Refuse to boot onto a taken port (clear message instead of a silent/ugly crash).
  await assertPortAvailable(port)
  writeRunningStatus(paths, port)
  // Clear the status file on clean exit so `status` cannot report a recycled PID
  // as still running. A hard kill leaves a stale file (reclaimed on next start),
  // the same trade-off the bridge's status file makes.
  process.on('exit', () => {
    try {
      rmSync(paths.statusFile, { force: true })
    } catch {
      // Best-effort.
    }
  })
  console.log(`Starting PrintStream on http://localhost:${port} (data dir: ${paths.dataDir})`)

  // Boot the full stack: embedded Postgres -> migrate -> API + web on one port.
  // Dynamic import so all of the environment set above is in place first.
  await import('@printstream/api/server')

  // Bring up the in-box bridge once the API is booting; it dials the API over
  // loopback and retries until it is listening, then auto-pairs via the token.
  if (isManagedBridgeEnabled()) {
    await startInBoxBridge(paths, port)
  }
}
