/**
 * `@printstream/sea-runtime` — the generic, non-cloud plumbing shared by every
 * PrintStream Node SEA (single-file executable) build.
 *
 * This is **public/core** code (it ships in the open-source snapshot). The cloud
 * bridge's standalone build (`apps/bridge/src/private/sea/**`, private) and the
 * self-hosted native app build both consume it, so the two stay in lockstep
 * instead of hand-copying packaging logic. Anything specific to a particular
 * app — its identity, server defaults, update wiring, ffmpeg, docker migration —
 * stays in that app; this package holds only service/packaging primitives,
 * parameterized by a service spec and (where needed) injected asset accessors.
 *
 * It owns the config-file helper, the single-instance lock, the per-OS service
 * controllers, the loopback control channel, the app paths, and the tray
 * (assets, per-OS provider scripts, launcher + login-autostart wiring).
 */
export { parseConfigLines, readConfigFileValues, writeConfigFileValues } from './config-file.js'
export { acquireSingleInstanceLock } from './single-instance.js'

// Loopback control channel (named pipe / Unix socket); the provider is generic.
export { BridgeNotRunningError, requestControl, streamControl } from './control-client.js'
export { startControlServer } from './control-server.js'
export type { ControlProvider, ControlServerHandle } from './control-server.js'

// Tray: assets, per-OS provider scripts, and the orchestrators (spawn the tray,
// install launcher + login-autostart entries) — all parameterized by app identity.
export { trayIconIcoBuffer, trayIconPngBuffer, writeTrayIconFiles } from './tray/icons.js'
export type { TrayIconFiles } from './tray/icons.js'
export { generateWindowsTrayScript } from './tray/windows-tray.js'
export { generateLinuxTrayScript } from './tray/linux-tray.js'
export { runTray } from './tray/runner.js'
export type { RunTrayInput, TrayRunResult } from './tray/runner.js'
export {
  ensureWindowsTrayVbs,
  installTrayLauncher,
  uninstallTrayLauncher,
  windowsWscriptPath
} from './tray/launcher.js'
export { installTrayAutostart, uninstallTrayAutostart } from './tray/autostart.js'

// Windows UAC self-elevation, for the guided installer / uninstaller.
export {
  clearOwnMarkOfTheWeb,
  hideOwnConsoleWindow,
  launchTrayInUserSessionWindows,
  processIsElevated,
  promptWindowsUninstallChoice,
  relaunchSelfElevatedWindows,
  scheduleWindowsInstallDirCleanup
} from './windows-elevation.js'
export type { UninstallChoice } from './windows-elevation.js'

// Windows guided install/uninstall window, shared by the server and the bridge.
export { startSetupGui, setupGuiDiagnosticLogPath } from './setup-gui.js'
export type { SetupGui, SetupGuiOptions } from './setup-gui.js'

// Windows Add/Remove Programs (Settings → Apps) entry, shared by both apps.
export { registerWindowsUninstallEntry, removeWindowsUninstallEntry } from './windows-uninstall.js'
export type { WindowsUninstallEntry } from './windows-uninstall.js'

// Per-OS install/data layout primitives, parameterized by an app identity.
export type { StandaloneAppIdentity, StandalonePlatformContext } from './paths.js'
export {
  currentPlatformContext,
  platformPath,
  resolveStandaloneDataDir,
  resolveStandaloneInstallDir,
  standaloneControlSocket,
  standaloneExeName,
  standalonePlatformKey
} from './paths.js'

// Service plumbing — parameterized entirely by a ServiceSpec (and, for WinSW, an
// injected asset accessor); no app identity is baked in.
export type { ServiceSpec } from './service/spec.js'
export { runCommand, commandSucceeds } from './service/exec.js'
export type { RunCommandOptions } from './service/exec.js'
export { generateSystemdUnit, systemdUnitPath, systemdController } from './service/systemd.js'
export { escapeXml } from './service/xml.js'
export {
  WINSW_ASSET_KEY,
  createWinswController,
  generateWinswConfig,
  winswConfigPath,
  winswWrapperPath
} from './service/winsw.js'
export type { WinswControllerOptions } from './service/winsw.js'
