/**
 * Guided first run: the experience when the executable is launched with no
 * command (e.g. double-clicked). It installs the app as a **background OS
 * service** (so it survives reboots and never sits in a foreground terminal
 * window), starts the notification-area tray, then opens the browser to the
 * local app once it is serving — the same shape as the cloud bridge's guided
 * setup, minus the connect code (a self-hosted server just opens its own UI).
 *
 * Installing the service needs admin, so this self-elevates: a UAC relaunch on
 * Windows, a GUI password prompt (pkexec, falling back to sudo) on Linux. From
 * source (unpackaged), where there is no service to install, it falls back to
 * running the stack in the foreground and opening the browser.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import {
  clearOwnMarkOfTheWeb,
  currentPlatformContext,
  ensureWindowsTrayVbs,
  launchTrayInUserSessionWindows,
  processIsElevated,
  relaunchSelfElevatedWindows,
  runCommand,
  startSetupGui,
  trayIconPngBuffer,
  windowsWscriptPath,
  type SetupGui
} from '@printstream/sea-runtime'
import { resolveServerPaths, resolveServerServiceLogsDir, resolveServerServiceStatusFile, SERVER_IDENTITY } from './app-identity.js'
import { applyConfigFile, resolvePort } from './config.js'
import { isSeaPackaged } from './packaged.js'
import { openBrowser } from './open-browser.js'
import { runServer } from './run.js'
import { controlServerService, installServerService } from './service.js'
import type { ServerStatus } from './status.js'
import { installServerTrayAutostart, installedOrCurrentExePath, SERVER_TRAY_LAUNCH_TASK } from './tray.js'

const STATUS_POLL_TIMEOUT_MS = 180_000
const STATUS_POLL_INTERVAL_MS = 1_000

export interface GuidedSetupInput {
  /** Set on the relaunched child after a Windows UAC elevation. */
  elevated: boolean
}

export async function runSetup(input: GuidedSetupInput = { elevated: false }): Promise<void> {
  // Windows (packaged) drives a **user-level** GUI window that elevates only the
  // privileged install as a separate child it monitors. The window must run
  // unelevated: an elevated host process forces its WinForms form hidden (the
  // SW_HIDE of the hidden elevation relaunch propagates to the child), so the
  // window would never appear. Everything else keeps the console flow.
  if (process.platform === 'win32' && isSeaPackaged() && !input.elevated) {
    await runWindowsGuiSetup()
    return
  }
  // The double-click experience must never just flash and vanish: surface any
  // failure and keep the window open so the operator can read it.
  try {
    await runSetupSteps(input, null)
  } catch (error) {
    console.error('')
    console.error(`Setup did not complete: ${error instanceof Error ? error.message : String(error)}`)
    console.error('Install manually from an elevated terminal instead:')
    console.error(`  "${process.execPath}" service install`)
    process.exitCode = 1
    await waitForEnterWhenInteractive()
  }
}

/**
 * Windows guided setup, GUI-first. The window runs at user level (so it shows),
 * elevates only the install/start as a separate child, then reflects progress by
 * polling the service status and tailing its log into the output box.
 */
