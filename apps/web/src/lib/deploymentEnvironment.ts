/**
 * Which deployment the web app is running against, used to tag non-production
 * environments in the page title so an open tab is unmistakable.
 *
 * Derived at runtime (the same web build ships to every cloud stack and to OSS
 * self-hosters, so this cannot be baked at build time): the canonical cloud
 * staging/dev hostnames, plus `devMode` for local development. Everything else —
 * production cloud and self-hosters — is treated as production and gets no tag,
 * so a self-hoster's own `dev.*`/`staging.*` subdomain never picks up a label.
 */
export type DeploymentEnvironment = 'dev' | 'staging' | 'production'

const STAGING_HOST = 'staging.printstream.app'
const DEV_HOST = 'dev.printstream.app'

export function getDeploymentEnvironment(hostname: string, devMode: boolean): DeploymentEnvironment {
  if (hostname === STAGING_HOST) return 'staging'
  if (hostname === DEV_HOST) return 'dev'
  if (devMode) return 'dev'
  return 'production'
}

/** Page title for the environment, e.g. "[staging] PrintStream"; bare in production. */
export function buildDocumentTitle(environment: DeploymentEnvironment, baseTitle = 'PrintStream'): string {
  return environment === 'production' ? baseTitle : `[${environment}] ${baseTitle}`
}
