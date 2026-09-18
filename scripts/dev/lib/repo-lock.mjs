/**
 * Repo-wide advisory lock, shared by every git worktree of the same clone.
 *
 * Owns the "only one heavy job at a time per repo" rule. Sibling worktrees each run their own
 * validate, and measured on this box three concurrent full test suites take 375s EACH (110s solo).
 * Total throughput barely moves, because the CPU is already saturated at one run, but two things
 * get much worse: whoever is waiting on the first result waits 3.4x longer than they need to, and
 * the crowded run produces load-induced test flakes that never occur solo (3, 1 and 1 files across
 * the three runs), each of which triggers run-tests.mjs's serial isolation re-run. Serialising
 * turns that into 110s / 220s / 330s with no flakes.
 *
 * Contract: `withRepoLock(label, fn)` runs `fn` while holding the lock and always releases it,
 * including on SIGINT/SIGTERM. Waiting is LOUD (it reports who holds the lock and keeps saying so)
 * because a silent wait is indistinguishable from a hang. `PRINTSTREAM_NO_REPO_LOCK=1` skips
 * locking entirely.
 *
 * The lock is keyed on the git COMMON dir (`git rev-parse --git-common-dir`), which every worktree
 * of a clone reports identically, so worktrees serialise against each other and against the main
 * checkout. Two different clones do not contend.
 *
 * Liveness assumes the holder shares our PID namespace: we probe `kill(pid, 0)` only when the
 * recorded hostname and PID namespace match ours, and otherwise use heartbeat staleness. A live
 * local holder wins over an overdue heartbeat. Heartbeats let us reclaim a lock from a container
 * that dies without releasing it. Assumes atomic `O_EXCL` creation on local disk, not NFS;
 * revisit if the repo ever lives on a network mount.
 */
import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { hostname } from 'node:os'
import path from 'node:path'

import { repoCacheDir } from './repo-cache-dir.mjs'

/** How long a holder may go without heartbeating before another process may steal the lock. */
const STALE_AFTER_MS = 60_000
/** Heartbeat cadence. Comfortably inside STALE_AFTER_MS so a busy but healthy holder is never stolen from. */
const HEARTBEAT_MS = 10_000
/** Gap between acquisition attempts. */
const POLL_MS = 1_000
/** How often to re-tell the user we are still waiting, so a long wait never looks like a hang. */
const WAIT_NOTICE_MS = 30_000

/**
 * Runs `fn` while holding the repo-wide heavy-job lock.
 *
 * Acquisition errors reject the job: silently running without coordination can exhaust host RAM.
 * The explicit PRINTSTREAM_NO_REPO_LOCK override remains available for dedicated machines.
 *
 * @param {string} label human-readable description of the job, shown to whoever is waiting
 * @param {() => Promise<T>} fn
 * @param {{ handleSignals?: boolean }} options disable signal handling only when the caller awaits child shutdown
 * @returns {Promise<T>}
 * @template T
 */
export async function withRepoLock(label, fn, { handleSignals = true } = {}) {
  if (process.env.PRINTSTREAM_NO_REPO_LOCK === '1') return fn()

  const handle = await acquire(label, handleSignals)

  try {
    return await fn()
  } finally {
    handle.release()
  }
}

async function acquire(label, handleSignals) {
  const lockPath = lockFilePath()
  mkdirSync(path.dirname(lockPath), { recursive: true })

  const token = randomUUID()
  let announcedAt = 0
  let waitedFrom = 0

  for (;;) {
    const claimed = tryClaim(lockPath, token, label)
    if (claimed) {
      if (waitedFrom) {
        console.error(`repo-lock: acquired after ${Math.round((Date.now() - waitedFrom) / 1000)}s.`)
      }
      return startHolding(lockPath, token, label, handleSignals)
    }

    const holder = readHolder(lockPath)
    if (isReclaimable(lockPath, holder)) {
      // Steal: the recorded holder is gone or has stopped heartbeating. Removing the file lets the
      // next tryClaim win it; a racing stealer just loses that race harmlessly.
      rmSync(lockPath, { force: true })
      continue
    }

    const now = Date.now()
    if (!waitedFrom) waitedFrom = now
    if (now - announcedAt >= WAIT_NOTICE_MS || announcedAt === 0) {
      announcedAt = now
      console.error(
        `repo-lock: waiting for ${describeHolder(holder)} to finish `
          + `(waited ${Math.round((now - waitedFrom) / 1000)}s). Set PRINTSTREAM_NO_REPO_LOCK=1 to run anyway.`
      )
    }
    await sleep(POLL_MS)
  }
}

