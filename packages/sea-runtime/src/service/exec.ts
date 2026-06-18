/**
 * Small synchronous command runner for service management operations, with
 * error messages that surface stderr so `sudo printstream-bridge service ...`
 * failures are actionable.
 */
import { spawnSync } from 'node:child_process'

export interface RunCommandOptions {
  /** Return null instead of throwing when the command exits non-zero. */
  allowFailure?: boolean
}

export function runCommand(command: string, args: string[], options: RunCommandOptions = {}): string | null {
  // windowsHide matters for the packaged app: its exe is GUI-subsystem (no
  // console on double-click), so a console child (winsw, sc, icacls, net,
  // powershell) spawned without this would pop its own visible console window.
  // These are all background service-management commands; none want a window.
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true })
  if (result.error) {
    if (options.allowFailure) return null
    throw new Error(`Could not run ${command}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    if (options.allowFailure) return null
    const detail = (result.stderr || result.stdout || '').trim()
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}${detail ? `: ${detail}` : '.'}`)
  }
  return result.stdout
}

export function commandSucceeds(command: string, args: string[]): boolean {
  return runCommand(command, args, { allowFailure: true }) !== null
}
