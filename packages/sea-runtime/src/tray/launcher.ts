/**
 * OS launcher entries, a Start Menu shortcut (Windows) or an application-menu
 * `.desktop` entry (Linux), each running one `<exe> <verb>` in the user's
 * session. Installed by `installTrayLauncher` and removed by
 * `uninstallTrayLauncher`. Parameterized by the app identity.
 *
 * An app may register SEVERAL entries, and the reason is what users expect from
 * an application menu: clicking the app's own name must open the app. The
 * self-hosted server installs a "PrintStream" entry that opens the web UI plus a
 * "PrintStream Tray" entry that brings the tray icon back: before that, the
 * only entry showed a tray icon, and a user who clicked "PrintStream" got what
 * looked like nothing happening.
 *
 * The bridge has no UI of its own and keeps the single tray entry, which is why
 * `entries` is optional rather than required.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { StandaloneAppIdentity } from '../paths.js'
import { runCommand } from '../service/exec.js'
import { trayIconIcoBuffer, trayIconPngBuffer } from './icons.js'

/** One application-menu entry. */
export interface TrayLauncherEntry {
  /**
   * Menu label, and the shortcut/desktop file's name. Defaults to the app's
   * display name, so the app's plain name is whichever entry omits this.
   */
  label?: string
  /** Menu tooltip / `Comment=`. */
  description: string
  /** Argv appended to the executable, e.g. `['tray', 'run']`. */
  args: string[]
  /**
   * Basename of the hidden-launch VBScript for this entry (Windows). Distinct
   * per argv, since each entry needs its own script.
   */
  vbsName: string
}

function defaultEntries(identity: StandaloneAppIdentity): TrayLauncherEntry[] {
  return [{
    description: `Show the ${identity.displayName} tray icon`,
    args: ['tray', 'run'],
    vbsName: TRAY_VBS_NAME
  }]
}

/** Creates the per-OS launcher entries. Best-effort. */
export function installTrayLauncher(
  identity: StandaloneAppIdentity,
  exePath: string,
  entries: TrayLauncherEntry[] = defaultEntries(identity)
): void {
  try {
    if (process.platform === 'win32') installWindowsLauncher(identity, exePath, entries)
    else if (process.platform === 'linux') installLinuxLauncher(identity, exePath, entries)
  } catch {
    // Launcher discoverability is polish; never fail an install over it.
  }
}

/** Removes the launcher entries created by installTrayLauncher. Best-effort. */
export function uninstallTrayLauncher(
  identity: StandaloneAppIdentity,
  entries: TrayLauncherEntry[] = defaultEntries(identity)
): void {
  for (const entry of entries) {
    try {
      if (process.platform === 'win32') {
        rmSync(windowsShortcutPath(identity, entry), { force: true })
      } else if (process.platform === 'linux') {
        rmSync(linuxDesktopPath(identity, entry), { force: true })
      }
    } catch {
      // Best-effort, and per entry: one failure must not strand the others.
    }
  }
}

function entryLabel(identity: StandaloneAppIdentity, entry: TrayLauncherEntry): string {
  return entry.label ?? identity.displayName
}

