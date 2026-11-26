/**
 * systemd integration for standalone Linux installs. The unit runs the service
 * as an optional dedicated system user. DATA ownership and an explicitly opted
 * in dedicated install directory are prepared before the first activation, so
 * restrictive installer permissions cannot block exec or in-place self-update.
 * Without that opt-in, executable-directory ownership remains unchanged.
 */
import { chmod, lstat, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { commandSucceeds, runCommand } from './exec.js'
import { SERVICE_RESTART_EXIT_CODE, type ServiceSpec } from './spec.js'

export function systemdUnitPath(spec: ServiceSpec): string {
  return `/etc/systemd/system/${spec.id}.service`
}

export function generateSystemdUnit(spec: ServiceSpec): string {
  const environmentLines = Object.entries(spec.env)
    .map(([key, value]) => `Environment=${key}=${systemdQuote(value)}`)
    .join('\n')
  const runtimeLines = runtimeDirectoryLines(spec)

  return `[Unit]
Description=${spec.displayName}
${spec.documentationUrl ? `Documentation=${spec.documentationUrl}\n` : ''}Wants=network-online.target
After=network-online.target

[Service]
Type=simple
ExecStart=${systemdQuote(spec.exePath)}${spec.args.map((arg) => ` ${systemdQuote(arg)}`).join('')}
WorkingDirectory=${spec.dataDir}
Restart=always
RestartSec=5
# An intentional restart (self-update, rollback) is not a failure.
SuccessExitStatus=${SERVICE_RESTART_EXIT_CODE}
${spec.serviceUser ? `User=${spec.serviceUser}\nGroup=${spec.serviceUser}\n` : ''}${runtimeLines}${environmentLines}
${spec.configFile ? `EnvironmentFile=-${spec.configFile}` : ''}
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
`.replace(/\n{3,}/g, '\n\n')
}

/** systemd owns creation/removal of an optional app-specific /run directory. */
function runtimeDirectoryLines(spec: ServiceSpec): string {
  if (!spec.runtimeDirectory) return ''
  const { name, mode = 0o755 } = spec.runtimeDirectory
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) || !Number.isInteger(mode) || mode < 0 || mode > 0o777) {
    throw new Error('Runtime directory requires one safe name and a POSIX permission mode')
  }
  return `RuntimeDirectory=${name}\nRuntimeDirectoryMode=${mode.toString(8).padStart(4, '0')}\n`
}

function systemdQuote(value: string): string {
  return /[\s"\\]/.test(value) ? `"${value.replace(/[\\"]/g, '\\$&')}"` : value
}

export const systemdController = {
  async install(spec: ServiceSpec): Promise<void> {
    requireRoot()
    await validateWritableInstallDirectory(spec)
    if (spec.serviceUser) {
      ensureSystemUser(spec.serviceUser, spec.dataDir)
    }
    await mkdir(spec.dataDir, { recursive: true })
    await mkdir(spec.logsDir, { recursive: true })
    if (spec.serviceUser) {
      runCommand('chown', ['-R', `${spec.serviceUser}:${spec.serviceUser}`, spec.dataDir])
    }
    // A root installer with umask077 can create an executable's parent0700.
    // Transfer its explicit dedicated directory before the first exec, rather
    // than letting Restart=always hide a permission-denied initial launch.
    if (spec.writableInstallDir) {
      runCommand('chown', ['-R', '--', `${spec.serviceUser}:${spec.serviceUser}`, spec.writableInstallDir])
    }
    const unitPath = systemdUnitPath(spec)
    await writeFile(unitPath, generateSystemdUnit(spec), 'utf8')
    await chmod(unitPath, 0o644)
    runCommand('systemctl', ['daemon-reload'])
    runCommand('systemctl', ['enable', '--now', spec.id])
  },

  async uninstall(spec: ServiceSpec): Promise<void> {
    requireRoot()
    runCommand('systemctl', ['disable', '--now', spec.id], { allowFailure: true })
    await rm(systemdUnitPath(spec), { force: true })
    runCommand('systemctl', ['daemon-reload'])
  },

  start(spec: ServiceSpec): void {
    runCommand('systemctl', ['start', spec.id])
  },

  stop(spec: ServiceSpec): void {
    runCommand('systemctl', ['stop', spec.id])
  },

  restart(spec: ServiceSpec): void {
    runCommand('systemctl', ['restart', spec.id])
  },

  status(spec: ServiceSpec): string {
    const active = runCommand('systemctl', ['is-active', spec.id], { allowFailure: true })
    return active?.trim() ?? 'not-installed'
  }
}

/** Refuse an ambiguous ownership target before creating a user or activating a unit. */
async function validateWritableInstallDirectory(spec: ServiceSpec): Promise<void> {
  const directory = spec.writableInstallDir
  if (directory === undefined) return
  if (!spec.serviceUser || !path.isAbsolute(directory) || path.normalize(directory) !== directory
      || directory === path.parse(directory).root || path.dirname(spec.exePath) !== directory) {
    throw new Error('Writable install directory requires a service user and the exact dedicated executable directory')
  }
  const entry = await lstat(directory)
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error('Writable install directory must be an existing non-symlink directory')
  }
}

function requireRoot(): void {
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    throw new Error('Managing the system service requires root. Re-run with sudo.')
  }
}

function ensureSystemUser(userName: string, homeDir: string): void {
  if (commandSucceeds('id', ['-u', userName])) return
  runCommand('useradd', [
    '--system',
    '--home-dir', homeDir,
    '--no-create-home',
    '--shell', '/usr/sbin/nologin',
    userName
  ])
}
