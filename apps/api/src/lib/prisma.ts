/**
 * Singleton Prisma client with automatic workspace scoping.
 *
 * Reuses one instance across hot reloads in dev and binds the datasource
 * URL through the validated env module so the runtime matches the
 * workspace-root Prisma CLI configuration.
 *
 * Two clients are exported:
 *
 * - {@link prisma}: default for all request-scoped code. A `$extends`
 *   wrapper that automatically injects `workspaceId` into writes and merges
 *   it into reads for every model listed in {@link WORKSPACE_SCOPED_MODELS}.
 *   The workspace comes from the {@link AsyncLocalStorage} context set by
 *   the `installWorkspaceContext` middleware.
 *
 * - {@link rootPrisma}: escape hatch for deliberate platform-wide
 *   operations (workspace CRUD, background jobs, event-driven recording).
 *   Code that uses `rootPrisma` must supply its own workspace filtering.
 *
 * ## Security invariants
 *
 * - Every Prisma model with a `workspaceId` column must appear in either
 *   `WORKSPACE_SCOPED_MODELS` (auto-scoped here) or `WORKSPACE_SCOPED_EXCEPTION_MODELS`
 *   (a deliberate, hand-scoped exception: see that set). A test enforces this so
 *   a new `workspaceId` model cannot be silently left unscoped.
 * - Ownership-check operations (`findUnique`, `update`, `delete`,
 *   `upsert`) do a workspace-ownership pre-read so a foreign/missing row is
 *   reported as not-found. Write ops also merge `workspaceId` into their own
 *   `where` (and `upsert` into its `create`) so the database enforces
 *   ownership atomically at mutation time: closing the read-then-mutate
 *   TOCTOU window without a per-operation interactive transaction.
 * - Nested `connect` / `include` relations are **not** workspace-scoped
 *   by this extension. Routes that accept user-supplied relation IDs
 *   must validate ownership at the application layer.
 * - In non-production mode, a warning is logged when a workspace-scoped
 *   model is queried without an active `AsyncLocalStorage` context,
 *   helping catch accidental bypasses during development.
 */
import { PrismaClient } from '@prisma/client'
import { env } from './env.js'
import { badRequest, notFound } from './http-error.js'
import { getCurrentWorkspace, hasWorkspaceRequestContext } from './workspace-context.js'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

/**
 * Models whose rows are owned by a single workspace and must never leak
 * across workspace boundaries. The `$extends` wrapper below automatically
 * injects / filters by `workspaceId` for every operation on these models.
 *
 * **When adding a new model with a `workspaceId` FK, add it here too** (or to
 * `WORKSPACE_SCOPED_EXCEPTION_MODELS` if it genuinely cannot be auto-scoped).
 */
export const WORKSPACE_SCOPED_MODELS = new Set([
  'Bridge',
  'Printer',
  'PrintJob',
  'DispatchJob',
  'LibraryFile',
  'LibraryFileVersion',
  'LibraryFileReplica',
  'LibraryDownloadLink',
  'LibraryFolder',
  'LibraryFileFavorite',
  'PreparedSlicingSource',
  'SliceCacheEntry',
  'LibraryUploadCompletion',
  'PrinterView',
  'AuditLog',
  'AuthServiceAccount',
  'OrderTemplate',
  'OrderTemplateVariant',
  'OrderTemplatePrint',
  'Order',
  'OrderVariantSelection',
  'OrderPrint',
  'FilamentSpool',
  'FilamentSpoolUsage',
  'CalibrationRun',
  'CalibrationResult',
  'QueueItem',
  'WorkspaceStats',
  'PrinterStats',
  'PrinterMaintenanceTask',
  'PrinterMaintenanceLog',
  'WorkspaceFeatureUsage',
  'WorkspaceSubscription'
])

