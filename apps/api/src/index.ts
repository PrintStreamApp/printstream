/**
 * Process entry point. Boots the HTTP server, attaches the WebSocket fan-out,
 * and starts the printer connection manager so MQTT subscriptions come up
 * even before any client connects.
 */
import { createServer } from 'node:http'
import { app } from './app.js'
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

function shutdown(signal: NodeJS.Signals) {
  console.log(`Received ${signal}, shutting down`)
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
  // Hard-exit fallback in case a stray handle still keeps the loop alive
  // (e.g. an MQTT reconnect timer). 5s is long enough for clean teardown
  // but short enough that dev restarts feel snappy.
  setTimeout(() => {
    console.warn('Shutdown timeout exceeded; forcing exit')
    process.exit(0)
  }, 5_000).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