/** Atomically creates the lock file, or returns false if someone already holds it. */
function tryClaim(lockPath, token, label) {
  let fd
  try {
    fd = openSync(lockPath, 'wx')
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  }
  try {
    writeSync(fd, JSON.stringify(holderRecord(token, label)))
    return true
  } finally {
    closeSync(fd)
  }
}

function startHolding(lockPath, token, label, handleSignals) {
  let released = false

  const heartbeat = setInterval(() => {
    // Only refresh while we still own the file: if someone stole it (we stalled past
    // STALE_AFTER_MS), overwriting would evict the new legitimate holder.
    if (readHolder(lockPath)?.token !== token) return
    try {
      writeFileSync(lockPath, JSON.stringify(holderRecord(token, label)))
    } catch {
      // A vanished lock directory is not worth failing the job over; the next claim recreates it.
    }
  }, HEARTBEAT_MS)
  heartbeat.unref()

  // Held so `release` can take them off again. A process may acquire the lock many times (the test
  // suite does, and so would any caller in a loop), and handlers left behind accumulate until Node
  // warns about an EventEmitter leak and every stale one still runs at shutdown.
  const signalHandlers = new Map()

  const release = () => {
    if (released) return
    released = true
    clearInterval(heartbeat)
    process.removeListener('exit', release)
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler)
    signalHandlers.clear()
    try {
      // Token check: never delete a lock we no longer own.
      if (readHolder(lockPath)?.token === token) rmSync(lockPath, { force: true })
    } catch {
      // Best-effort; a leftover file is reclaimed by the staleness check.
    }
  }

  process.on('exit', release)
  for (const signal of handleSignals ? ['SIGINT', 'SIGTERM', 'SIGHUP'] : []) {
    const handler = () => {
      // `release` removes this listener first, which is what makes the re-raise below terminate:
      // Node only applies a signal's default disposition when nothing is listening for it, so
      // re-raising while still registered delivers the signal straight back here and spins forever
      // instead of exiting. Ctrl-C during a validate run used to hang rather than stop it.
      release()
      process.kill(process.pid, signal)
    }
    signalHandlers.set(signal, handler)
    process.on(signal, handler)
  }

  return { release }
}

function holderRecord(token, label) {
  return { token, pid: process.pid, host: hostname(), pidNamespace: pidNamespace(), label, cwd: process.cwd(), heartbeatAt: Date.now() }
}

function readHolder(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch {
    // A claim can be mid-write; the caller checks file age before reclaiming unreadable records.
    return null
  }
}

/**
 * Whether the lock on disk may be taken away from whoever left it.
 *
 * A record we cannot READ counts too, but only once the file has aged past `STALE_AFTER_MS`.
 * `tryClaim` creates the file and writes the record as two steps, so a reader that lands between
 * them legitimately sees an empty file; reclaiming that would hand the lock to two runs at once.
 * The age check keeps that window safe while still freeing a file left empty for good, by a process
 * killed between the two steps or by a disk that filled mid-write. Without it a single zero-byte
 * lock wedges every worktree on the clone forever, because an unreadable record never heartbeats
 * and so could never go stale.
 */
function isReclaimable(lockPath, holder) {
  if (holder) return isStale(holder)
  return fileAgeMs(lockPath) > STALE_AFTER_MS
}

/** Infinity when the file is already gone, so the next `tryClaim` simply wins it. */
function fileAgeMs(file) {
  try {
    return Date.now() - statSync(file).mtimeMs
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function isStale(holder) {
  if (!holder) return true
  // A live local holder remains authoritative even if host pressure delayed its heartbeat.
  // Sandboxes can share a hostname while having entirely different PID namespaces.
  const namespace = pidNamespace()
  const sameNamespace = holder.host === hostname()
    && (process.platform !== 'linux' || (namespace && holder.pidNamespace === namespace))
  if (!sameNamespace) return Date.now() - (holder.heartbeatAt ?? 0) > STALE_AFTER_MS
  try {
    process.kill(holder.pid, 0)
    return false
  } catch (error) {
    // EPERM means the process exists but belongs to another user, so it is alive.
    return error.code !== 'EPERM'
  }
}

function describeHolder(holder) {
  if (!holder) return 'another run'
  const where = holder.cwd ? ` in ${holder.cwd}` : ''
  return `${holder.label ?? 'another run'}${where} (pid ${holder.pid})`
}

function lockFilePath() {
  return path.join(repoCacheDir(), 'heavy-job.lock')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Linux namespace identity prevents probing a sandbox PID in an unrelated process table. */
function pidNamespace() {
  if (process.platform !== 'linux') return null
  try {
    return readlinkSync('/proc/self/ns/pid')
  } catch {
    // Without namespace access, use the heartbeat instead of probing a potentially unrelated PID.
    return null
  }
}