function windowsShortcutPath(identity: StandaloneAppIdentity, entry: TrayLauncherEntry): string {
  const programData = process.env.ProgramData ?? 'C:\\ProgramData'
  return path.win32.join(
    programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${entryLabel(identity, entry)}.lnk`
  )
}

/** The tray entry's script name; the login autostart points at this same file. */
const TRAY_VBS_NAME = 'tray-launch.vbs'

/**
 * Writes the hidden-launch VBScript for `<exe> tray run` and returns its path.
 * Shared by the tray's Start Menu shortcut and the login autostart.
 */
export function ensureWindowsTrayVbs(exePath: string): string {
  return ensureWindowsLaunchVbs(exePath, ['tray', 'run'], TRAY_VBS_NAME)
}

/**
 * Writes a hidden-launch VBScript (in the install dir) and returns its path.
 * `wscript` has no console of its own, and `Run(.., 0, False)` starts the
 * console-subsystem app hidden, so launching from the Start Menu never flashes
 * a blank window that, if the user closed it, would take the launched process
 * down with it.
 *
 * One script per argv: `vbsName` must differ between entries, or the last
 * install wins and both shortcuts run the same verb.
 */
export function ensureWindowsLaunchVbs(exePath: string, args: string[], vbsName: string): string {
  const vbsPath = path.win32.join(path.win32.dirname(exePath), vbsName)
  const commandLine = [`""${exePath}""`, ...args].join(' ')
  const contents = `CreateObject("WScript.Shell").Run "${commandLine}", 0, False\r\n`

  // Idempotent, and that is the point rather than an optimisation. Setup reaches
  // here from three places (Start Menu shortcut, login autostart, and the tray
  // launch itself), and one of them runs `wscript` against this very file. A
  // rewrite landing while wscript opens the script fails it with
  // ERROR_SHARING_VIOLATION (0x80070020), which the user sees as a Windows
  // Script Host dialog thrown over the installer. Not writing when nothing
  // changed removes the race for every call after the first.
  try {
    if (readFileSync(vbsPath, 'utf8') === contents) return vbsPath
  } catch {
    // Missing or unreadable: fall through and write it.
  }

  // Write to a temp name and rename into place, so the path wscript opens is
  // never the path being written. `renameSync` is MoveFileEx with
  // replace-existing: a reader sees the old file or the new one, never a
  // half-written one.
  const tempPath = `${vbsPath}.${process.pid}.tmp`
  writeFileSync(tempPath, contents)
  try {
    renameSync(tempPath, vbsPath)
  } catch (error) {
    rmSync(tempPath, { force: true })
    throw error
  }
  return vbsPath
}

export function windowsWscriptPath(): string {
  return path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe')
}

function installWindowsLauncher(
  identity: StandaloneAppIdentity, exePath: string, entries: TrayLauncherEntry[]
): void {
  const iconPath = path.win32.join(path.win32.dirname(exePath), 'app.ico')
  writeFileSync(iconPath, trayIconIcoBuffer())
  for (const entry of entries) {
    const vbsPath = ensureWindowsLaunchVbs(exePath, entry.args, entry.vbsName)
    const script = buildShortcutScript(
      windowsShortcutPath(identity, entry), windowsWscriptPath(), vbsPath, iconPath, entry.description
    )
    runCommand('powershell', ['-NoProfile', '-Command', script], { allowFailure: true })
  }
}

/** Exported so CI can parse it: this is PowerShell that nothing else checks. */
export function buildShortcutScript(
  link: string, wscript: string, vbsPath: string, iconPath: string, description: string
): string {
  return [
    '$ws = New-Object -ComObject WScript.Shell',
    `$sc = $ws.CreateShortcut('${psQuote(link)}')`,
    `$sc.TargetPath = '${psQuote(wscript)}'`,
    `$sc.Arguments = '//nologo //B "${psQuote(vbsPath)}"'`,
    `$sc.IconLocation = '${psQuote(iconPath)},0'`,
    `$sc.Description = '${psQuote(description)}'`,
    '$sc.Save()'
  ].join('; ')
}

function linuxDesktopPath(identity: StandaloneAppIdentity, entry: TrayLauncherEntry): string {
  // The app's own name keeps the bare appId, so an upgrade replaces the file
  // that is already there rather than leaving a stale duplicate beside it.
  const suffix = entry.label ? `-${entry.args.join('-')}` : ''
  return `/usr/share/applications/${identity.appId}${suffix}.desktop`
}

function installLinuxLauncher(
  identity: StandaloneAppIdentity, exePath: string, entries: TrayLauncherEntry[]
): void {
  const iconPath = path.posix.join(path.posix.dirname(exePath), 'app.png')
  writeFileSync(iconPath, trayIconPngBuffer(), { mode: 0o644 })
  mkdirSync('/usr/share/applications', { recursive: true })
  for (const entry of entries) {
    const desktopEntry = [
      '[Desktop Entry]',
      'Type=Application',
      `Name=${entryLabel(identity, entry)}`,
      `Comment=${entry.description}`,
      `Exec=${exePath} ${entry.args.join(' ')}`,
      `Icon=${iconPath}`,
      'Terminal=false',
      'Categories=Utility;',
      ''
    ].join('\n')
    writeFileSync(linuxDesktopPath(identity, entry), desktopEntry, { mode: 0o644 })
  }
}

function psQuote(value: string): string {
  return value.replaceAll("'", "''")
}