/**
 * Models that carry a `workspaceId` but are deliberately NOT auto-scoped by the
 * extension below, because the per-workspace scoping cannot express their access
 * pattern. They are instead hand-scoped at every call site:
 *
 * - `AuthGroup`, its `workspaceId` is **nullable**: `workspaceId = null` rows are
 *   platform-wide groups shared by every workspace. Auto-scoping would force the
 *   current workspace and hide platform groups (and break platform-user
 *   administration that legitimately spans workspaces). Reads go through
 *   `buildScopedAuthGroupWhere` (workspaceId = current workspace, or null for platform).
 * - `AuthWorkspaceMembership`: the user-to-workspace link itself; auth flows query it
 *   with explicit `{ workspaceId, userId }` (and workspace-compound uniques), including
 *   cross-workspace lookups of which workspaces a user belongs to.
 * - `SupportConversation`: cloud support messaging. Its `workspaceId` is a
 *   nullable point-in-time snapshot (no FK) recording which workspace the
 *   conversation came from; the inbox is platform-wide and every query goes
 *   through `rootPrisma` in the private cloud support routes.

 * This set exists so the "every workspaceId model is accounted for" invariant holds
 * and a future workspaceId model is consciously classified rather than silently left
 * unscoped (enforced by `prisma-workspace-models.test.ts`). Audited 2026-06: every
 * current read of these models scopes by workspace.
 */
export const WORKSPACE_SCOPED_EXCEPTION_MODELS = new Set([
  'AuthGroup',
  'AuthWorkspaceMembership',
  'SupportConversation'
])

/** Read/bulk-write operations where we merge `{ workspaceId }` into the `where` clause. */
const FILTERED_OPERATIONS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'updateManyAndReturn',
  'deleteMany'
])

/**
 * Single-row operations where we verify workspace ownership via a separate read
 * before proceeding. Write ops in this set additionally merge `workspaceId` into
 * their own `where` (see {@link WRITE_OWNERSHIP_OPERATIONS}) so the database
 * enforces ownership atomically at mutation time.
 */
const OWNERSHIP_CHECK_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'update',
  'updateOrThrow',
  'delete',
  'deleteOrThrow',
  'upsert'
])

/**
 * Ownership-checked WRITE ops (excludes the read variants and `upsert`, which is
 * scoped separately via {@link scopeOwnedMutationArgs} / {@link scopeUpsertArgs}).
 * For these the workspace id is merged into the mutation `where` so the row is
 * matched-and-mutated in one statement: closing the read-then-mutate TOCTOU
 * window without an interactive transaction.
 */
const WRITE_OWNERSHIP_OPERATIONS = new Set([
  'update',
  'updateOrThrow',
  'delete',
  'deleteOrThrow'
])

/** What an ownership-checked single-row op should do given the pre-read row. */
export type OwnershipCheckDecision = 'proceed' | 'return-null' | 'not-found'

/**
 * Decides how an ownership-checked operation proceeds once we've read the target
 * row's owner. Pure (no DB) so the rule is unit-testable. Key correctness point:
 * `upsert` must be allowed to CREATE when no workspace-owned row exists yet: earlier
 * a missing row was rejected as not-found before the create path could run, which
 * broke e.g. the first cross-bridge `libraryFileReplica.upsert`.
 */
export function decideOwnershipCheck(
  operation: string,
  existing: { workspaceId: string } | null,
  workspaceId: string
): OwnershipCheckDecision {
  // A row that exists but belongs to another workspace is never accessible: report
  // it as not-found for every operation (no cross-workspace read/update/delete/upsert).
  if (existing && existing.workspaceId !== workspaceId) return 'not-found'
  // upsert creates when absent and updates the workspace-owned row when present.
  if (operation === 'upsert') return 'proceed'
  // Every other ownership-checked op needs an existing workspace-owned row; a plain
  // findUnique miss is `null`, anything else is not-found.
  if (!existing) return operation === 'findUnique' ? 'return-null' : 'not-found'
  return 'proceed'
}

