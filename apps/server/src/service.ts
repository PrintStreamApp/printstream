/**
 * Server-side service orchestration: builds the server's `ServiceSpec` and
 * dispatches to the generic per-OS controllers in `@printstream/sea-runtime`
 * (systemd / WinSW). The controllers are app-agnostic; the spec, executable
 * copy, and config persistence are what is specific to this app — the same
 * split the cloud bridge uses for its own `service/index`.
 */
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  WINSW_ASSET_KEY,
  createWinswController,
  currentPlatformContext,
  platformPath,
  registerWindowsUninstallEntry,
  removeWindowsUninstallEntry,
  runCommand,
  systemdController,
  writeConfigFileValues,
  type ServiceSpec
} from '@printstream/sea-runtime'
import {
  SERVER_DATA_DIR_ENV,
  SERVER_DOCUMENTATION_URL,
  SERVER_IDENTITY,
  SERVER_SERVICE_DESCRIPTION,
  resolveServerPaths,
  type ServerPaths
} from './app-identity.js'
import { getSeaAssetBuffer, isSeaPackaged } from './packaged.js'
import { installServerTrayLauncher, uninstallServerTrayAutostart, uninstallServerTrayLauncher } from './tray.js'

const LINUX_SERVICE_USER = SERVER_IDENTITY.appId
/** Shown as the version in Settings → Apps (the server carries no build stamp). */
const SERVER_DISPLAY_VERSION = '1.0'

/**
 * The Windows service runs as NetworkService rather than the default LocalSystem
 * because the embedded PostgreSQL refuses to run under an administrative account.
 * `WINDOWS_SERVICE_ACCOUNT_SID` (S-1-5-20, NetworkService) is the locale-independent
 * SID used for the icacls grants below.
 */
const WINDOWS_SERVICE_ACCOUNT = 'NT AUTHORITY\\NetworkService'
const WINDOWS_SERVICE_ACCOUNT_SID = '*S-1-5-20'

const winswController = createWinswController({ resolveWinswAsset: () => getSeaAssetBuffer(WINSW_ASSET_KEY) })

interface ServiceController {
  install(spec: ServiceSpec): Promise<void>
  uninstall(spec: ServiceSpec): Promise<void>
  start(spec: ServiceSpec): void
  stop(spec: ServiceSpec): void
  restart(spec: ServiceSpec): void
  status(spec: ServiceSpec): string
}

export interface ServerServiceInstallOptions {
  /** Port the installed service serves on (persisted into the config file). */
  port?: number
}

export function buildServerServiceSpec(paths: ServerPaths, platform: NodeJS.Platform): ServiceSpec {
  return {
    id: SERVER_IDENTITY.appId,
    displayName: SERVER_IDENTITY.displayName,
    description: SERVER_SERVICE_DESCRIPTION,
    documentationUrl: SERVER_DOCUMENTATION_URL,
    exePath: platformPath(platform).join(paths.installDir, paths.exeName),
    args: ['run'],
    dataDir: paths.dataDir,
    logsDir: paths.logsDir,
    env: { [SERVER_DATA_DIR_ENV]: paths.dataDir },
    configFile: paths.configFile,
    ...(platform === 'linux' ? { serviceUser: LINUX_SERVICE_USER } : {}),
    ...(platform === 'win32' ? { serviceAccount: WINDOWS_SERVICE_ACCOUNT } : {})
  }
}

export async function installServerService(options: ServerServiceInstallOptions = {}): Promise<{ exePath: string; configFile: string }> {
  if (!isSeaPackaged()) {
    throw new Error('Service install is only available from the packaged executable.')
  }
  const context = currentPlatformContext()
  const paths = resolveServerPaths(context)
  const spec = buildServerServiceSpec(paths, context.platform)

  if (path.resolve(process.execPath) !== path.resolve(spec.exePath)) {
    mkdirSync(paths.installDir, { recursive: true })
    copyFileSync(process.execPath, spec.exePath)
    try {
      chmodSync(spec.exePath, 0o755)
    } catch {
      // Best-effort on platforms without POSIX modes.
    }
  }

  mkdirSync(paths.dataDir, { recursive: true })
  mkdirSync(paths.logsDir, { recursive: true })
  await writeConfigFileValues(paths.configFile, {
    PORT: options.port === undefined ? undefined : String(options.port)
  })

  // The Windows service runs as NetworkService (see WINDOWS_SERVICE_ACCOUNT); the
  // install dir created under Program Files and the data dir under ProgramData do
  // not grant it access by default, so it could neither launch the exe nor write
  // its database. Grant access before the service starts.
  if (context.platform === 'win32') grantWindowsServiceAccountAccess(paths)

  const controller = getController(context.platform)
  await controller.install(spec)
  ensureInstallDirWritableByService(spec, context.platform)

  // WinSW v2 silently ignores a passwordless <serviceaccount> for a virtual
  // account and leaves the service as LocalSystem (under which PostgreSQL
  // refuses to start), so set the account authoritatively through the SCM and
  // bounce the service so it relaunches under NetworkService.
  if (context.platform === 'win32') setWindowsServiceAccountToNetworkService(spec.id, paths)

  // A launcher entry (Start Menu / Applications) so the tray can be relaunched
  // after a quit without re-running the installer. Best-effort desktop polish.
  try {
    installServerTrayLauncher(spec.exePath)
  } catch {
    // Headless / unsupported desktops have no launcher menu; ignore.
  }

  // Make the app uninstallable from Settings → Apps (with its logo). No quiet
  // string: the server has no silent-uninstall path — the entry runs the GUI.
  if (context.platform === 'win32') {
    registerWindowsUninstallEntry({
      appId: SERVER_IDENTITY.appId,
      displayName: SERVER_IDENTITY.displayName,
      version: SERVER_DISPLAY_VERSION,
      exePath: spec.exePath,
      installLocation: paths.installDir
    })
  }
  return { exePath: spec.exePath, configFile: paths.configFile }
}

