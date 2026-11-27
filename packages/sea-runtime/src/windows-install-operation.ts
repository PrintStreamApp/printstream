/**
 * Serializes Windows installation mutations across processes and delayed cleanup.
 * A durable claim is intentionally retained after a crash or uncertain handoff;
 * neither elapsed time nor a reused PID is permission to remove installed files.
 * Nested helpers share only the active operation's asynchronous execution scope.
 * An administrator clears a claim left by a crash with `update clear-lock`
 * (`clearStaleWindowsInstallOperation`), which removes it only when the process
 * that took it is provably gone.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import path from 'node:path'
import { WINDOWS_INSTALL_OPERATION_SCRIPT } from './windows-install-operation-script.js'
import { windowsPowerShellPath } from './windows-hidden-launch.js'

export interface WindowsInstallOperation {
  installDir: string
  serviceId: string
  dataDir?: string
  token: string
  cutoff?: string
  directory: string
  claim: string
  active: boolean
  transferred: boolean
  pending: Set<Promise<unknown>>
}
const operations = new AsyncLocalStorage<WindowsInstallOperation>()

type AdmissionAction = 'acquire' | 'release' | 'clear'

/**
 * Windows rejects a command line over 32,767 characters, and the admission script, encoded for
 * -EncodedCommand (UTF-16, base64), is already close to it: 1.3.25's first build passed it and
 * every lock call failed to start. So the command line carries a short loader instead, holding
 * the script gzip-compressed; the loader expands it and runs it in the same PowerShell process,
 * with stdin, exit codes and errors unchanged. No file is written, so nothing can be swapped
 * between writing and running it.
 */
export function boundedPowerShellCommand(script: string): string {
  const packed = gzipSync(Buffer.from(script, 'utf8')).toString('base64')
  const loader = `$z = [Convert]::FromBase64String('${packed}')
$stream = New-Object IO.Compression.GZipStream((New-Object IO.MemoryStream(,$z)), [IO.Compression.CompressionMode]::Decompress)
$text = (New-Object IO.StreamReader($stream, (New-Object Text.UTF8Encoding($false)))).ReadToEnd()
. ([ScriptBlock]::Create($text))`
  return Buffer.from(loader, 'utf16le').toString('base64')
}

/** The admission command, built once: the script is fixed text. */
const ADMISSION_COMMAND = boundedPowerShellCommand(WINDOWS_INSTALL_OPERATION_SCRIPT)

/** How long one native admission call may take unless the caller allows longer. */
const DEFAULT_ADMISSION_TIMEOUT_MS = 15_000

/**
 * The installation lock could not be taken or released: another operation holds it, a crash left
 * it behind, or PowerShell could not run (AppLocker, Constrained Language Mode, a slow cold boot).
 * Callers that must not fail outright (the boot-attempt counter) recognize it by this type.
 */
export class WindowsInstallOperationRefusedError extends Error {
  constructor(readonly action: AdmissionAction) {
    super(`Windows installation operation ${action} refused. Another operation or interrupted cleanup may still own this installation; if none is running, an administrator can run 'update clear-lock'.`)
    this.name = 'WindowsInstallOperationRefusedError'
  }
}

/** Invoke the fixed native admission protocol; refusal never guesses at recovery. */
function invoke(action: AdmissionAction, operation: Pick<WindowsInstallOperation, 'installDir' | 'serviceId' | 'dataDir' | 'token'>, timeoutMs = DEFAULT_ADMISSION_TIMEOUT_MS): { directory: string; installDir: string; claim: string; cutoff?: string } & Record<string, unknown> {
  const result = spawnSync(windowsPowerShellPath(), [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', ADMISSION_COMMAND
  ], { input: JSON.stringify({ installDir: operation.installDir, serviceId: operation.serviceId, dataDir: operation.dataDir, token: operation.token, action, pid: process.pid }), encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 })
  if (result.error || result.status !== 0 || result.signal !== null) {
    throw new WindowsInstallOperationRefusedError(action)
  }
  const output = JSON.parse(result.stdout) as { directory?: unknown; installDir?: unknown; claim?: unknown }
  if (typeof output.directory !== 'string' || typeof output.installDir !== 'string' || typeof output.claim !== 'string'
      || path.win32.join(output.directory, 'active.json') !== output.claim) {
    throw new Error('Windows installation operation returned invalid paths; claim retained for recovery')
  }
  return output as { directory: string; installDir: string; claim: string; cutoff?: string } & Record<string, unknown>
}

/** Current lease may be transferred exactly once; a transferred caller cannot release it. */
export function transferWindowsInstallOperation(): WindowsInstallOperation {
  const operation = operations.getStore()
  if (!operation?.active || operation.transferred || operation.pending.size > 0) throw new Error('Windows cleanup requires an active installation operation')
  operation.transferred = true
  return operation
}

/**
 * Synchronous admission and release around one operation. Async callbacks retain
 * ownership until settlement. Non-Windows callers retain their existing behavior.
 * The executable basename is the installed service id shared by both SEA apps.
 */
export interface WindowsInstallOperationOptions {
  /**
   * How long each lock call (taking it, and releasing it) may take to run PowerShell; the boot
   * path allows longer for a slow cold start. A lock another operation holds is still waited for
   * only briefly (inside the script), never this long.
   */
  timeoutMs?: number
}