async function runWindowsGuiSetup(): Promise<void> {
  // No hideOwnConsoleWindow here: the packaged exe is GUI-subsystem, so a
  // double-click never gets a console in the first place.
  clearOwnMarkOfTheWeb()
  const gui = startSetupGui({
    appId: SERVER_IDENTITY.appId,
    appName: SERVER_IDENTITY.displayName,
    logoPng: trayIconPngBuffer(),
    logsDir: resolveServerServiceLogsDir(),
    title: `Setting up ${SERVER_IDENTITY.displayName}`,
    readyText: `${SERVER_IDENTITY.displayName} is ready`,
    showOpen: true
  })
  if (!gui) {
    // The window could not start — fall back to the console flow.
    await runSetupSteps({ elevated: false }, null)
    return
  }
  try {
    const status = readServiceStatus()
    if (statusMeansInstalled(status)) {
      if (statusMeansRunning(status)) {
        gui.phase(`${SERVER_IDENTITY.displayName} is already installed and running.`)
      } else {
        gui.phase('Starting the service — approve the administrator prompt…')
        // Let the user see the window (and the reason) before the UAC prompt.
        await gui.whenVisible()
        if (!relaunchSelfElevatedWindows(['service', 'start'], { hidden: true })) {
          gui.fail('Administrator access is required to start the service.')
          return
        }
      }
    } else {
      gui.phase('Installing — approve the administrator prompt…')
      // Let the user see the window (and the reason) before the UAC prompt.
      await gui.whenVisible()
      if (!relaunchSelfElevatedWindows(['service', 'install'], { hidden: true })) {
        gui.fail(`Administrator access is required to install ${SERVER_IDENTITY.displayName}.`)
        return
      }
    }
    gui.phase('Setting up the background service and database (first run can take a minute)…')
    const appStatus = await pollServiceStatusForGui(gui)
    const url = appStatus?.appUrl ?? `http://localhost:${resolvePort()}`
    if (appStatus) {
      // The install (and its exe copy) is done; register the tray from the
      // installed copy at user level.
      installTrayBestEffort(false)
      gui.highlight(url)
      gui.log('')
      gui.log(`Setup complete — ${SERVER_IDENTITY.displayName} is running at ${url}`)
      gui.log(
        `Tip: the ${SERVER_IDENTITY.displayName} icon now lives in your system tray (next to the clock — ` +
          'click the ^ arrow to show hidden icons). Use it to open the app, check status, or stop the service.'
      )
      gui.done(url)
    } else {
      gui.fail(`The app has not come up yet — it should be available shortly at ${url}. See View logs for details.`)
    }
  } catch (error) {
    gui.fail(error instanceof Error ? error.message : String(error))
  } finally {
    // GUI-subsystem: this process must stay alive while the window is open (the
    // window is its child), so the operator can read the result and click Open.
    await gui.wait()
  }
}

/** Polls the service status while streaming its boot log into the setup window. */
async function pollServiceStatusForGui(gui: SetupGui): Promise<ServerStatus | null> {
  const statusFile = resolveServerServiceStatusFile()
  const outLog = path.join(resolveServerServiceLogsDir(), `${SERVER_IDENTITY.appId}-service.out.log`)
  let seen = 0
  const deadline = Date.now() + STATUS_POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const lines = readFileSync(outLog, 'utf8').split(/\r?\n/)
      for (const line of lines.slice(seen)) {
        if (line.trim()) gui.log(line)
      }
      seen = lines.length
    } catch {
      // The service log is not there yet; keep polling.
    }
    const status = readServiceStatusFile(statusFile)
    if (status && statusIsLive(status)) return status
    await delay(STATUS_POLL_INTERVAL_MS)
  }
  return null
}

async function runSetupSteps(input: GuidedSetupInput, gui: SetupGui | null): Promise<void> {
  console.log(`${SERVER_IDENTITY.displayName} setup`)
  console.log('')

  // From source there is no installable service: run the stack in the foreground
  // and open the browser, the original zero-friction dev path.
  if (!isSeaPackaged()) {
    await runForeground()
    return
  }

  const platform = currentPlatformContext().platform
  // Strip our own "downloaded from the internet" mark before any elevation:
  // SmartScreen/UAC refuse to elevate a marked executable (the relaunch comes
  // back as "operation cancelled by the user" with no prompt), and this
  // non-elevated process owns its own file so it can clear the mark itself.
  if (platform === 'win32') clearOwnMarkOfTheWeb()

  const serviceStatus = readServiceStatus()
  if (statusMeansInstalled(serviceStatus)) {
    // Starting a stopped service needs admin too; elevate first on Windows so the
    // start does not silently fail. An already-running service skips this so a
    // bare launch (just to open the app) never prompts for UAC.
    if (!statusMeansRunning(serviceStatus) && platform === 'win32' && !processIsElevated()) {
      if (relaunchSelfElevatedWindows(['setup', '--elevated'], { hidden: true })) {
        console.log('Approve the administrator prompt to start the service…')
        return
      }
      printManualElevationHelp('start')
      await waitForEnterWhenInteractive()
      return
    }
    console.log('The service is already installed; making sure it is running…')
    gui?.phase('Starting the service…')
    try {
      controlServerService('start')
    } catch {
      // Already running (or the controller reports start for a running service
      // as an error); the status readout tells the real story.
    }
    await finishInteractiveSetup(input, gui)
    return
  }

  if (platform === 'win32' && !processIsElevated()) {
    if (relaunchSelfElevatedWindows(['setup', '--elevated'], { hidden: true })) {
      console.log('Approve the administrator prompt to install the service…')
      return
    }
    printManualElevationHelp('install')
    await waitForEnterWhenInteractive()
    return
  }
  if (platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0) {
    // Linux: pkexec shows a graphical password prompt on a desktop session. On a
    // headless host it is absent, so fall back to a clear sudo instruction.
    console.log('Installing the service (you may be asked for your password)…')
    if (relaunchPrivilegedOnLinux()) {
      await finishInteractiveSetup(input, gui)
      return
    }
    console.error('Setup needs administrator access to install the system service. Re-run with sudo:')
    console.error(`  sudo "${process.execPath}" setup`)
    process.exitCode = 1
    return
  }

  console.log('Installing the service…')
  gui?.phase('Installing the background service…')
  const result = await installServerService({})
  console.log(`Service installed and started (executable: ${result.exePath}).`)
  await finishInteractiveSetup(input, gui)
}

