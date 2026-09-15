/**
 * Resolves the PostgreSQL administrator connection required by the full validation gate.
 *
 * Direct test runs may omit PostgreSQL, but `npm run validate` must exercise the migration tests.
 * An explicit test administrator URL wins; otherwise an already-reachable DATABASE_URL is adapted
 * to the maintenance database before Devkit is asked to provision the checkout infrastructure.
 * Connection strings are returned only through the child environment and are never logged.
 */
import { Client } from 'pg'

export const REQUIRE_VALIDATION_DATABASE_ENV = 'PRINTSTREAM_REQUIRE_TEST_DATABASE'

/**
 * Builds the environment for the validation subprocess after proving PostgreSQL is reachable.
 * Devkit is idempotent and starts the shared database when a local checkout has no live runtime.
 */
export async function prepareValidationDatabase({
  repoRoot,
  environment = process.env,
  prepareDevkit,
  probe = canConnect
}) {
  prepareDevkit ??= async (options) => {
    const { prepareDatabase } = await import('@ryanewen/devkit')
    return prepareDatabase(options)
  }
  const explicitAdminUrl = environment.TEST_ADMIN_DATABASE_URL
  if (explicitAdminUrl) {
    await requireReachableDatabase(explicitAdminUrl, probe, 'TEST_ADMIN_DATABASE_URL')
    return preparedEnvironment(environment, explicitAdminUrl, 'configured test database')
  }

  const configuredAdminUrl = maintenanceDatabaseUrl(environment.DATABASE_URL)
  if (configuredAdminUrl && await probe(configuredAdminUrl)) {
    return preparedEnvironment(environment, configuredAdminUrl, 'configured database')
  }

  let state
  try {
    state = await prepareDevkit({ repoRoot })
  } catch (error) {
    throw new Error(`could not prepare the validation database: ${error.message}`, { cause: error })
  }

  if (!state) {
    const reason = configuredAdminUrl
      ? 'DATABASE_URL is not reachable and Devkit is not enabled'
      : 'set TEST_ADMIN_DATABASE_URL or enable Devkit for this checkout'
    throw new Error(`PostgreSQL is required for full validation; ${reason}.`)
  }

  const devkitAdminUrl = maintenanceDatabaseUrl(state.databaseUrl)
  await requireReachableDatabase(devkitAdminUrl, probe, 'the Devkit database')
  return preparedEnvironment(environment, devkitAdminUrl, 'Devkit database', state.databaseUrl)
}

/** Changes only the database name, preserving Devkit's host, port, credentials, and SSL options. */
export function maintenanceDatabaseUrl(databaseUrl) {
  if (!databaseUrl) return undefined
  const url = new URL(databaseUrl)
  url.pathname = '/postgres'
  return url.toString()
}

async function requireReachableDatabase(databaseUrl, probe, label) {
  if (databaseUrl && await probe(databaseUrl)) return
  throw new Error(`PostgreSQL is required for full validation, but ${label} is not reachable.`)
}

function preparedEnvironment(environment, adminUrl, source, databaseUrl) {
  return {
    environment: {
      ...environment,
      ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
      TEST_ADMIN_DATABASE_URL: adminUrl,
      [REQUIRE_VALIDATION_DATABASE_ENV]: '1'
    },
    source
  }
}

/** Performs a bounded query probe so an unavailable configured database fails before the suite. */
async function canConnect(databaseUrl) {
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 1500 })
  try {
    await client.connect()
    await client.query('SELECT 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => undefined)
  }
}
