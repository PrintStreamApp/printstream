/**
 * Content-Security-Policy violation report sink.
 *
 * The CSP served by `lib/content-security-policy.ts` names this endpoint in
 * its `report-uri` directive, so browsers POST every violation here — in
 * report-only *and* enforce mode. Reports land in the server log (and the
 * in-app Logs tab via the console capture), giving operators a signal for
 * policy regressions across real users' browsers instead of relying on
 * whichever consoles happen to be watched.
 *
 * Unauthenticated by design: violations fire on marketing and auth pages too,
 * and browsers send reports without credentials. Noise is bounded by the
 * route-scoped rate limit (app.ts) plus in-process dedupe below.
 */
import { Router } from 'express'
import express from 'express'
import { z } from 'zod'
import { skipRequestAuditLog } from '../lib/audit-logs.js'

export const cspReportRouter = Router()

/**
 * Body shape browsers POST for `report-uri` (content type
 * `application/csp-report`). Fields beyond these exist but carry no signal we
 * log; unknown keys are ignored rather than rejected.
 */
const cspReportSchema = z.object({
  'csp-report': z.object({
    'document-uri': z.string().optional(),
    'effective-directive': z.string().optional(),
    'violated-directive': z.string().optional(),
    'blocked-uri': z.string().optional(),
    'source-file': z.string().optional(),
    'line-number': z.number().optional(),
    disposition: z.string().optional()
  }).passthrough()
})

/** Log each distinct (directive, blocked-uri) at most once per hour. */
const DEDUPE_WINDOW_MS = 60 * 60 * 1000
const DEDUPE_MAX_KEYS = 500
const recentlyLogged = new Map<string, number>()

function shouldLog(key: string, now: number): boolean {
  const last = recentlyLogged.get(key)
  if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return false
  if (recentlyLogged.size >= DEDUPE_MAX_KEYS) {
    for (const [staleKey, loggedAt] of recentlyLogged) {
      if (now - loggedAt >= DEDUPE_WINDOW_MS) recentlyLogged.delete(staleKey)
    }
    if (recentlyLogged.size >= DEDUPE_MAX_KEYS) recentlyLogged.clear()
  }
  recentlyLogged.set(key, now)
  return true
}

// The global JSON parser only handles `application/json`; browsers send CSP
// reports as `application/csp-report`.
cspReportRouter.use(express.json({
  type: ['application/csp-report', 'application/reports+json', 'application/json'],
  limit: '32kb'
}))

cspReportRouter.post('/', (request, response) => {
  // Deliberately unaudited: high-frequency, unauthenticated, browser-generated
  // traffic that would flood the audit trail without identifying any actor.
  skipRequestAuditLog(request)

  const parsed = cspReportSchema.safeParse(request.body)
  if (parsed.success) {
    const report = parsed.data['csp-report']
    const directive = report['effective-directive'] ?? report['violated-directive'] ?? 'unknown'
    const blocked = report['blocked-uri'] ?? 'unknown'
    if (shouldLog(`${directive}|${blocked}`, Date.now())) {
      console.warn('[csp-report] violation', JSON.stringify({
        directive,
        blockedUri: blocked,
        documentUri: report['document-uri'],
        sourceFile: report['source-file'],
        lineNumber: report['line-number'],
        disposition: report.disposition
      }))
    }
  }
  // Always 204: the sink is fire-and-forget and malformed junk earns no error
  // detail (or log line) an abuser could iterate against.
  response.status(204).end()
})
