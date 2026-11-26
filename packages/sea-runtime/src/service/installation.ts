/**
 * Strict, read-only service installation observation for destructive uninstall.
 * Unlike the display status helpers, command failure never becomes absence.
 * The caller-owned service name and expected Windows launcher path remain fixed.
 */
import { spawnSync } from 'node:child_process'
import { platformPath } from '../paths.js'

export type ServiceInstallation = 'absent' | 'active' | 'inactive'
export interface ServiceQueryResult { status: number | null; stdout: string; stderr: string; error?: Error }
export type ServiceQuery = (command: string, args: string[]) => ServiceQueryResult

/** Capture native command failure explicitly, without display-oriented fallback. */
const queryService: ServiceQuery = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error }
}

/**
 * Observes the real named service. Only a canonical absent response authorizes
 * skipping teardown. Unknown state, mismatched launcher and query errors refuse.
 * The optional query is trusted internal test plumbing, never request data.
 */
export function observeServiceInstallation(
  platform: NodeJS.Platform,
  paths: { installDir: string; serviceId: string },
  query: ServiceQuery = queryService
): ServiceInstallation {
  if (platform === 'linux') {
    const result = query('systemctl', ['show', `${paths.serviceId}.service`, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'MainPID'])
    if (result.error) throw result.error
    const rows = result.stdout.trim().split('\n').map(line => line.split('='))
    if (rows.length !== 3 || rows.some(row => row.length !== 2) || new Set(rows.map(row => row[0])).size !== 3) {
      throw new Error('Could not establish service installation')
    }
    const properties = Object.fromEntries(rows)
    if ((result.status === 0 || result.status === 1) && properties.LoadState === 'not-found'
        && properties.ActiveState === 'inactive' && properties.MainPID === '0') return 'absent'
    if (result.status === 0 && properties.LoadState === 'loaded') {
      if (['inactive', 'failed'].includes(properties.ActiveState ?? '') && properties.MainPID === '0') return 'inactive'
      if (properties.ActiveState === 'active' && /^[1-9][0-9]*$/.test(properties.MainPID ?? '')) return 'active'
    }
    throw new Error('Could not establish service installation')
  }
  if (platform === 'win32') {
    const id = paths.serviceId.replaceAll("'", "''")
    const script = `$ErrorActionPreference='Stop'; $services=@(Get-CimInstance Win32_Service -Filter "Name='${id}'" -ErrorAction Stop); if ($services.Count -eq 0) { 'null' } elseif ($services.Count -eq 1) { $services[0] | Select-Object State,ProcessId,PathName | ConvertTo-Json -Compress } else { throw 'Ambiguous service' }`
    const result = query('powershell', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)\n[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n$OutputEncoding = [Console]::OutputEncoding\n${script}`])
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error('Could not establish service installation')
    let value: unknown
    try { value = JSON.parse(result.stdout) } catch { throw new Error('Could not establish service installation') }
    if (value === null) return 'absent'
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid service observation')
    const service = value as Record<string, unknown>
    const expectedWrapper = platformPath('win32').join(paths.installDir, `${paths.serviceId}-service.exe`)
    if (service.PathName !== `"${expectedWrapper}"`) throw new Error('Service launcher differs from installed ownership')
    if (service.State === 'Stopped' && service.ProcessId === 0) return 'inactive'
    if (service.State === 'Running' && typeof service.ProcessId === 'number' && Number.isInteger(service.ProcessId) && service.ProcessId > 0) return 'active'
    throw new Error('Could not establish service installation')
  }
  throw new Error(`Service management is not supported on ${platform}`)
}