// Pure argument-shaping for the scoping extension below. Extracted so the
// workspace inject/merge rules are unit-testable without a database (the extension
// itself can only be exercised end-to-end against a live engine).

/** Inject the workspace id into a `create`'s data so new rows are always owned. */
export function scopeCreateArgs<T extends { data: Record<string, unknown> }>(args: T, workspaceId: string): T {
  return { ...args, data: { ...args.data, workspaceId } }
}

/** Inject the workspace id into every row of a `createMany` (array or single). */
export function scopeCreateManyArgs<T extends { data: Record<string, unknown> | Array<Record<string, unknown>> }>(args: T, workspaceId: string): T {
  const input = args.data
  return {
    ...args,
    data: Array.isArray(input) ? input.map((row) => ({ ...row, workspaceId })) : { ...input, workspaceId }
  }
}

/** Constrain a filtered (list/aggregate/*Many) op's `where` to the workspace. */
export function scopeFilteredArgs<T extends { where?: Record<string, unknown> }>(args: T, workspaceId: string): T {
  return { ...args, where: mergeWorkspaceWhere(args.where, workspaceId) }
}

/**
 * Constrain an ownership-checked update/delete to the workspace by adding `workspaceId`
 * to its `where` as an extra (non-unique) filter alongside the unique selector.
 * The DB then only mutates the row if it is still workspace-owned, so a concurrent
 * owner change between the pre-read and the mutation can't slip a cross-workspace
 * write through (it fails record-not-found instead).
 */
export function scopeOwnedMutationArgs<T extends { where: Record<string, unknown> }>(args: T, workspaceId: string): T {
  return { ...args, where: { ...args.where, workspaceId } }
}

/**
 * Scope an `upsert` once ownership has been verified: workspace-constrain the
 * `where`, inject the workspace id into `create`, and leave `update` untouched
 * (the row is already known to be workspace-owned at that point).
 */
export function scopeUpsertArgs<T extends { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }>(args: T, workspaceId: string): T {
  // Prisma's WhereUniqueInput requires a unique selector at the top level. Wrapping the selector
  // in `AND` makes an otherwise-valid upsert fail validation before it reaches the database.
  return { ...args, where: { ...args.where, workspaceId }, create: { ...args.create, workspaceId } }
}

/**
 * Append the configured connection-pool params to the datasource URL. Prisma
 * reads `connection_limit` / `pool_timeout` from the URL query string; we set
 * them from env (not the raw URL) so operators tune the pool without rewriting
 * the connection string. No-op when neither is set (Prisma's defaults apply).
 */
function buildDatasourceUrl(): string {
  const params: Array<[string, string]> = []
  if (env.DATABASE_CONNECTION_LIMIT != null) params.push(['connection_limit', String(env.DATABASE_CONNECTION_LIMIT)])
  if (env.DATABASE_POOL_TIMEOUT != null) params.push(['pool_timeout', String(env.DATABASE_POOL_TIMEOUT)])
  if (params.length === 0) return env.DATABASE_URL
  const separator = env.DATABASE_URL.includes('?') ? '&' : '?'
  return `${env.DATABASE_URL}${separator}${params.map(([key, value]) => `${key}=${value}`).join('&')}`
}

const basePrisma = globalForPrisma.prisma ?? new PrismaClient({
  datasources: {
    db: {
      url: buildDatasourceUrl()
    }
  }
})

/**
 * Unscoped Prisma client for deliberate platform-wide operations.
 * Prefer the workspace-scoped {@link prisma} for all request-path code.
 */
export const rootPrisma = basePrisma

