import { readdirSync } from 'node:fs'

export function getPrismaOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join('\n')
}

export function isNonEmptyDatabaseBaselineCase(result) {
  const output = getPrismaOutput(result)
  return (result.status ?? 1) !== 0 && output.includes('P3005')
}

export function hasFailedMigrationState(result) {
  const output = getPrismaOutput(result)
  return (result.status ?? 1) !== 0 && output.includes('P3009')
}

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

export function listCheckedInMigrationNames(migrationsDir) {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))
}