export function withWindowsInstallOperation<T>(exePath: string, callback: () => T, dataDir?: string, options: WindowsInstallOperationOptions = {}): T {
  if (process.platform !== 'win32') return callback()
  const installDir = path.win32.dirname(exePath)
  const serviceId = path.win32.basename(exePath).replace(/\.exe$/i, '')
  const current = operations.getStore()
  if (current?.active && !current.transferred && current.serviceId.toLowerCase() === serviceId.toLowerCase() && path.win32.normalize(current.installDir).toLowerCase() === path.win32.normalize(installDir).toLowerCase()) {
    if (dataDir && (!current.dataDir || path.win32.resolve(current.dataDir).toLowerCase() !== path.win32.resolve(dataDir).toLowerCase())) {
      throw new Error('Nested installation operation must use the admitted DATA directory')
    }
    const result = callback()
    if (result && typeof (result as unknown as PromiseLike<unknown>).then === 'function') {
      // Track admission independently of whether the caller awaits its result.
      // A detached nested writer must never outlive the filesystem exclusion.
      const settled = Promise.resolve(result).finally(() => { current.pending.delete(settled) })
      current.pending.add(settled)
      // Observe detached rejection without changing the promise the caller sees.
      void settled.catch(() => undefined)
      return settled as T
    }
    return result
  }
  const request = { installDir, serviceId, dataDir, token: randomUUID() }
  const observed = invoke('acquire', request, options.timeoutMs)
  const operation: WindowsInstallOperation = { ...request, ...observed, active: true, transferred: false, pending: new Set() }
  const releaseClaim = (): void => {
    operation.active = false
    if (!operation.transferred) invoke('release', operation, options.timeoutMs)
  }
  const release = (): void | Promise<void> => {
    if (operation.pending.size === 0) return releaseClaim()
    return (async () => {
      while (operation.pending.size > 0) await Promise.allSettled([...operation.pending])
      releaseClaim()
    })()
  }
  const releaseAfterSynchronousCallback = (): void => {
    const settled = release()
    if (settled) void settled.catch(() => {
      console.warn('Windows installation operation release failed; claim retained for administrator recovery.')
    })
  }
  return operations.run(operation, () => {
    let result: T
    try { result = callback() } catch (error) { releaseAfterSynchronousCallback(); throw error }
    if (result && typeof (result as unknown as PromiseLike<unknown>).then === 'function') {
      return Promise.resolve(result).finally(release) as T
    }
    releaseAfterSynchronousCallback()
    return result
  })
}

/** What `clearStaleWindowsInstallOperation` found and did. */
export type ClearInstallOperationResult =
  | { outcome: 'not-windows' }
  | { outcome: 'refused'; searchIn: string }
  | { outcome: 'none'; claim: string }
  | { outcome: 'still-running'; claim: string; pid: number }
  | { outcome: 'cleared'; claim: string; pid: number | null; claimedAt: string | null }

/**
 * Removes the installation lock a crashed operation left behind, for `update clear-lock`.
 *
 * Never automatic, and never on elapsed time alone: the claim is removed only when the process
 * that took it is gone. A process with the recorded id still counts as the owner unless it
 * started after the claim was taken, because Windows reuses process ids. Needs an administrator
 * (or the service's own identity), like every change to the installation.
 */
export function clearStaleWindowsInstallOperation(exePath: string): ClearInstallOperationResult {
  if (process.platform !== 'win32') return { outcome: 'not-windows' }
  const installDir = path.win32.dirname(exePath)
  const serviceId = path.win32.basename(exePath).replace(/\.exe$/i, '')
  let result: ReturnType<typeof invoke>
  try {
    result = invoke('clear', { installDir, serviceId, token: randomUUID() })
  } catch (error) {
    // The same PowerShell that could not take the lock may not run this either: say so, with the
    // manual route, rather than repeating "run clear-lock".
    if (!(error instanceof WindowsInstallOperationRefusedError)) throw error
    return { outcome: 'refused', searchIn: process.env.SystemDrive ?? 'C:' }
  }
  const pid = typeof result.ownerPid === 'number' ? result.ownerPid : null
  if (result.outcome === 'none') return { outcome: 'none', claim: result.claim }
  if (result.outcome === 'still-running' && pid !== null) return { outcome: 'still-running', claim: result.claim, pid }
  if (result.outcome === 'cleared') {
    return { outcome: 'cleared', claim: result.claim, pid, claimedAt: typeof result.claimedAt === 'string' ? result.claimedAt : null }
  }
  throw new Error('Windows installation operation clear returned an unknown result; nothing was assumed removed')
}

/**
 * The line `update clear-lock` prints for a result, and its exit code: 0 when the installation is
 * now unlocked (cleared, or nothing to clear), 1 while the owner still runs.
 */
export function describeClearInstallOperationResult(result: ClearInstallOperationResult): { message: string; exitCode: number } {
  if (result.outcome === 'refused') {
    return {
      message: 'Could not check the installation lock: PowerShell could not run the check (AppLocker or Constrained Language Mode can block it),'
        + ' or this prompt is not elevated. From an administrator prompt, make sure no PrintStream update, installer or uninstaller is running,'
        + ` then delete the active.json file in ${result.searchIn}\\.sea-install-operation-<id> (one folder per installed PrintStream app; only a held lock has the file), and restart the service.`,
      exitCode: 4
    }
  }
  switch (result.outcome) {
    case 'not-windows':
      return { message: 'Only Windows installs use an installation lock; nothing to clear.', exitCode: 0 }
    case 'none':
      return { message: `No installation lock is held (${result.claim} does not exist).`, exitCode: 0 }
    case 'still-running':
      return {
        message: `The installation lock at ${result.claim} belongs to process ${result.pid}, which is still running. Let it finish, or stop it, then run this again.`,
        exitCode: 1
      }
    case 'cleared':
      return {
        message: `Removed the installation lock ${result.claim}, taken by process ${result.pid ?? 'unknown'}${result.claimedAt ? ` at ${result.claimedAt}` : ''}, which is no longer running. Restart the service.`,
        exitCode: 0
      }
  }
}
