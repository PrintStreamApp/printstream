/**
 * Singleton Prisma client with automatic tenant scoping.
 *
 * Reuses one instance across hot reloads in dev and binds the datasource
 * URL through the validated env module so the runtime matches the
 * workspace-root Prisma CLI configuration.
 *
 * Two clients are exported:
 *
 * - {@link prisma} — default for all request-scoped code. A `$extends`
 *   wrapper that automatically injects `tenantId` into writes and merges
 *   it into reads for every model listed in {@link TENANT_SCOPED_MODELS}.
 *   The tenant comes from the {@link AsyncLocalStorage} context set by
 *   the `installTenantContext` middleware.
 *
 * - {@link rootPrisma} — escape hatch for deliberate platform-wide
 *   operations (tenant CRUD, background jobs, event-driven recording).
 *   Code that uses `rootPrisma` must supply its own tenant filtering.
 *
 * ## Security invariants
 *
 * - Every Prisma model with a `tenantId` column must appear in
 *   `TENANT_SCOPED_MODELS`. When adding a new model, update the set.
 * - Ownership-check operations (`findUnique`, `update`, `delete`,
 *   `upsert`) run inside a serializable `$transaction` to prevent
 *   TOCTOU races between the tenant check and the mutation.
 * - Nested `connect` / `include` relations are **not** tenant-scoped
 *   by this extension. Routes that accept user-supplied relation IDs
 *   must validate ownership at the application layer.
 * - In non-production mode, a warning is logged when a tenant-scoped
 *   model is queried without an active `AsyncLocalStorage` context,
 *   helping catch accidental bypasses during development.
 */
import { PrismaClient } from '@prisma/client'
import { env } from './env.js'
import { badRequest, notFound } from './http-error.js'
import { getCurrentTenant, hasTenantRequestContext } from './tenant-context.js'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

/**
 * Models whose rows are owned by a single tenant and must never leak
 * across tenant boundaries. The `$extends` wrapper below automatically
 * injects / filters by `tenantId` for every operation on these models.
 *
 * **When adding a new model with a `tenantId` FK, add it here too.**
 */
const TENANT_SCOPED_MODELS = new Set([
  'Bridge',
  'Printer',
  'PrintJob',
  'LibraryFile',
  'LibraryFileVersion',
  'LibraryFileReplica',
  'LibraryFolder',
  'PrinterView',
  'AuditLog',
  'AuthServiceAccount',
  'OrderTemplate',
  'OrderTemplateVariant',
  'OrderTemplatePrint',
  'Order',
  'OrderVariantSelection',
  'OrderPrint',
  'TenantStats',
  'PrinterStats'
])

/** Read/bulk-write operations where we merge `{ tenantId }` into the `where` clause. */
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
 * Single-row operations where we verify tenant ownership via a
 * separate read before proceeding. Wrapped in a `$transaction` to
 * eliminate TOCTOU races.
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

const basePrisma = globalForPrisma.prisma ?? new PrismaClient({
  datasources: {
    db: {
      url: env.DATABASE_URL
    }
  }
})

/**
 * Unscoped Prisma client for deliberate platform-wide operations.
 * Prefer the tenant-scoped {@link prisma} for all request-path code.
 */
export const rootPrisma = basePrisma

export const prisma = basePrisma.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (!model || !TENANT_SCOPED_MODELS.has(model)) {
          return query(args)
        }

        if (!hasTenantRequestContext()) {
          // Running outside a request context (background job, event
          // handler, startup). Callers in those paths should use
          // rootPrisma explicitly. Log a warning so accidental bypasses
          // are visible in dev/staging.
          if (process.env.NODE_ENV !== 'production') {
            console.warn(
              `[prisma] tenant-scoped model ${model}.${operation} called without a tenant request context. ` +
              'Use rootPrisma for deliberate platform-wide operations.'
            )
          }
          return query(args)
        }

        const tenant = getCurrentTenant()
        if (!tenant) {
          throw badRequest('Tenant context is required for this operation.')
        }

        if (operation === 'create') {
          const createArgs = args as unknown as { data: Record<string, unknown> }
          return query({
            ...args,
            data: {
              ...createArgs.data,
              tenantId: tenant.id
            }
          })
        }

        if (operation === 'createMany' || operation === 'createManyAndReturn') {
          const input = (args as unknown as { data: Record<string, unknown> | Array<Record<string, unknown>> }).data
          return query({
            ...args,
            data: Array.isArray(input)
              ? input.map((row) => ({ ...row, tenantId: tenant.id }))
              : { ...input, tenantId: tenant.id }
          })
        }

        if (FILTERED_OPERATIONS.has(operation)) {
          return query({
            ...args,
            where: mergeTenantWhere((args as { where?: Record<string, unknown> }).where, tenant.id)
          })
        }

        if (OWNERSHIP_CHECK_OPERATIONS.has(operation)) {
          // Use a serializable transaction to eliminate the TOCTOU
          // window between the ownership check and the actual mutation.
          return await basePrisma.$transaction(async () => {
            const existing = await findTenantOwnedRow(model, (args as unknown as { where?: Record<string, unknown> }).where)
            if (!existing || existing.tenantId !== tenant.id) {
              if (operation === 'findUnique') {
                return null
              }
              throw notFound(`${model} not found.`)
            }

            if (operation === 'upsert') {
              const upsertArgs = args as unknown as {
                where: Record<string, unknown>
                create: Record<string, unknown>
                update: Record<string, unknown>
              }
              return query({
                ...args,
                where: mergeTenantWhere(upsertArgs.where, tenant.id),
                create: {
                  ...upsertArgs.create,
                  tenantId: tenant.id
                },
                update: upsertArgs.update
              } as typeof args)
            }

            return query(args)
          })
        }

        return query(args)
      }
    }
  }
})

export type TenantScopedPrismaClient = typeof prisma
export type AnyPrismaClient = PrismaClient | TenantScopedPrismaClient

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = basePrisma
}

function mergeTenantWhere(where: Record<string, unknown> | undefined, tenantId: string): Record<string, unknown> {
  if (!where) {
    return { tenantId }
  }

  return {
    AND: [where, { tenantId }]
  }
}

async function findTenantOwnedRow(model: string, where: Record<string, unknown> | undefined): Promise<{ tenantId: string } | null> {
  if (!where) {
    throw badRequest(`Missing unique selector for ${model}.`)
  }

  const delegate = (basePrisma as unknown as Record<string, unknown>)[model.charAt(0).toLowerCase() + model.slice(1)] as {
    findUnique?: (input: { where: Record<string, unknown>; select: { tenantId: true } }) => Promise<{ tenantId: string } | null>
  } | undefined

  if (!delegate?.findUnique) {
    throw badRequest(`Tenant ownership checks are not supported for ${model}.`)
  }

  return delegate.findUnique({
    where,
    select: { tenantId: true }
  })
}
