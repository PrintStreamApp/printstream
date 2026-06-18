/**
 * Per-user autostart entries that launch `<exe> tray run` at desktop login: XDG
 * autostart on Linux and the HKCU Run key on Windows. These are user-level — no
 * elevation needed. Parameterized by the app identity.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { StandaloneAppIdentity } from '../paths.js'
import { runCommand } from '../service/exec.js'
import { ensureWindowsTrayVbs, windowsWscriptPath } from './launcher.js'

const WINDOWS_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

/** Stable HKCU Run value name derived from the app's display name. */
function windowsRunValue(identity: StandaloneAppIdentity): string {
  return `${identity.displayName.replace(/\s+/g, '')}Tray`
}

export async function installTrayAutostart(identity: StandaloneAppIdentity, exePath: string): Promise<string> {
  if (process.platform === 'linux') {
    const entryPath = linuxAutostartPath(identity)
    await mkdir(path.dirname(entryPath), { recursive: true })
    await writeFile(entryPath, `[Desktop Entry]
Type=Application
Name=${identity.displayName} Tray
Comment=Status icon for the local ${identity.displayName}
Exec=${desktopExecQuote(exePath)} tray run
Terminal=false
X-GNOME-Autostart-enabled=true
`, 'utf8')
    return entryPath
  }

  if (process.platform === 'win32') {
    // Launch hidden via wscript so login does not flash a console window.
    const vbsPath = ensureWindowsTrayVbs(exePath)
    runCommand('reg', ['add', WINDOWS_RUN_KEY, '/v', windowsRunValue(identity), '/t', 'REG_SZ', '/d', `"${windowsWscriptPath()}" //nologo "${vbsPath}"`, '/f'])
    return `${WINDOWS_RUN_KEY}\\${windowsRunValue(identity)}`
  }

  throw new Error(`Tray autostart is not supported on ${process.platform}.`)
}

export async function uninstallTrayAutostart(identity: StandaloneAppIdentity): Promise<void> {
  if (process.platform === 'linux') {
    await rm(linuxAutostartPath(identity), { force: true })
    return
  }
  if (process.platform === 'win32') {
    runCommand('reg', ['delete', WINDOWS_RUN_KEY, '/v', windowsRunValue(identity), '/f'], { allowFailure: true })
    return
  }
  throw new Error(`Tray autostart is not supported on ${process.platform}.`)
}

function linuxAutostartPath(identity: StandaloneAppIdentity): string {
  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? '/', '.config')
  return path.join(configHome, 'autostart', `${identity.appId}-tray.desktop`)
}

function desktopExecQuote(value: string): string {
  return /[\s"']/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value
}