export async function uninstallServerService(): Promise<void> {
  const context = currentPlatformContext()
  const paths = resolveServerPaths(context)
  const spec = buildServerServiceSpec(paths, context.platform)
  await getController(context.platform).uninstall(spec)
  if (context.platform === 'win32') removeWindowsUninstallEntry(SERVER_IDENTITY.appId)
  try {
    uninstallServerTrayLauncher()
  } catch {
    // Best-effort; a missing launcher entry is fine.
  }
  try {
    await uninstallServerTrayAutostart()
  } catch {
    // Best-effort; a missing autostart entry is fine.
  }
}

export function controlServerService(action: 'start' | 'stop' | 'restart' | 'status'): string | void {
  const context = currentPlatformContext()
  const paths = resolveServerPaths(context)
  const spec = buildServerServiceSpec(paths, context.platform)
  const controller = getController(context.platform)
  if (action === 'status') return controller.status(spec)
  controller[action](spec)
}

function getController(platform: NodeJS.Platform): ServiceController {
  if (platform === 'linux') return systemdController
  if (platform === 'win32') return winswController
  throw new Error(`Service management is not supported on ${platform}.`)
}

/**
 * In-place self-update (Phase 5) will need the service account to replace the
 * installed binary; on Linux the dedicated user must own the install dir.
 */
function ensureInstallDirWritableByService(spec: ServiceSpec, platform: NodeJS.Platform): void {
  if (platform !== 'linux' || !spec.serviceUser) return
  runCommand('chown', ['-R', `${spec.serviceUser}:${spec.serviceUser}`, path.dirname(spec.exePath)])
}

/**
 * Grants the NetworkService account the access it needs once the service starts:
 * full control of the data + logs dirs (it owns the database, extracted assets,
 * status file, and logs there) and read/execute on the install dir (to launch
 * the exe). icacls adds these ACEs without stripping inherited ones, so the
 * desktop user keeps the read access the tray relies on. Best-effort: a failure
 * is logged but does not abort the install (the elevated operator can re-grant).
 */
function grantWindowsServiceAccountAccess(paths: ServerPaths): void {
  for (const dir of [paths.dataDir, paths.logsDir]) {
    runCommand('icacls', [dir, '/grant', `${WINDOWS_SERVICE_ACCOUNT_SID}:(OI)(CI)F`, '/T', '/C', '/Q'], { allowFailure: true })
  }
  runCommand('icacls', [paths.installDir, '/grant', `${WINDOWS_SERVICE_ACCOUNT_SID}:(OI)(CI)RX`, '/T', '/C', '/Q'], { allowFailure: true })
}

/**
 * Re-points the installed Windows service at NetworkService through the SCM
 * (`Win32_Service.Change` via WMI), then restarts it so the SCM relaunches WinSW
 * — and the embedded PostgreSQL it spawns — under the new, non-administrative
 * identity. WinSW's own `<serviceaccount>` is unreliable for passwordless
 * virtual accounts, so this is the authoritative step.
 *
 * `Restart-Service -Force` is used rather than `sc stop`/`sc start` because the
 * latter return before the stop completes, so the start races the still-running
 * old instance. The whole sequence and the resulting status are written to
 * `account-setup.log` in the logs dir so the tray's "View logs" surfaces exactly
 * what happened if the account change does not take.
 */
function setWindowsServiceAccountToNetworkService(serviceId: string, paths: ServerPaths): void {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  $svc = Get-CimInstance Win32_Service -Filter "Name='${serviceId}'"`,
    "  if (-not $svc) { throw 'service not found' }",
    "  $r = $svc | Invoke-CimMethod -MethodName Change -Arguments @{ StartName = 'NT AUTHORITY\\NetworkService' }",
    "  'Change StartName -> NetworkService: returnValue=' + $r.ReturnValue",
    `  Restart-Service -Name '${serviceId}' -Force`,
    `  'Service status after restart: ' + (Get-Service -Name '${serviceId}').Status`,
    "} catch {",
    "  'Account setup error: ' + $_.Exception.Message",
    '}'
  ].join('\n')
  const output = runCommand('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { allowFailure: true })
  try {
    mkdirSync(paths.logsDir, { recursive: true })
    writeFileSync(path.join(paths.logsDir, 'account-setup.log'), `${output ?? '(no output)'}\n`, 'utf8')
  } catch {
    // The diagnostic is best-effort; the service status is the real signal.
  }
}
