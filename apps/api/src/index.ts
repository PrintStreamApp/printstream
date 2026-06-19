/**
 * Process entry point. Boots the HTTP server, attaches the WebSocket fan-out,
 * and starts the printer connection manager so MQTT subscriptions come up
 * even before any client connects.
 */
import { createServer } from 'node:http'
import { app, finalizeApp } from './app.js'
import { env } from './lib/env.js'
import { attachWebSocketServer } from './lib/ws-server.js'
import { attachBridgeSessionServer } from './lib/bridge-session-server.js'
import { printerManager } from './lib/printer-manager.js'
import { startHmsCodeService } from './lib/hms-codes.js'
import { startLibraryCleanup, stopLibraryCleanup } from './lib/library-cleanup.js'
import { startAppUpdateChecks } from './lib/app-update-check.js'
import { registerBuiltinPlugins } from './plugin/builtin.js'
import { pluginRegistry } from './plugin/registry.js'
import { loadInstalledExternalPlugins } from './plugin/installer.js'
import { loadNotificationTemplates } from './lib/notification-templates.js'
import { startNotificationSnapshotPrecapture } from './lib/notification-snapshots.js'
import { startPrintJobRecorder, stopPrintJobRecorder } from './lib/print-job-recorder.js'
import {
  startActivePrintObjectCache,
  stopActivePrintObjectCache
} from './lib/active-print-objects.js'
import { ensureDefaultWorkspace } from './lib/default-workspace.js'
import { ensureManagedBridgeToken, isManagedBridgeMode } from './lib/managed-bridge.js'

const httpServer = createServer(app)
attachWebSocketServer(httpServer)
attachBridgeSessionServer(httpServer)

// Create the managed-bridge provisioning token before accepting connections so
// the bundled bridge can read it from the shared mount on its first register.
if (isManagedBridgeMode()) {
  try {
    ensureManagedBridgeToken()
  } catch (error) {
    console.error('Failed to provision the managed-bridge token', error)
  }
}

// Finish wiring (private modules + SPA fallback + error handler) before we start
// accepting requests, then listen. `finalizeApp` replaces what used to be a
// top-level await in `app.ts` (forbidden in a CommonJS SEA bundle).
void finalizeApp()
  .catch((error) => {
    console.error('Failed to finalize app wiring', error)
    process.exit(1)
  })
  .then(() => {
    // Surface a clear message on a bind failure (esp. EADDRINUSE) instead of letting it
    // bubble up as an uncaught 'error' event — which crashes silently in the native GUI
    // build and as a bare stack trace on the CLI.
    httpServer.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`Cannot start: port ${env.API_PORT} is already in use. Stop whatever is using it, or set API_PORT/PORT to a free port.`)
      } else {
        console.error('HTTP server error', error)
      }
      process.exit(1)
    })
    httpServer.listen(env.API_PORT, () => {
      console.log(`printstream API listening on http://localhost:${env.API_PORT}`)
      void (async () => {
    try {
      await ensureDefaultWorkspace()
    } catch (error) {
      console.error('Failed to ensure default workspace', error)
    }
    try {
      await loadNotificationTemplates()
    } catch (error) {
      console.error('Failed to load notification templates', error)
    }
    // Start the snapshot pre-capture listener before plugins so its
    // `job.finished` handler runs first and the cached frame is ready
    // by the time the notification plugins format their messages.
    try {
      startPrintJobRecorder()
    } catch (error) {
      console.error('Failed to start print job recorder', error)
    }
    try {
      startActivePrintObjectCache()
    } catch (error) {
      console.error('Failed to start active print object cache', error)
    }
    try {
      startNotificationSnapshotPrecapture()
    } catch (error) {
      console.error('Failed to start notification snapshot pre-capture', error)
    }
    try {
      await registerBuiltinPlugins()
    } catch (error) {
      console.error('Failed to register built-in plugins', error)
    }
    try {
      await loadInstalledExternalPlugins()
    } catch (error) {
      console.error('Failed to load external plugins', error)
    }
    try {
      await startHmsCodeService()
    } catch (error) {
      console.error('Failed to start HMS code service', error)
    }
    try {
      await printerManager.start()
    } catch (error) {
      console.error('Failed to start printer manager', error)
    }
    try {
      startLibraryCleanup()
    } catch (error) {
      console.error('Failed to start library cleanup', error)
    }
    try {
      // No-op unless this is the published open-core image; warms the GHCR
      // update check that powers the footer "update available" hint.
      startAppUpdateChecks()
    } catch (error) {
      console.error('Failed to start app update checks', error)
    }
      })()
    })
  })

let shuttingDown = false
let shutdownStartedAt = 0
function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) {
    // ONE Ctrl-C delivers two signals in quick succession under the dev runner: the terminal
    // SIGINTs the whole process group, then `concurrently` SIGTERMs its children. Exit immediately
    // (keeping dev Ctrl-C snappy), but DON'T print the "forcing immediate exit" notice for that
    // near-instant doubled signal — it's the same Ctrl-C, not the user impatiently pressing again.
    // A repeat that arrives well later is a genuine second Ctrl-C and gets the notice.
    if (Date.now() - shutdownStartedAt > 1_000) {
      console.warn(`Received ${signal} again; forcing immediate exit`)
    }
    process.exit(1)
  }
  shuttingDown = true
  shutdownStartedAt = Date.now()
  console.log(`Received ${signal}, shutting down (Ctrl-C again to force-quit)`)
  stopLibraryCleanup()
  stopPrintJobRecorder()
  stopActivePrintObjectCache()
  // `httpServer.close()` only stops accepting new connections — it waits
  // for active sockets (WS clients, keep-alives) to drain, which can hang
  // tsx/nodemon restarts indefinitely. Force-drop them so the process
  // exits promptly.
  httpServer.closeAllConnections?.()
  void Promise.allSettled([printerManager.stop(), pluginRegistry.shutdown()]).finally(() => {
    httpServer.close(() => process.exit(0))
  })
  // Hard-exit fallback for a stray handle that outlives graceful teardown — most often a connected
  // printer's MQTT disconnect that never settles, or embedded Postgres. Short in dev so `npm run dev`
  // Ctrl-C feels instant; longer in production to let in-flight requests drain. (`unref` so an
  // already-idle loop still exits early; a second Ctrl-C bypasses this entirely.)
  const forceExitMs = env.NODE_ENV === 'production' ? 5_000 : 1_500
  setTimeout(() => {
    console.warn('Shutdown timeout exceeded; forcing exit')
    process.exit(0)
  }, forceExitMs).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
