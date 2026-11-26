/**
 * Production refusals and warnings for the API's environment (SEC-6).
 *
 * `env.ts` runs these once, right after parsing: an error stops the process at start, and a
 * warning is logged and startup continues. They live apart from `env.ts` because that module
 * parses `process.env` the moment it is imported, which would make the rules impossible to test
 * against inputs of our choosing.
 *
 * What is refused, and what deliberately is not (SEC-6 and its self-hosted exception):
 * - Refused: production with `DATABASE_URL` unset, so the server never falls back to the
 *   schema's built-in credentials; and production with the development sign-in credential set.
 * - Warned, not refused: a database password that earlier releases shipped as a default, on a
 *   database that is not on this machine. Refusing it would stop every install that started
 *   from those compose files, and their database is reachable only on the private compose
 *   network. The deployment guide has the rotation steps.
 * - Not checked: a plain-HTTP client origin. Self-hosted LAN installs normally have no
 *   certificate, so SEC-6 exempts self-hosted builds.
 */

/** The raw values the guards look at, before the schema applies any default. */
export interface ProductionGuardInput {
  nodeEnv: string
  /** `DATABASE_URL` as the operator set it; blank counts as unset. */
  rawDatabaseUrl: string | undefined
  devAuthUserId: string | undefined
  devAuthAccessKey: string | undefined
}

export interface ProductionGuardResult {
  /** Reasons the process must refuse to start. */
  errors: string[]
  /** Problems worth an operator's attention that do not stop startup. */
  warnings: string[]
}

/** The password older `compose.server.example.yml` files gave the database. */
const OLD_DEFAULT_DATABASE_PASSWORD = 'postgres'

/** Hosts that mean "this machine", where the old password is not reachable from elsewhere. */
const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

const ROTATION_DOCS = 'docs/deployment.md, "Rotating the database password"'

/**
 * Checks the environment for settings production must not run with.
 *
 * @returns the errors that must stop startup and the warnings to log; both empty outside production.
 */
export function checkProductionEnvironment(input: ProductionGuardInput): ProductionGuardResult {
  const result: ProductionGuardResult = { errors: [], warnings: [] }
  if (input.nodeEnv !== 'production') return result

  // Without this the schema's default URL, with its well-known credentials, would be used silently.
  const databaseUrl = input.rawDatabaseUrl?.trim()
  if (!databaseUrl) {
    result.errors.push('DATABASE_URL must be set in production; the built-in default is for development only.')
  } else if (usesOldDefaultPasswordRemotely(databaseUrl)) {
    result.warnings.push(
      'DATABASE_URL uses the password "postgres" that older PrintStream compose files set by default. '
        + `Rotate it: see ${ROTATION_DOCS}.`
    )
  }

  // The development sign-in replaces the credential ceremony; it has no place in production even
  // though its own check would also keep it off there.
  if (input.devAuthUserId?.trim() || input.devAuthAccessKey?.trim()) {
    result.errors.push('DEV_AUTH_USER_ID and DEV_AUTH_ACCESS_KEY are for development only; unset them in production.')
  }

  return result
}

/**
 * Whether a database URL authenticates with the old default password to a database on another
 * host. A Unix socket (`?host=/path`) or a loopback host is this machine; the native server's
 * embedded cluster is one of those by design. An unparseable URL is left to the database driver.
 */
function usesOldDefaultPasswordRemotely(databaseUrl: string): boolean {
  let url: URL
  try {
    url = new URL(databaseUrl)
  } catch {
    return false
  }

  if (decodeURIComponent(url.password) !== OLD_DEFAULT_DATABASE_PASSWORD) return false

  const socketHost = url.searchParams.get('host')
  if (socketHost?.startsWith('/')) return false

  return !LOCAL_DATABASE_HOSTS.has(url.hostname.toLowerCase())
}