/** Foreground fallback for unpackaged (dev) runs: serve + open browser. */
async function runForeground(): Promise<void> {
  await applyConfigFile(resolveServerPaths())
  const url = `http://localhost:${resolvePort()}`
  console.log(`Starting ${SERVER_IDENTITY.displayName} — it will open ${url} in your browser when ready.`)
  void openWhenHealthy(url)
  await runServer()
}

/** Post-install polish: start the tray, wait for the app, hand off to open it. */
async function finishInteractiveSetup(input: GuidedSetupInput, gui: SetupGui | null): Promise<void> {
  installTrayBestEffort(input.elevated)

  console.log('Waiting for the app to come up…')
  gui?.phase('Waiting for the app to come up (first run initializes the database)…')
  const status = await pollServiceStatus()
  console.log('')
  const url = status?.appUrl ?? `http://localhost:${resolvePort()}`

  // GUI flow (elevated Windows install): the window owns the rest — it shows
  // completion and the Open button; the console is hidden, so don't prompt here.
  if (gui) {
    if (status) gui.done(url)
    else gui.fail(`The app has not reported in yet. It should be available shortly at ${url} — open it from the tray.`)
    return
  }

  if (status) {
    console.log(`${SERVER_IDENTITY.displayName} is running at ${url}.`)
  } else {
    console.log(`The app has not reported in yet, but it should be available shortly at ${url}.`)
  }
  console.log('It keeps running in the background as a service — use the tray icon to open it anytime.')
  await promptEnterToOpen(url)
}

/**
 * Final step of guided setup: rather than opening the browser unprompted, wait
 * for the operator to press Enter and then open the app (they can close the
 * window instead to skip). Non-interactive runs (no TTY) just print the URL and
 * never block.
 */
async function promptEnterToOpen(url: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`Open ${url} in your browser to get started.`)
    return
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  await new Promise<void>((resolve) => rl.question(`\nPress Enter to open ${url} in your browser (or just close this window)…`, () => resolve()))
  rl.close()
  openBrowser(url)
}

/** Reads the installed service's controller status, or null if it cannot. */
function readServiceStatus(): string | null {
  try {
    const status = controlServerService('status')
    return typeof status === 'string' ? status : null
  } catch {
    return null
  }
}

/**
 * Controller status strings that mean the service is absent. The controllers
 * query with `allowFailure`, so a missing service yields one of these strings
 * (WinSW `NonExistent`, the shared `not-installed` fallback) rather than
 * throwing — detection inspects the text.
 */
const NOT_INSTALLED_STATUS_MARKERS = ['nonexistent', 'not-installed']

export function statusMeansInstalled(status: string | null | undefined): boolean {
  if (!status) return false
  const normalized = status.trim().toLowerCase()
  return normalized.length > 0 && !NOT_INSTALLED_STATUS_MARKERS.some((marker) => normalized.includes(marker))
}

export function statusMeansRunning(status: string | null | undefined): boolean {
  if (!status) return false
  const normalized = status.trim().toLowerCase()
  return normalized.includes('running') || normalized === 'active'
}

/** Manual fallback shown when automatic elevation does not happen. */
function printManualElevationHelp(action: 'install' | 'start'): void {
  console.log('')
  console.log(`Could not get administrator access automatically to ${action} the service`)
  console.log('(Windows declined the elevation request). Do one of these instead:')
  console.log('  - right-click the executable and choose "Run as administrator", or')
  console.log(`  - run this in an elevated PowerShell:  & "${process.execPath}" service ${action}`)
}

