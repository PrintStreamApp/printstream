/**
 * Windows "Add or Remove Programs" (Settings → Apps) integration, shared by the
 * self-hosted server and the standalone bridge so each appears there with its
 * logo and a working uninstall. The entry's UninstallString points at the
 * *installed* copy of the exe, which persists after the downloaded installer is
 * gone. Registry writes go through PowerShell because `reg.exe` quoting for
 * paths-with-spaces is fragile. Requires admin (called from the elevated
 * service install).
 */
import { runCommand } from './service/exec.js'

function psQuote(value: string): string {
  return value.replaceAll("'", "''")
}

function uninstallKey(appId: string): string {
  return `HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${appId}`
}

export interface WindowsUninstallEntry {
  /** Registry sub-key + matches the app id used elsewhere. */
  appId: string
  displayName: string
  /** Shown as the version in Settings → Apps. */
  version: string
  /** Installed exe; both the UninstallString target and the icon source. */
  exePath: string
  installLocation: string
  publisher?: string
  /** Register a QuietUninstallString (`<exe> uninstall --quiet`) for silent removal. */
  supportsQuiet?: boolean
}

/** Registers (or refreshes) the Add/Remove Programs entry. Requires admin. */
export function registerWindowsUninstallEntry(entry: WindowsUninstallEntry): void {
  const set = (name: string, value: string, type = 'String'): string =>
    `Set-ItemProperty -Path $k -Name '${name}' -Type ${type} -Value '${psQuote(value)}'`
  const lines = [
    `$k = '${uninstallKey(entry.appId)}'`,
    'New-Item -Path $k -Force | Out-Null',
    set('DisplayName', entry.displayName),
    set('DisplayVersion', entry.version),
    set('Publisher', entry.publisher ?? 'PrintStream'),
    // `,0` pins the first embedded icon group so the app logo (carried by the
    // exe's branding) shows instead of a generic icon.
    set('DisplayIcon', `${entry.exePath},0`),
    set('InstallLocation', entry.installLocation),
    set('UninstallString', `"${entry.exePath}" uninstall`),
    ...(entry.supportsQuiet ? [set('QuietUninstallString', `"${entry.exePath}" uninstall --quiet`)] : []),
    set('NoModify', '1', 'DWord'),
    set('NoRepair', '1', 'DWord')
  ]
  runCommand('powershell', ['-NoProfile', '-Command', lines.join('; ')], { allowFailure: true })
}

/** Removes the Add/Remove Programs entry. Best-effort. */
export function removeWindowsUninstallEntry(appId: string): void {
  runCommand('powershell', [
    '-NoProfile',
    '-Command',
    `Remove-Item -Path '${uninstallKey(appId)}' -Recurse -Force -ErrorAction SilentlyContinue`
  ], { allowFailure: true })
}
