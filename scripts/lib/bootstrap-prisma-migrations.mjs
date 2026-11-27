/**
 * Pure classifiers shared by the Prisma migration bootstrap and its tests.
 *
 * Prisma reports several recoverable legacy or fresh-install states only through command output.
 * These helpers keep that output policy separate from the bootstrap's database mutations. They do
 * not throw or mutate the command result; an absent exit status is treated as failure because a
 * terminated child process did not complete the requested migration.
 */
import { readdirSync } from 'node:fs'

/** Combines Prisma's two output streams into the diagnostic text used by the classifiers. */
export function getPrismaOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join('\n')
}

/** Returns whether Prisma refused to migrate a populated database with no migration history. */
export function isNonEmptyDatabaseBaselineCase(result) {
  const output = getPrismaOutput(result)
  return (result.status ?? 1) !== 0 && output.includes('P3005')
}

/** Returns whether Prisma found a previously recorded failed migration. */
export function hasFailedMigrationState(result) {
  const output = getPrismaOutput(result)
  return (result.status ?? 1) !== 0 && output.includes('P3009')
}

/**
 * Returns whether an empty database is blocked by the checked-in history's pre-history assumption.
 *
 * The relation check narrows broad P3009/P3018 codes to the one fresh-install failure that the
 * bootstrap may safely repair by replacing migration history and pushing the current schema.
 */
export function isRecoverableFreshInstallBaselineGap(result) {
  const output = getPrismaOutput(result)
  // P3018 is the first attempt on an empty database (the earliest checked-in
  // migration assumes pre-history auth tables); P3009 is any retry after that
  // failed attempt was recorded. Matching both lets a fresh install recover in
  // a single pass instead of relying on a container restart.
  return (result.status ?? 1) !== 0
    && (output.includes('P3009') || output.includes('P3018'))
    && output.includes('relation "AuthGroup" does not exist')
}

/** Lists migration directory names in deterministic application order. */
export function listCheckedInMigrationNames(migrationsDir) {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))
}

/**
 * The first migration after the squash onto `00000000000000_init`; every retired pre-squash
 * migration is dated before it. Mirrors `FIRST_POST_SQUASH_MIGRATION` in
 * `apps/api/src/lib/apply-migrations.ts`.
 */
export const FIRST_POST_SQUASH_MIGRATION = '20260801130000_rename_to_workspace_and_customer'

/**
 * Whether a history row names a migration the squash retired, and so may be collapsed. An unknown
 * name dated after the squash is a newer build's row, left by a rollback, and must be kept:
 * 1.3.22 deleted every such row, which made the next start re-run migrations against existing
 * tables and fail.
 */
export function isPreSquashMigrationName(name) {
  return name !== '00000000000000_init' && name < FIRST_POST_SQUASH_MIGRATION
}

/**
 * The newest migration shipped by a build whose history cleanup could damage a database (1.3.23
 * and earlier). A rollback to one of those builds can only re-run, and fail on, migrations it
 * ships, so a damaged history always fails at or before this name. A failure on any newer
 * migration is a real migration failure, never this damage, and is left for an administrator.
 */
export const LAST_MIGRATION_BEFORE_HISTORY_REPAIR = '20261025000000_printer_fault_history'

/** PostgreSQL's codes for "what this creates already exists": relation, column, object, type. */
const ALREADY_EXISTS_CODES = new Set(['42P07', '42701', '42710', '42P06'])

/**
 * Whether a migration's first error says it tried to create something that already exists.
 *
 * @param {{ code?: string } | null} firstError the error PostgreSQL returned for the migration's
 *   first failing statement (`firstMigrationError` in the bootstrap). Prisma's recorded log is not
 *   enough: a migration with its own BEGIN records only "current transaction is aborted".
 */
export function isAlreadyExistsError(firstError) {
  return Boolean(firstError?.code && ALREADY_EXISTS_CODES.has(firstError.code))
}

/**
 * Whether the history has exactly the shape a rollback to 1.3.23 or earlier leaves, after that
 * build deleted every row but init and re-ran the migrations into the existing tables:
 *
 * - the applied rows are a gap-free prefix of the checked-in migrations, in order;
 * - one row failed, and it is the next checked-in migration after that prefix;
 * - it is one those builds shipped (at or before `LAST_MIGRATION_BEFORE_HISTORY_REPAIR`).
 *
 * The caller then also requires the failure itself to be "already exists". A normal history
 * (every checked-in migration applied) never matches, nor does a failure of a newly added
 * migration, nor anything with rows this build does not know.
 *
 * @param {{ applied: string[], failed: Array<{ migration_name: string }>, onDisk: string[] }} history
 */
export function isRollbackDamagedHistory({ applied, failed, onDisk }) {
  if (failed.length !== 1) return false
  const [failure] = failed
  const prefix = onDisk.slice(0, applied.length)
  const appliedInOrder = [...applied].sort((left, right) => left.localeCompare(right))
  return appliedInOrder.length > 0
    && appliedInOrder.every((name, index) => name === prefix[index])
    && onDisk[applied.length] === failure.migration_name
    && failure.migration_name <= LAST_MIGRATION_BEFORE_HISTORY_REPAIR
}