/**
 * Installs the service via pkexec (a graphical polkit prompt on desktop Linux).
 * Returns false when pkexec is missing or the prompt is declined/unavailable, so
 * the caller can fall back to a sudo instruction.
 */
function relaunchPrivilegedOnLinux(): boolean {
  return runCommand('pkexec', [process.execPath, 'service', 'install'], { allowFailure: true }) !== null
}

function installTrayBestEffort(elevated: boolean): void {
  void (async () => {
    const exe = installedOrCurrentExePath()
    // Register login autostart and start the tray now as two independent
    // best-effort steps: a failure to register must not stop the tray showing.
    try {
      await installServerTrayAutostart(exe)
    } catch {
      // Login autostart is best-effort; the immediate launch still shows the tray.
    }
    try {
      if (process.platform === 'win32') {
        // Launch the tray through a hidden-window VBScript (`wscript
        // <launcher.vbs>`) so nothing flashes when the user's session starts it.
        const launch = resolveWindowsTrayLaunch(exe)
        // A tray icon must run in the user's session, not elevated — an admin tray
        // icon frequently fails to appear in the notification area. When this setup
        // is the elevated relaunch, hand the launch back to the user session via a
        // one-shot scheduled task; a direct spawn would inherit elevation.
        if (elevated && launchTrayInUserSessionWindows(launch.execute, launch.argument, SERVER_TRAY_LAUNCH_TASK)) {
          return
        }
        spawn(launch.execute, launch.args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
        return
      }
      spawn(exe, ['tray', 'run'], { detached: true, stdio: 'ignore' }).unref()
    } catch {
      // Tray support is desktop-dependent polish; the CLI status covers it.
    }
  })()
}

/**
 * Resolves how to start the Windows tray hidden. Preferred: `wscript
 * tray-launch.vbs`, which runs the console exe with no window. The VBS is
 * written into the install dir at service-install time; if it is missing and
 * cannot be (re)written (e.g. an unelevated bare launch), fall back to running
 * the exe directly (windowsHide still suppresses its console for the direct
 * spawn; the scheduled-task path then just shows a brief console).
 */
function resolveWindowsTrayLaunch(exe: string): { execute: string; argument: string; args: string[] } {
  const wscript = windowsWscriptPath()
  const useVbs = (vbsPath: string) => ({ execute: wscript, argument: `//nologo "${vbsPath}"`, args: ['//nologo', vbsPath] })
  const existing = path.join(path.dirname(exe), 'tray-launch.vbs')
  if (existsSync(existing)) return useVbs(existing)
  try {
    return useVbs(ensureWindowsTrayVbs(exe))
  } catch {
    return { execute: exe, argument: 'tray run', args: ['tray', 'run'] }
  }
}

/** Polls the service's status file until the app reports it is up. */
async function pollServiceStatus(): Promise<ServerStatus | null> {
  const statusFile = resolveServerServiceStatusFile()
  const deadline = Date.now() + STATUS_POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    const status = readServiceStatusFile(statusFile)
    if (status && statusIsLive(status)) return status
    await delay(STATUS_POLL_INTERVAL_MS)
  }
  return null
}

function readServiceStatusFile(statusFile: string): ServerStatus | null {
  try {
    return JSON.parse(readFileSync(statusFile, 'utf8')) as ServerStatus
  } catch {
    return null
  }
}

function statusIsLive(status: ServerStatus): boolean {
  try {
    process.kill(status.pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Polls the health endpoint until the foreground server is up, then opens it. */
async function openWhenHealthy(url: string): Promise<void> {
  const healthUrl = `${url}/api/health`
  for (let attempt = 0; attempt < 360; attempt += 1) {
    try {
      const response = await fetch(healthUrl)
      if (response.ok) {
        openBrowser(url)
        return
      }
    } catch {
      // Not listening yet.
    }
    await delay(500)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * A double-clicked console app on Windows owns a console window that closes the
 * moment the process exits — hold it open so the user can read the summary. Only
 * interactive runs wait; service/scripted runs never do.
 */
async function waitForEnterWhenInteractive(): Promise<void> {
  if (process.platform !== 'win32' || !process.stdin.isTTY || !process.stdout.isTTY) return
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  await new Promise<void>((resolve) => rl.question('\nPress Enter to close this window…', () => resolve()))
  rl.close()
}
