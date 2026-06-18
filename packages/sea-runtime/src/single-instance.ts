/**
 * Cross-arch single-instance guard for the standalone bridge runtime.
 *
 * Two bridges talking to the same server with the same identity conflict, so
 * only one should run per machine — regardless of architecture. The lock lives
 * in the shared data dir (arch-independent: e.g. `C:\ProgramData\PrintStream
 * Bridge\`), so an arm64 and an x64 build contend on the same file. It records
 * the holder's PID and is self-recovering: a lock orphaned by a crash is
 * reclaimed once its PID is seen to be dead, so it can never wedge startup
 * permanently. It guards the runtime itself, independent of the control
 * channel (a named pipe / Unix socket, which binds no port).
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import path from 'node:path'

/**
 * Attempts to claim the single-instance lock. Returns true when this process now
 * holds it (or the lock could not be evaluated and startup should not be
 * blocked), false when another live instance already holds it.
 */
export function acquireSingleInstanceLock(lockPath: string): boolean {
  try {
    mkdirSync(path.dirname(lockPath), { recursive: true })
  } catch {
    return true // can't manage the lock dir — don't block startup on it
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx') // O_CREAT | O_EXCL: fails if it exists
      writeSync(fd, String(process.pid))
      closeSync(fd)
      process.on('exit', () => {
        try {
          rmSync(lockPath, { force: true })
        } catch {
          // Best-effort; a crash leaves the file, but the PID check reclaims it.
        }
      })
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        return true // e.g. a permissions issue — degrade to no guard, don't wedge
      }
      const ownerPid = readLockPid(lockPath)
      if (ownerPid !== null && ownerPid !== process.pid && isProcessAlive(ownerPid)) {
        return false // a live instance holds it
      }
      // Stale (dead owner) or our own leftover — drop it and retry once.
      try {
        rmSync(lockPath, { force: true })
      } catch {
        return true
      }
    }
  }
  return true
}

function readLockPid(lockPath: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0) // signal 0 only probes for existence
    return true
  } catch (error) {
    // ESRCH: no such process. EPERM: it exists but is owned by another account
    // (e.g. the LocalSystem service vs a user launch) — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
