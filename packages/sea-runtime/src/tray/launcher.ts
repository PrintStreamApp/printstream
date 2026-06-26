/**
 * OS "open the tray" launcher entry, so a user who quits the tray can start it
 * again the obvious way — a Start Menu shortcut (Windows) or an application-menu
 * `.desktop` entry (Linux). Both just run `<exe> tray run` in the user's session.
 * Installed by `installTrayLauncher` and removed by `uninstallTrayLauncher`.
 * Parameterized by the app identity.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { StandaloneAppIdentity } from '../paths.js'
import { runCommand } from '../service/exec.js'
import { trayIconIcoBuffer, trayIconPngBuffer } from './icons.js'

/** Creates the per-OS launcher entry for `<exe> tray run`. Best-effort. */
export function installTrayLauncher(identity: StandaloneAppIdentity, exePath: string): void {
  try {
    if (process.platform === 'win32') installWindowsLauncher(identity, exePath)
    else if (process.platform === 'linux') installLinuxLauncher(identity, exePath)
  } catch {
    // Launcher discoverability is polish; never fail an install over it.
  }
}

/** Removes the launcher entry created by installTrayLauncher. Best-effort. */
export function uninstallTrayLauncher(identity: StandaloneAppIdentity): void {
  try {
    if (process.platform === 'win32') {
      rmSync(windowsShortcutPath(identity), { force: true })
    } else if (process.platform === 'linux') {
      rmSync(linuxDesktopPath(identity), { force: true })
    }
  } catch {
    // Best-effort.
  }
}

function windowsShortcutPath(identity: StandaloneAppIdentity): string {
  const programData = process.env.ProgramData ?? 'C:\\ProgramData'
  return path.win32.join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${identity.displayName}.lnk`)
}

/**
 * Writes the hidden-launch VBScript (in the install dir) and returns its path.
 * `wscript` has no console of its own, and `Run(.., 0, False)` starts the
 * console-subsystem app hidden — so launching the tray never flashes a blank
 * window that, if the user closed it, would take the tray down with it. Shared
 * by the Start Menu shortcut and the login autostart.
 */
export function ensureWindowsTrayVbs(exePath: string): string {
  const vbsPath = path.win32.join(path.win32.dirname(exePath), 'tray-launch.vbs')
  writeFileSync(vbsPath, `CreateObject("WScript.Shell").Run """${exePath}"" tray run", 0, False\r\n`)
  return vbsPath
}

export function windowsWscriptPath(): string {
  return path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe')
}

function installWindowsLauncher(identity: StandaloneAppIdentity, exePath: string): void {
  const iconPath = path.win32.join(path.win32.dirname(exePath), 'app.ico')
  writeFileSync(iconPath, trayIconIcoBuffer())
  const vbsPath = ensureWindowsTrayVbs(exePath)
  const link = windowsShortcutPath(identity)
  const script = [
    '$ws = New-Object -ComObject WScript.Shell',
    `$sc = $ws.CreateShortcut('${psQuote(link)}')`,
    `$sc.TargetPath = '${psQuote(windowsWscriptPath())}'`,
    `$sc.Arguments = '//nologo "${psQuote(vbsPath)}"'`,
    `$sc.IconLocation = '${psQuote(iconPath)},0'`,
    `$sc.Description = '${psQuote(`Show the ${identity.displayName} tray icon`)}'`,
    '$sc.Save()'
  ].join('; ')
  runCommand('powershell', ['-NoProfile', '-Command', script], { allowFailure: true })
}

function linuxDesktopPath(identity: StandaloneAppIdentity): string {
  return `/usr/share/applications/${identity.appId}.desktop`
}

function installLinuxLauncher(identity: StandaloneAppIdentity, exePath: string): void {
  const iconPath = path.posix.join(path.posix.dirname(exePath), 'app.png')
  writeFileSync(iconPath, trayIconPngBuffer(), { mode: 0o644 })
  const entry = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${identity.displayName}`,
    `Comment=Show the ${identity.displayName} tray icon`,
    `Exec=${exePath} tray run`,
    `Icon=${iconPath}`,
    'Terminal=false',
    'Categories=Utility;',
    ''
  ].join('\n')
  mkdirSync('/usr/share/applications', { recursive: true })
  writeFileSync(linuxDesktopPath(identity), entry, { mode: 0o644 })
}

function psQuote(value: string): string {
  return value.replaceAll("'", "''")
}