// Typed as the plain PrismaClient: the extension below is behavior-only (query
// interception), so the public surface is identical, and the inferred
// DynamicClientExtension type is deep enough that the TS 7 native compiler
// rejects it ("excessive stack depth") at every call site. If this extension
// ever grows `result`/`model`/`client` components, the cast would hide their
// added surface and must be revisited.
export const prisma: PrismaClient = basePrisma.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (!model || !WORKSPACE_SCOPED_MODELS.has(model)) {
          return query(args)
        }

        if (!hasWorkspaceRequestContext()) {
          // Running outside a request context (background job, event
          // handler, startup). Callers in those paths should use
          // rootPrisma explicitly. Log a warning so accidental bypasses
          // are visible in dev/staging.
          if (process.env.NODE_ENV !== 'production') {
            console.warn(
              `[prisma] workspace-scoped model ${model}.${operation} called without a workspace request context. ` +
              'Use rootPrisma for deliberate platform-wide operations.'
            )
          }
          return query(args)
        }

        const workspace = getCurrentWorkspace()
        if (!workspace) {
          throw badRequest('Workspace context is required for this operation.')
        }

        if (operation === 'create') {
          return query(scopeCreateArgs(args as unknown as { data: Record<string, unknown> }, workspace.id) as typeof args)
        }

        if (operation === 'createMany' || operation === 'createManyAndReturn') {
          return query(scopeCreateManyArgs(args as unknown as { data: Record<string, unknown> | Array<Record<string, unknown>> }, workspace.id) as typeof args)
        }

        if (FILTERED_OPERATIONS.has(operation)) {
          return query(scopeFilteredArgs(args as unknown as { where?: Record<string, unknown> }, workspace.id) as typeof args)
        }

        if (OWNERSHIP_CHECK_OPERATIONS.has(operation)) {
          // Ownership pre-read: a foreign or missing row becomes not-found / null
          // before any mutation runs. (Deliberately NOT wrapped in $transaction:
          // the previous interactive-transaction wrapper ran the read and the
          // mutation on separate connections, so it provided neither atomicity nor
          // serializable isolation, only a wasteful per-op BEGIN/COMMIT. Write ops
          // instead merge workspaceId into their own `where` below, so the database
          // matches-and-mutates atomically and the TOCTOU window is closed.)
          const existing = await findWorkspaceOwnedRow(model, (args as unknown as { where?: Record<string, unknown> }).where)
          const decision = decideOwnershipCheck(operation, existing, workspace.id)
          if (decision === 'return-null') return null
          if (decision === 'not-found') throw notFound(`${model} not found.`)

          if (operation === 'upsert') {
            return query(scopeUpsertArgs(args as unknown as {
              where: Record<string, unknown>
              create: Record<string, unknown>
              update: Record<string, unknown>
            }, workspace.id) as typeof args)
          }

          if (WRITE_OWNERSHIP_OPERATIONS.has(operation)) {
            return query(scopeOwnedMutationArgs(args as unknown as { where: Record<string, unknown> }, workspace.id) as typeof args)
          }

          return query(args)
        }

        return query(args)
      }
    }
  }
}) as unknown as PrismaClient

export type WorkspaceScopedPrismaClient = typeof prisma
export type AnyPrismaClient = PrismaClient | WorkspaceScopedPrismaClient

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = basePrisma
}

export function mergeWorkspaceWhere(where: Record<string, unknown> | undefined, workspaceId: string): Record<string, unknown> {
  if (!where) {
    return { workspaceId }
  }

  return {
    AND: [where, { workspaceId }]
  }
}

async function findWorkspaceOwnedRow(model: string, where: Record<string, unknown> | undefined): Promise<{ workspaceId: string } | null> {
  if (!where) {
    throw badRequest(`Missing unique selector for ${model}.`)
  }

  const delegate = (basePrisma as unknown as Record<string, unknown>)[model.charAt(0).toLowerCase() + model.slice(1)] as {
    findUnique?: (input: { where: Record<string, unknown>; select: { workspaceId: true } }) => Promise<{ workspaceId: string } | null>
  } | undefined

  if (!delegate?.findUnique) {
    throw badRequest(`Workspace ownership checks are not supported for ${model}.`)
  }

  return delegate.findUnique({
    where,
    select: { workspaceId: true }
  })
}
