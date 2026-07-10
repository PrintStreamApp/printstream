/**
 * Durable user audit logging.
 *
 * Captures user-visible mutating actions and annotated read operations after
 * they complete so platform and tenant logs can surface who changed what, in
 * which workspace, and whether the action succeeded. Routes can attach richer
 * action/resource metadata so logs stay understandable and can be surfaced
 * alongside related resources.
 */
import type { AuditActorType, AuditLogEntry, LogLevel, PermissionScope } from '@printstream/shared'
import type { NextFunction, Request, Response } from 'express'
import { env } from './env.js'
import { rootPrisma } from './prisma.js'
import { broadcastLogsChanged } from './ws-resource-events.js'

/** Upper bound on how many log entries a single read may return. */
export const MAX_LOG_LIMIT = 2000

/** Clamps a requested log limit into the inclusive range `[1, MAX_LOG_LIMIT]`. */
export function clampLogLimit(value: number): number {
  return Math.max(1, Math.min(MAX_LOG_LIMIT, value))
}

const AUDITED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const JOB_ACTIVITY_RELEVANT_ACTIONS = new Set([
  'start-print',
  'reprint-print',
  'start-printer-storage-print',
  'start-calibration',
  'retry-dispatch',
  'cancel-dispatch',
  'pause-print',
  'resume-print',
  'stop-print',
  'skip-objects',
  'clear-plate'
])
const JOB_ACTIVITY_START_WINDOW_MS = 10 * 60_000
const JOB_ACTIVITY_END_WINDOW_MS = 10 * 60_000

type AuditLogMetadata = Record<string, unknown>

export interface RequestAuditLogAnnotation {
  action?: string
  resource?: string
  summary?: string
  tenantId?: string | null
  metadata?: AuditLogMetadata
  requiredPermissions?: string[]
  /** When true, the request is deliberately excluded from the audit trail (see {@link skipRequestAuditLog}). */
  skip?: boolean
}

interface AuditLogRowShape {
  id: string
  tenantId: string | null
  actorType: string
  actorUserId: string | null
  actorServiceAccountId: string | null
  actorLabel: string | null
  requestMethod: string
  action: string
  resource: string
  summary: string
  statusCode: number
  metadataJson: string | null
  createdAt: Date
  actorUser?: { email: string; displayName: string | null } | null
  actorServiceAccount?: { name: string } | null
}

export interface RelatedPrintJobAuditInput {
  id: string
  printerId: string
  startedAt: Date
  finishedAt: Date | null
}

export function installAuditLogCapture() {
  return (request: Request, response: Response, next: NextFunction): void => {
    const snapshot = {
      method: request.method,
      path: request.path,
      tenantId: request.tenant?.id ?? null,
      actor: request.auth.actor,
      ipAddress: request.ip || null
    }

    response.on('finish', () => {
      if (request.auditLog?.skip) {
        return
      }
      if (!AUDITED_METHODS.has(snapshot.method) && !hasExplicitReadAuditAnnotation(request.auditLog)) {
        return
      }
      if (shouldSkipAuditLog(snapshot.path, response.statusCode)) {
        return
      }

      const descriptor = deriveAuditDescriptor(snapshot.method, snapshot.path, request.auditLog)
      const tenantId = hasAuditTenantOverride(request.auditLog)
        ? request.auditLog?.tenantId ?? null
        : snapshot.tenantId
      const metadataJson = buildMetadataJson(request.auditLog)
      void rootPrisma.auditLog.create({
        data: {
          tenantId,
          actorType: readActorType(snapshot.actor),
          actorUserId: snapshot.actor.type === 'user' ? snapshot.actor.userId : null,
          actorServiceAccountId: snapshot.actor.type === 'service-account' ? snapshot.actor.serviceAccountId : null,
          actorLabel: readActorLabel(snapshot.actor),
          requestMethod: snapshot.method,
          requestPath: snapshot.path,
          action: descriptor.action,
          resource: descriptor.resource,
          summary: response.statusCode >= 400
            ? `${descriptor.summary} (${response.statusCode})`
            : descriptor.summary,
          statusCode: response.statusCode,
          ipAddress: snapshot.ipAddress,
          metadataJson
        }
      }).then(() => {
        broadcastLogsChanged(tenantId)
      }).catch((error) => {
        console.error('Failed to write audit log entry', error)
      })
    })

    next()
  }
}

