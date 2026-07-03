/**
 * In-memory ring-buffer log capture.
 *
 * Wraps the global `console` so anything written by the API (including
 * MQTT errors and request handlers) is mirrored into a bounded buffer
 * the UI can fetch via `/api/logs`. Intentionally tiny: durable logging
 * is out of scope for v1, but a "Logs" tab is needed for diagnostics.
 */
import type { SystemLogEntry } from '@printstream/shared'
import { getCurrentTenant } from './tenant-context.js'
import { getCorrelationId } from './request-context.js'

const MAX_ENTRIES = 1000
const buffer: SystemLogEntry[] = []

function record(level: SystemLogEntry['level'], args: unknown[]): void {
  const tenant = getCurrentTenant()
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
  buffer.push({ kind: 'system', timestamp: new Date().toISOString(), level, message, tenantId: tenant?.id ?? null, correlationId: getCorrelationId() })
  if (buffer.length > MAX_ENTRIES) buffer.shift()
}

let installed = false

export function installLogCapture(): void {
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

/**
 * Append a structured system log entry with an explicit tenant scope. Use this
 * for events detected OUTSIDE a request/tenant context (e.g. a bridge crash
 * report arriving over the bridge session): the console-capture path reads the
 * ambient tenant, which is null off-request, so a bare `console.*` line would be
 * invisible to the owning tenant's Logs view. Callers own their own live-refresh
 * broadcast (`broadcastLogsChanged`).
 */
export function pushSystemLog(entry: { level: SystemLogEntry['level']; message: string; tenantId: string | null }): void {
  buffer.push({
    kind: 'system',
    timestamp: new Date().toISOString(),
    level: entry.level,
    message: entry.message,
    tenantId: entry.tenantId,
    correlationId: null
  })
  if (buffer.length > MAX_ENTRIES) buffer.shift()
}

export function getLogs(limit = 500, input?: { tenantId?: string }): SystemLogEntry[] {
  const entries = input?.tenantId
    ? buffer.filter((entry) => entry.tenantId === input.tenantId)
    : buffer
  if (limit >= entries.length) return [...entries]
  return entries.slice(entries.length - limit)
}

export function clearLogs(input?: { tenantId?: string }): void {
  if (!input?.tenantId) {
    buffer.length = 0
    return
  }

  let writeIndex = 0
  for (let readIndex = 0; readIndex < buffer.length; readIndex += 1) {
    const entry = buffer[readIndex]
    if (!entry || entry.tenantId === input.tenantId) {
      continue
    }
    buffer[writeIndex] = entry
    writeIndex += 1
  }
  buffer.length = writeIndex
}
