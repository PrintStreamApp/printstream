/**
 * Spawns and supervises the per-desktop tray provider. The providers are
 * self-contained scripts that read the app's world-readable status file (which
 * works without elevation, unlike the SYSTEM-owned control socket). This runner
 * only materializes the script + icon and waits for the child; the caller passes
 * the app identity and the resolved (privileged) status-file path.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { StandaloneAppIdentity } from '../paths.js'
import { acquireSingleInstanceLock } from '../single-instance.js'
import { writeTrayIconFiles } from './icons.js'
import { generateWindowsTrayScript } from './windows-tray.js'
import { generateLinuxTrayScript } from './linux-tray.js'

const TRAY_UNSUPPORTED_EXIT_CODE = 3

export interface TrayRunResult {
  /** True when the platform/desktop cannot show a tray icon. */
  unsupported: boolean
  exitCode: number
}

export interface RunTrayInput {
  identity: StandaloneAppIdentity
  /**
   * World-readable status file the provider polls. The tray runs as the desktop
   * user while the service that writes the file runs privileged, so the caller
   * resolves it at the service's (privileged) location.
   */
  statusFile: string
  /**
   * The service's log directory, opened by the tray's "View logs" item. Baked in
   * at launch (not read from the status file) so it works even when the service
   * is down — exactly when the operator needs the logs.
   */
  logsDir: string
}

export async function runTray(input: RunTrayInput): Promise<TrayRunResult> {
  // Single-instance guard: the tray can be launched several ways (guided setup,
  // login autostart, the Start Menu shortcut, or a reinstall while a prior one
  // is still running). Without this each spawns its own notification-area icon.
  // The lock lives in the per-user temp dir, so there is one tray per desktop
  // session; it is released when this process exits (i.e. when the tray quits).
  const lockPath = path.join(tmpdir(), `${input.identity.appId}-tray.lock`)
  if (!acquireSingleInstanceLock(lockPath)) {
    return { unsupported: false, exitCode: 0 }
  }

  const workDir = await mkdtemp(path.join(tmpdir(), `${input.identity.appId}-tray-`))
  try {
    const command = await prepareTrayCommand(workDir, input)
    if (!command) {
      return { unsupported: true, exitCode: TRAY_UNSUPPORTED_EXIT_CODE }
    }

    const exitCode = await new Promise<number>((resolve, reject) => {
      // windowsHide keeps the provider's console (PowerShell/wscript) from
      // allocating a visible window when the tray is launched from a session
      // with no console of its own — otherwise an empty window lingers.
      const child = spawn(command.executable, command.args, { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true })
      child.on('error', reject)
      child.on('exit', (code) => resolve(code ?? 0))
    })
    return { unsupported: exitCode === TRAY_UNSUPPORTED_EXIT_CODE, exitCode }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function prepareTrayCommand(
  workDir: string,
  input: RunTrayInput
): Promise<{ executable: string; args: string[] } | null> {
  const appName = input.identity.displayName
  const statusFile = input.statusFile
  const logsDir = input.logsDir
  // The trays launch the installed exe for the elevated "Update" item (and, on
  // Windows, Uninstall + self-exit once the install dir is gone).
  const exePath = process.execPath

  if (process.platform === 'win32') {
    const icons = await writeTrayIconFiles(workDir)
    const scriptPath = path.join(workDir, 'tray.ps1')
    await writeFile(scriptPath, generateWindowsTrayScript({ iconPath: icons.icoPath, statusFile, logsDir, appName, exePath }), 'utf8')
    return {
      executable: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath]
    }
  }

  if (process.platform === 'linux') {
    if (spawnSync('python3', ['--version'], { stdio: 'ignore' }).status !== 0) {
      return null
    }
    const icons = await writeTrayIconFiles(workDir)
    const scriptPath = path.join(workDir, 'tray.py')
    await writeFile(scriptPath, generateLinuxTrayScript({ iconPath: icons.pngPath, appName, statusFile, logsDir, exePath }), 'utf8')
    return { executable: 'python3', args: [scriptPath] }
  }

  return null
}
