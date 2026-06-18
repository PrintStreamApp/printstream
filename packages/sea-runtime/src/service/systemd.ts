/**
 * systemd integration for standalone Linux installs. The unit runs the service
 * as a dedicated system user with the install dir writable so in-place
 * self-updates work without root.
 */
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { commandSucceeds, runCommand } from './exec.js'
import type { ServiceSpec } from './spec.js'

export function systemdUnitPath(spec: ServiceSpec): string {
  return `/etc/systemd/system/${spec.id}.service`
}

export function generateSystemdUnit(spec: ServiceSpec): string {
  const environmentLines = Object.entries(spec.env)
    .map(([key, value]) => `Environment=${key}=${systemdQuote(value)}`)
    .join('\n')

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
${spec.serviceUser ? `User=${spec.serviceUser}\nGroup=${spec.serviceUser}\n` : ''}${environmentLines}
${spec.configFile ? `EnvironmentFile=-${spec.configFile}` : ''}
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
`.replace(/\n{3,}/g, '\n\n')
}

function systemdQuote(value: string): string {
  return /[\s"\\]/.test(value) ? `"${value.replace(/[\\"]/g, '\\$&')}"` : value
}

export const systemdController = {
  async install(spec: ServiceSpec): Promise<void> {
    requireRoot()
    if (spec.serviceUser) {
      ensureSystemUser(spec.serviceUser, spec.dataDir)
    }
    await mkdir(spec.dataDir, { recursive: true })
    await mkdir(spec.logsDir, { recursive: true })
    if (spec.serviceUser) {
      runCommand('chown', ['-R', `${spec.serviceUser}:${spec.serviceUser}`, spec.dataDir])
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