function hasExplicitReadAuditAnnotation(annotation?: RequestAuditLogAnnotation): boolean {
  if (!annotation) {
    return false
  }

  return Boolean(
    annotation.action
      || annotation.resource
      || annotation.summary
      || (annotation.metadata && Object.keys(annotation.metadata).length > 0)
  )
}

export function annotateRequestAuditLog(
  request: Request,
  input: Pick<RequestAuditLogAnnotation, 'action' | 'resource' | 'summary' | 'tenantId' | 'metadata'>
): void {
  request.auditLog = {
    ...(request.auditLog ?? {}),
    ...(input.action ? { action: input.action } : {}),
    ...(input.resource ? { resource: input.resource } : {}),
    ...(input.summary ? { summary: input.summary } : {}),
    ...(hasOwn(input, 'tenantId') ? { tenantId: input.tenantId ?? null } : {}),
    metadata: {
      ...(request.auditLog?.metadata ?? {}),
      ...(input.metadata ?? {})
    }
  }
}

/**
 * Excludes the current request from the durable audit trail. Reserve this for
 * high-frequency endpoints with no audit value (per-notification dismissal
 * syncs, polling-style mutations) where a row per request would be noise —
 * the analogue of the path-based skips in {@link shouldSkipAuditLog}, but
 * declared by the owning route so plugins do not leak paths into this module.
 */
export function skipRequestAuditLog(request: Request): void {
  request.auditLog = {
    ...(request.auditLog ?? {}),
    skip: true
  }
}

export function noteRequestAuditPermission(request: Request, permission: PermissionScope): void {
  const requiredPermissions = new Set(request.auditLog?.requiredPermissions ?? [])
  requiredPermissions.add(permission)
  request.auditLog = {
    ...(request.auditLog ?? {}),
    requiredPermissions: [...requiredPermissions]
  }
}

export async function getAuditLogs(limit = 500, input?: { tenantId?: string | null }): Promise<AuditLogEntry[]> {
  const rows = await rootPrisma.auditLog.findMany({
    where: input?.tenantId === undefined
      ? undefined
      : { tenantId: input.tenantId },
    select: {
      id: true,
      tenantId: true,
      actorType: true,
      actorUserId: true,
      actorServiceAccountId: true,
      actorLabel: true,
      requestMethod: true,
      action: true,
      resource: true,
      summary: true,
      statusCode: true,
      metadataJson: true,
      createdAt: true,
      actorUser: {
        select: {
          email: true,
          displayName: true
        }
      },
      actorServiceAccount: {
        select: {
          name: true
        }
      }
    },
    orderBy: { createdAt: 'desc' },
    take: clampLogLimit(limit)
  })

  return rows.map(mapAuditLogRow)
}

export async function clearAuditLogs(input?: { tenantId?: string | null }): Promise<void> {
  await rootPrisma.auditLog.deleteMany({
    where: input?.tenantId === undefined
      ? undefined
      : { tenantId: input.tenantId }
  })
}

/**
 * Deletes audit-log rows older than `AUDIT_LOG_RETENTION_DAYS`. Platform-wide
 * (all tenants) scheduled maintenance, so it uses rootPrisma; the `createdAt`
 * index keeps the delete cheap. Without this the table grew unbounded.
 */
export async function pruneAuditLogs(): Promise<{ removed: number }> {
  const cutoff = new Date(Date.now() - env.AUDIT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  const { count } = await rootPrisma.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } })
  return { removed: count }
}

