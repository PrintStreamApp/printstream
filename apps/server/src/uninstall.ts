/**
 * Full uninstall of the self-hosted server, runnable from the installed copy
 * (so it works after the downloaded installer is gone): removes the OS service
 * and the per-user tray entries, and optionally purges the data dir. Reachable
 * from the tray menu's "Uninstall" item or `printstream uninstall`.
 *
 * Removing a machine-wide service needs admin, but the tray launches us
 * unelevated. On packaged Windows this drives the same window as install (a
 * user-level GUI that elevates the teardown as a child, since an elevated
 * hidden-relaunched host cannot show a form); elsewhere it self-elevates and
 * runs on the console. The install dir holds the running executable, so it is
 * removed by a detached post-exit cleanup rather than asking the operator to
 * delete it.
 */
import { rm } from 'node:fs/promises'
import {
  clearOwnMarkOfTheWeb,
  currentPlatformContext,
  processIsElevated,
  promptWindowsUninstallChoice,
  relaunchSelfElevatedWindows,
  scheduleWindowsInstallDirCleanup,
  startSetupGui,
  trayIconPngBuffer
} from '@printstream/sea-runtime'
import { resolveServerPaths, resolveServerServiceLogsDir, SERVER_IDENTITY } from './app-identity.js'
import { isSeaPackaged } from './packaged.js'
import { controlServerService, uninstallServerService } from './service.js'
import { statusMeansInstalled } from './setup.js'

export interface UninstallOptions {
  /** Also delete the data dir (config, embedded database, library). */
  purge: boolean
  /** Set on the elevated relaunch so it does not loop. */
  elevated: boolean
}

export async function runUninstall(options: UninstallOptions): Promise<void> {
  const context = currentPlatformContext()
  const paths = resolveServerPaths(context)

  // Packaged Windows, not yet elevated: show the GUI and elevate the teardown.
  if (context.platform === 'win32' && isSeaPackaged() && !options.elevated && !processIsElevated()) {
    await runWindowsGuiUninstall(options)
    return
  }

  if (context.platform === 'win32' && !options.elevated && !processIsElevated()) {
    const relaunchArgs = ['uninstall', '--elevated', ...(options.purge ? ['--purge'] : [])]
    if (relaunchSelfElevatedWindows(relaunchArgs)) {
      console.log('Continuing the uninstall in an elevated window…')
      return
    }
    console.error('Could not get administrator access to uninstall automatically.')
    console.error(`Run this from an elevated PowerShell instead:  & "${process.execPath}" uninstall`)
    process.exitCode = 1
    return
  }

  try {
    // Tears down the service and, with it, the tray launcher + autostart entries.
    await uninstallServerService()
  } catch {
    // The service may already be gone; keep tearing the rest down.
  }

  if (options.purge) {
    try {
      await rm(paths.dataDir, { recursive: true, force: true })
    } catch {
      // Best-effort.
    }
  }

  // The install dir holds the running exe; remove it for the operator instead of
  // asking them to. Windows cannot delete a locked, running exe in-process, so
  // schedule a detached post-exit cleanup; elsewhere remove it directly.
  if (context.platform === 'win32') {
    scheduleWindowsInstallDirCleanup(paths.installDir, SERVER_IDENTITY.appId)
  } else {
    try {
      await rm(paths.installDir, { recursive: true, force: true })
    } catch {
      // Best-effort.
    }
  }

  console.log(
    `${SERVER_IDENTITY.displayName} has been uninstalled${options.purge ? ' and its data removed' : ' (your data was kept)'}.`
  )
}

/**
 * Windows uninstall, GUI-first. The window runs at user level (so it shows) and
 * elevates the actual teardown as a separate `uninstall --elevated` child, then
 * reflects progress by polling until the service is gone — the mirror image of
 * the install flow.
 */
async function runWindowsGuiUninstall(options: UninstallOptions): Promise<void> {
  clearOwnMarkOfTheWeb()
  // Ask whether to keep or delete data unless the caller already forced --purge.
  let purge = options.purge
  if (!purge) {
    const choice = promptWindowsUninstallChoice(SERVER_IDENTITY.displayName)
    if (choice === 'cancel') return
    purge = choice === 'purge'
  }
  const gui = startSetupGui({
    appId: SERVER_IDENTITY.appId,
    appName: SERVER_IDENTITY.displayName,
    logoPng: trayIconPngBuffer(),
    logsDir: resolveServerServiceLogsDir(),
    title: `Uninstalling ${SERVER_IDENTITY.displayName}`,
    readyText: `${SERVER_IDENTITY.displayName} has been removed`,
    showOpen: false
  })
  if (!gui) {
    // The window could not start — fall back to elevating the console teardown.
    const relaunchArgs = ['uninstall', '--elevated', ...(purge ? ['--purge'] : [])]
    if (!relaunchSelfElevatedWindows(relaunchArgs)) {
      console.error('Could not get administrator access to uninstall automatically.')
      process.exitCode = 1
    }
    return
  }
  try {
    gui.phase(
      purge
        ? 'Removing the service and deleting all data, including library files — approve the administrator prompt…'
        : 'Removing the service (your data will be kept) — approve the administrator prompt…'
    )
    // Let the user see the window (and the reason) before the UAC prompt.
    await gui.whenVisible()
    const relaunchArgs = ['uninstall', '--elevated', ...(purge ? ['--purge'] : [])]
    if (!relaunchSelfElevatedWindows(relaunchArgs, { hidden: true })) {
      gui.fail(`Administrator access is required to uninstall ${SERVER_IDENTITY.displayName}.`)
      return
    }
    gui.phase('Removing…')
    if (await pollServiceGoneForGui()) {
      gui.log(`${SERVER_IDENTITY.displayName} has been removed. The program folder is being cleaned up automatically.`)
      gui.done()
    } else {
      gui.fail('The service did not report as removed in time. Check Windows Services, or try again.')
    }
  } catch (error) {
    gui.fail(error instanceof Error ? error.message : String(error))
  } finally {
    // GUI-subsystem: stay alive while the window is open (it is this process's
    // child) so the operator can read the result.
    await gui.wait()
  }
}

/** Polls the service controller until the service no longer exists, with a cap. */
async function pollServiceGoneForGui(): Promise<boolean> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    let status: string | null = null
    try {
      status = controlServerService('status') ?? null
    } catch {
      status = null
    }
    if (!statusMeansInstalled(status)) return true
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  return false
}
