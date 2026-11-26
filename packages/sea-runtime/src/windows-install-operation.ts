/**
 * Serializes Windows installation mutations across processes and delayed cleanup.
 * A durable claim is intentionally retained after a crash or uncertain handoff;
 * neither elapsed time nor a reused PID is permission to remove installed files.
 * Nested helpers share only the active operation's asynchronous execution scope.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
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

/** Invoke the fixed native admission protocol; refusal never guesses at recovery. */
function invoke(action: 'acquire' | 'release', operation: Pick<WindowsInstallOperation, 'installDir' | 'serviceId' | 'dataDir' | 'token'>): { directory: string; installDir: string; claim: string; cutoff?: string } {
  const result = spawnSync(windowsPowerShellPath(), [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand',
    Buffer.from(WINDOWS_INSTALL_OPERATION_SCRIPT, 'utf16le').toString('base64')
  ], { input: JSON.stringify({ installDir: operation.installDir, serviceId: operation.serviceId, dataDir: operation.dataDir, token: operation.token, action, pid: process.pid }), encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 })
  if (result.error || result.status !== 0 || result.signal !== null) {
    throw new Error(`Windows installation operation ${action} refused. Another operation or interrupted cleanup may still own this installation; retain its operation record for administrator recovery.`)
  }
  const output = JSON.parse(result.stdout) as { directory?: unknown; installDir?: unknown; claim?: unknown }
  if (typeof output.directory !== 'string' || typeof output.installDir !== 'string' || typeof output.claim !== 'string'
      || path.win32.join(output.directory, 'active.json') !== output.claim) {
    throw new Error('Windows installation operation returned invalid paths; claim retained for recovery')
  }
  return output as { directory: string; installDir: string; claim: string; cutoff?: string }
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
export function withWindowsInstallOperation<T>(exePath: string, callback: () => T, dataDir?: string): T {
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
  const observed = invoke('acquire', request)
  const operation: WindowsInstallOperation = { ...request, ...observed, active: true, transferred: false, pending: new Set() }
  const releaseClaim = (): void => {
    operation.active = false
    if (!operation.transferred) invoke('release', operation)
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
