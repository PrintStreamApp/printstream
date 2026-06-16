/**
 * In-memory ring-buffer capture of the bridge's console output.
 *
 * The bridge writes diagnostics with `console.*`. Under the Docker runner that
 * stream reaches `docker logs`, but the standalone (native) build redirects it
 * to an on-disk file the operator typically can't reach. To make bridge logs
 * visible in the web app regardless of packaging, we mirror console output into
 * a bounded buffer that the `system.logs` RPC serves back to the API.
 *
 * Mirrors the API's `apps/api/src/lib/logs.ts`, minus tenant scoping — the
 * bridge process is single-tenant.
 */
import type { BridgeSystemLogEntry } from '@printstream/shared'

const MAX_ENTRIES = 1000
const buffer: BridgeSystemLogEntry[] = []

type BridgeLogListener = (entry: BridgeSystemLogEntry) => void
const listeners = new Set<BridgeLogListener>()

function record(level: BridgeSystemLogEntry['level'], args: unknown[]): void {
  const message = args
    .map((value) => {
      if (typeof value === 'string') return value
      if (value instanceof Error) return value.stack ?? value.message
      try {
        return JSON.stringify(value)
      } catch {
        return String(value)
      }
    })
    .join(' ')
  const entry: BridgeSystemLogEntry = { timestamp: new Date().toISOString(), level, message }
  buffer.push(entry)
  if (buffer.length > MAX_ENTRIES) buffer.shift()
  for (const listener of listeners) {
    // A faulty listener must never break logging (and would recurse if it
    // logged), so swallow anything it throws.
    try {
      listener(entry)
    } catch {
      // Ignore listener failures.
    }
  }
}

let installed = false

/**
 * Wrap the global console so everything the bridge logs is also retained in the
 * ring buffer. Idempotent and safe to call once at process start from either
 * packaging entrypoint.
 */
export function installBridgeLogCapture(): void {
  if (installed) return
  installed = true
  const originalLog = console.log.bind(console)
  const originalInfo = console.info.bind(console)
  const originalWarn = console.warn.bind(console)
  const originalError = console.error.bind(console)
  const originalDebug = console.debug.bind(console)

  console.log = (...args: unknown[]) => { record('info', args); originalLog(...args) }
  console.info = (...args: unknown[]) => { record('info', args); originalInfo(...args) }
  console.warn = (...args: unknown[]) => { record('warn', args); originalWarn(...args) }
  console.error = (...args: unknown[]) => { record('error', args); originalError(...args) }
  console.debug = (...args: unknown[]) => { record('debug', args); originalDebug(...args) }
}

/** Return the most recent captured log entries, oldest first. */
export function getBridgeLogs(limit = 500): BridgeSystemLogEntry[] {
  if (limit >= buffer.length) return [...buffer]
  return buffer.slice(buffer.length - limit)
}

/**
 * Subscribe to log entries captured after this call. Returns an unsubscribe
 * function. Used by the control channel's `logs.follow` op to stream live output
 * to the CLI; callers replay {@link getBridgeLogs} first for backfill.
 */
export function subscribeBridgeLogs(listener: BridgeLogListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