export async function getRelatedAuditLogsForPrintJobs(
  jobs: RelatedPrintJobAuditInput[],
  tenantId: string
): Promise<Map<string, AuditLogEntry[]>> {
  const results = new Map<string, AuditLogEntry[]>()
  for (const job of jobs) results.set(job.id, [])
  if (jobs.length === 0) return results

  const earliestStartedAt = jobs.reduce(
    (current, job) => (job.startedAt < current ? job.startedAt : current),
    jobs[0]!.startedAt
  )
  const rows = await rootPrisma.auditLog.findMany({
    where: {
      tenantId,
      createdAt: { gte: new Date(earliestStartedAt.getTime() - JOB_ACTIVITY_START_WINDOW_MS) }
    },
    select: {
      id: true,
      tenantId: true,
      actorType: true,
      actorUserId: true,
      actorServiceAccountId: true,
      actorLabel: true,
      requestMethod: true,
      action: true,
      resource: true,
      summary: true,
      statusCode: true,
      metadataJson: true,
      createdAt: true,
      actorUser: {
        select: {
          email: true,
          displayName: true
        }
      },
      actorServiceAccount: {
        select: {
          name: true
        }
      }
    },
    orderBy: { createdAt: 'desc' },
    take: 1000
  })

  for (const row of rows) {
    const metadata = parseMetadataJson(row.metadataJson)
    const directJobId = typeof metadata?.jobId === 'string' ? metadata.jobId : null
    if (directJobId && results.has(directJobId)) {
      results.get(directJobId)!.push(mapAuditLogRow(row))
      continue
    }

    if (!JOB_ACTIVITY_RELEVANT_ACTIONS.has(row.action)) continue
    const printerId = typeof metadata?.printerId === 'string' ? metadata.printerId : null
    if (!printerId) continue

    const matchingJob = findMatchingPrintJob(jobs, printerId, row.createdAt)
    if (!matchingJob) continue
    results.get(matchingJob.id)!.push(mapAuditLogRow(row))
  }

  return results
}

/** Matches the per-chunk upload endpoint, e.g. `/api/library/uploads/<id>/chunks`. */
const UPLOAD_CHUNK_PATH = /^\/api\/library\/uploads\/[^/]+\/chunks$/

export function shouldSkipAuditLog(path: string, statusCode: number): boolean {
  if (path === '/api/health') return true
  if (path === '/api/logs' && statusCode === 204) return false
  // A large upload PUTs dozens of 16 MiB chunks, each an audited mutation — pure
  // noise. The upload is still audited once at POST /uploads/:id/complete.
  if (UPLOAD_CHUNK_PATH.test(path)) return true
  return false
}

function deriveAuditDescriptor(
  method: string,
  path: string,
  annotation?: RequestAuditLogAnnotation
): { action: string; resource: string; summary: string } {
  if (annotation?.action && annotation.resource && annotation.summary) {
    return {
      action: annotation.action,
      resource: annotation.resource,
      summary: annotation.summary
    }
  }

  if (path === '/api/auth/logout') {
    return { action: 'logout', resource: 'session', summary: 'Signed out of the current session.' }
  }
  if (path === '/api/auth/switch-tenant') {
    return { action: 'switch-tenant', resource: 'workspace', summary: 'Switched into a different tenant workspace.' }
  }
  if (path === '/api/auth/tenant-context') {
    return { action: 'switch-workspace', resource: 'workspace', summary: 'Changed the active platform workspace context.' }
  }

  if (path.startsWith('/api/tenants')) {
    return summarizeCrud(method, 'tenant')
  }
  if (path.startsWith('/api/settings')) {
    return summarizeCrud(method, 'settings')
  }
  if (path.startsWith('/api/admin/plugins') || path.startsWith('/api/plugin-catalog')) {
    return summarizeCrud(method, 'plugin')
  }
  if (path.startsWith('/api/logs')) {
    return summarizeCrud(method, 'logs')
  }
  if (path.startsWith('/api/auth')) {
    return summarizeCrud(method, 'authentication')
  }

  const segments = path.split('/').filter(Boolean)
  const resource = segments[1] ?? 'request'
  return summarizeCrud(method, resource.replace(/-/g, ' '))
}

