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
