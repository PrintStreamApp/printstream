/**
 * Server tray: binds the self-hosted server identity and its status-file
 * location to the generic tray plumbing in `@printstream/sea-runtime` (runner,
 * login-autostart, and launcher entry). The tray runs in the desktop user's
 * session and polls the world-readable status file the running service writes,
 * so it never needs the SYSTEM-owned control socket. The menu's "Open
 * PrintStream" item is driven by the `appUrl` the service records in that file.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  installTrayAutostart as installTrayAutostartGeneric,
  installTrayLauncher as installTrayLauncherGeneric,
  runTray as runTrayGeneric,
  uninstallTrayAutostart as uninstallTrayAutostartGeneric,
  uninstallTrayLauncher as uninstallTrayLauncherGeneric,
  type TrayRunResult
} from '@printstream/sea-runtime'
import {
  resolveServerPaths,
  resolveServerServiceLogsDir,
  resolveServerServiceStatusFile,
  SERVER_IDENTITY
} from './app-identity.js'

export type { TrayRunResult }

/** Transient scheduled-task name used to launch the tray in the user session. */
export const SERVER_TRAY_LAUNCH_TASK = 'PrintStreamServerTrayLaunch'

/** Runs the tray icon, polling the service's status file for liveness + app URL. */
export function runServerTray(): Promise<TrayRunResult> {
  return runTrayGeneric({
    identity: SERVER_IDENTITY,
    statusFile: resolveServerServiceStatusFile(),
    logsDir: resolveServerServiceLogsDir()
  })
}

/** Registers the per-user login-autostart entry that starts the tray at login. */
export function installServerTrayAutostart(exePath: string): Promise<string> {
  return installTrayAutostartGeneric(SERVER_IDENTITY, exePath)
}

export function uninstallServerTrayAutostart(): Promise<void> {
  return uninstallTrayAutostartGeneric(SERVER_IDENTITY)
}

/** Adds a launcher entry (Start Menu / Applications) so the tray can be relaunched. */
export function installServerTrayLauncher(exePath: string): void {
  installTrayLauncherGeneric(SERVER_IDENTITY, exePath)
}

export function uninstallServerTrayLauncher(): void {
  uninstallTrayLauncherGeneric(SERVER_IDENTITY)
}

/**
 * The installed executable when present, else the running one. Autostart and the
 * tray must reference the installed copy, which outlives whatever downloads-folder
 * location the user double-clicked; before the service is installed, fall back to
 * the running executable.
 */
export function installedOrCurrentExePath(): string {
  const paths = resolveServerPaths()
  const installedExe = path.join(paths.installDir, paths.exeName)
  return existsSync(installedExe) ? installedExe : process.execPath
}