function summarizeCrud(method: string, resource: string): { action: string; resource: string; summary: string } {
  switch (method) {
    case 'POST':
      return { action: 'create', resource, summary: `Created or submitted ${resource}.` }
    case 'PUT':
    case 'PATCH':
      return { action: 'update', resource, summary: `Updated ${resource}.` }
    case 'DELETE':
      return { action: 'delete', resource, summary: `Deleted ${resource}.` }
    default:
      return { action: method.toLowerCase(), resource, summary: `${method} ${resource}.` }
  }
}

function readActorType(actor: Request['auth']['actor']): AuditActorType {
  if (actor.type === 'service-account') return 'service-account'
  if (actor.type === 'user') return 'user'
  return 'anonymous'
}

function readActorLabel(actor: Request['auth']['actor']): string | null {
  switch (actor.type) {
    case 'user':
      return `user:${actor.userId}`
    case 'service-account':
      return `service-account:${actor.serviceAccountId}`
    default:
      return null
  }
}

function normalizeActorType(value: string): AuditActorType {
  if (value === 'user' || value === 'service-account') {
    return value
  }
  return 'anonymous'
}

function hasAuditTenantOverride(annotation?: RequestAuditLogAnnotation): boolean {
  return hasOwn(annotation, 'tenantId')
}

function hasOwn<T extends object>(value: T | null | undefined, key: PropertyKey): boolean {
  return value != null && Object.prototype.hasOwnProperty.call(value, key)
}

function buildMetadataJson(annotation?: RequestAuditLogAnnotation): string | null {
  const metadata: AuditLogMetadata = {
    ...(annotation?.metadata ?? {}),
    ...(annotation?.requiredPermissions && annotation.requiredPermissions.length > 0
      ? { requiredPermissions: annotation.requiredPermissions }
      : {})
  }
  return Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null
}

function mapAuditLogRow(row: AuditLogRowShape): AuditLogEntry {
  return {
    kind: 'audit',
    id: row.id,
    timestamp: row.createdAt.toISOString(),
    tenantId: row.tenantId,
    actorType: normalizeActorType(row.actorType),
    actorUserId: row.actorUserId,
    actorServiceAccountId: row.actorServiceAccountId,
    actorLabel: formatActorLabel(row),
    level: deriveAuditLogLevel(row),
    action: row.action,
    resource: row.resource,
    summary: row.summary,
    statusCode: row.statusCode,
    metadataJson: row.metadataJson
  }
}

function formatActorLabel(row: AuditLogRowShape): string | null {
  if (row.actorUser) {
    return row.actorUser.displayName?.trim() || row.actorUser.email
  }
  if (row.actorServiceAccount?.name) {
    return row.actorServiceAccount.name
  }
  return row.actorLabel
}

function deriveAuditLogLevel(row: Pick<AuditLogRowShape, 'action' | 'requestMethod' | 'statusCode'>): LogLevel {
  if (row.statusCode >= 500) return 'error'
  if (row.statusCode >= 400) return 'warn'
  if (row.action === 'switch-tenant' || row.action === 'switch-workspace') return 'debug'
  if (!AUDITED_METHODS.has(row.requestMethod.toUpperCase())) return 'debug'
  return 'info'
}

function parseMetadataJson(value: string | null): AuditLogMetadata | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return typeof parsed === 'object' && parsed != null ? parsed as AuditLogMetadata : null
  } catch {
    return null
  }
}

function findMatchingPrintJob(
  jobs: RelatedPrintJobAuditInput[],
  printerId: string,
  timestamp: Date
): RelatedPrintJobAuditInput | null {
  const matches = jobs.filter((job) => {
    if (job.printerId !== printerId) return false
    const lowerBound = job.startedAt.getTime() - JOB_ACTIVITY_START_WINDOW_MS
    const upperBound = (job.finishedAt?.getTime() ?? Date.now()) + JOB_ACTIVITY_END_WINDOW_MS
    return timestamp.getTime() >= lowerBound && timestamp.getTime() <= upperBound
  })
  if (matches.length === 0) return null
  if (matches.length === 1) return matches[0] ?? null

  return matches
    .slice()
    .sort((left, right) => Math.abs(timestamp.getTime() - left.startedAt.getTime()) - Math.abs(timestamp.getTime() - right.startedAt.getTime()))[0] ?? null
}