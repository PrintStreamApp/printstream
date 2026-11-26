/**
 * The one-line update status the About dialog shows (BRAND-8's "Updates" section).
 *
 * The web app has no "check for updates" action of its own: the server reports update state on
 * `GET /api/app/version` (the same query the footer reads), a hosted or Docker browser reloads into
 * a new build by itself (`lib/appStaleness.ts`), and the native server's in-place update is applied
 * from the footer's "Update available" chip. So this only describes the state, in the wording of
 * winui-app-kit's `kit.about.*` labels, and never offers a second way to apply an update.
 */
import type { AppVersionResponse } from '@printstream/shared'
import type { DisplayedAppBuild } from './appVersionDisplay'

export interface AboutUpdateStatus {
  /** The sentence to show. */
  message: string
  /** True when something newer exists than what this tab or server is running. */
  attention: boolean
}

/**
 * Describes the update state for the About dialog.
 *
 * @param serverBuild the `/api/app/version` response, or undefined while it is loading
 * @param displayedBuild the build this tab loaded (`resolveDisplayedAppBuild`)
 * @param reloadPending true when a newer web build is waiting for a safe automatic reload
 */
export function describeAboutUpdateStatus(
  serverBuild: AppVersionResponse | undefined,
  displayedBuild: DisplayedAppBuild,
  reloadPending: boolean
): AboutUpdateStatus {
  if (!serverBuild) {
    return { message: 'Checking for updates\u2026', attention: false }
  }

  if (displayedBuild.reloadRequired || reloadPending) {
    const version = displayedBuild.serverVersion ? `Version ${displayedBuild.serverVersion}` : 'A new version'
    return { message: `${version} is ready. PrintStream reloads into it automatically once nothing is open.`, attention: true }
  }

  const update = serverBuild.update
  if (update?.status === 'updateAvailable') {
    const build = update.latestShortRevision ? ` (build ${update.latestShortRevision})` : ''
    const how = serverBuild.canApplyUpdate
      ? ' Install it from "Update available" at the bottom of the page.'
      : ''
    return { message: `A newer version is available${build}.${how}`, attention: true }
  }
  if (update?.status === 'updatesLapsed') {
    return { message: 'A newer version is available, but this installation’s updates period has ended.', attention: true }
  }
  if (update?.status === 'unknown') {
    return { message: 'Couldn’t check for updates. Try again later.', attention: false }
  }

  return { message: 'You have the latest version.', attention: false }
}
