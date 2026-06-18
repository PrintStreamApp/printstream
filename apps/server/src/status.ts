/**
 * World-readable status snapshot the server writes while running, so an
 * unelevated `status` command (or a future tray) can report liveness without
 * reaching the SYSTEM-owned control socket. Liveness is confirmed by probing the
 * recorded PID, exactly as the bridge's status file does.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isSeaPackaged } from './packaged.js'
import type { ServerPaths } from './app-identity.js'

export interface ServerStatus {
  pid: number
  port: number
  dataDir: string
  packaged: boolean
  startedAt: string
  /** Coarse lifecycle the tray surfaces ("running"); the bridge uses the same field. */
  lifecycle: string
  /** Local app URL the tray's "Open PrintStream" item launches. */
  appUrl: string
}

export function writeRunningStatus(paths: ServerPaths, port: number): void {
  const status: ServerStatus = {
    pid: process.pid,
    port,
    dataDir: paths.dataDir,
    packaged: isSeaPackaged(),
    startedAt: new Date().toISOString(),
    lifecycle: 'running',
    appUrl: `http://localhost:${port}`
  }
  mkdirSync(path.dirname(paths.statusFile), { recursive: true })
  writeFileSync(paths.statusFile, `${JSON.stringify(status, null, 2)}\n`, 'utf8')
}

export function readStatus(paths: ServerPaths): ServerStatus | null {
  try {
    return JSON.parse(readFileSync(paths.statusFile, 'utf8')) as ServerStatus
  } catch {
    return null
  }
}

/** Whether the status file describes a process that is still running. */
export function isStatusLive(status: ServerStatus): boolean {
  try {
    process.kill(status.pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
