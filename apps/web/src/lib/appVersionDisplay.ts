/**
 * Resolves the build identity displayed by the browser footer.
 *
 * The package version is compiled into the web bundle, so it identifies the UI
 * this tab actually loaded. The API response identifies the server answering
 * now, which may already be newer while a safe automatic reload is pending.
 */
import type { AppVersionResponse } from '@printstream/shared'
import webPackage from '../../package.json'

export interface DisplayedAppBuild {
  version: string
  revision: string | null
  serverVersion: string | null
  reloadRequired: boolean
}

/**
 * Returns the loaded UI's version and an exact revision only when the server
 * still reports that same product version.
 */
export function resolveDisplayedAppBuild(
  serverBuild: AppVersionResponse | null | undefined
): DisplayedAppBuild {
  const version = webPackage.version
  const serverVersion = serverBuild?.version ?? null
  const reloadRequired = serverVersion !== null && serverVersion !== version

  return {
    version,
    revision: reloadRequired ? null : serverBuild?.revision ?? null,
    serverVersion,
    reloadRequired
  }
}
