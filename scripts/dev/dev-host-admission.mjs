/**
 * Admission before Devkit preflight can write a route or replace checkout dependencies.
 * A checkout lease serializes our host launchers. Linux process inspection also catches older
 * launchers and independently started bridges that have no lease. Never kills another process.
 * Assumes one host PID namespace and local atomic symlinks; unsupported inspection fails closed.
 */
import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readSync, readlinkSync, readdirSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import path from 'node:path'

/** Claim this checkout until process exit, rejecting a live holder without changing its lease. */
export function acquireDevRunnerLease({ configDir, slug }, options = {}) {
  const pid = options.pid ?? process.pid
  const isAlive = options.isAlive ?? processIsAlive
  const directory = path.join(configDir, 'printstream-runners')
  const file = path.join(directory, `${slug}.lock`)
  const admissionFile = `${file}.admission`
  const token = JSON.stringify({ pid, token: randomUUID() })
  mkdirSync(directory, { recursive: true })

  // Serialize even stale-lease reclamation. A read/compare/unlink alone has a race where two
  // reclaimers can remove a newly claimed lease. This tiny guard is never automatically stolen:
  // abrupt death during admission requires inspection and deliberate removal, not unsafe expiry.
  try {
    symlinkSync(token, admissionFile)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    throw new Error(`another launcher is admitting this checkout; if abandoned, inspect the owner of ${admissionFile} before removing it`)
  }
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        symlinkSync(token, file)
        const release = () => {
          try {
            if (readlinkSync(file) === token) unlinkSync(file)
          } catch (error) {
            if (error.code !== 'ENOENT') throw error
          }
        }
        return { release }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        let holder
        try {
          holder = readlinkSync(file)
          const parsed = JSON.parse(holder)
          if (!Number.isInteger(parsed.pid) || parsed.pid <= 0 || isAlive(parsed.pid)) {
            throw new Error('this checkout already has an active dev launcher; use its existing session')
          }
        } catch (readError) {
          if (readError.code === 'ENOENT') continue
          throw readError
        }
        // New claimants are excluded by the admission guard until this stale lease is replaced.
        try {
          if (readlinkSync(file) === holder) unlinkSync(file)
        } catch (readError) {
          if (readError.code !== 'ENOENT') throw readError
        }
      }
    }
    throw new Error('another dev launcher is acquiring this checkout; retry after it settles')
  } finally {
    if (readlinkSync(admissionFile) === token) unlinkSync(admissionFile)
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

/** Find legacy checkout launchers and standalone host bridges without exposing process env. */
export function inspectCheckoutHostProcesses(repoRoot, {
  procRoot = '/proc',
  selfPid = process.pid,
  ignorePids = [],
  readCwd = readlinkSync
} = {}) {
  const processes = []
  for (const entry of readdirSync(procRoot)) {
    if (!/^\d+$/.test(entry) || Number(entry) === selfPid || ignorePids.includes(Number(entry))) continue
    const directory = path.join(procRoot, entry)
    try {
      // Other OS users' cwd links are intentionally private. Our launchers/paired bridge all run
      // as this user; conflicting published services are independently rejected by port admission.
      if (process.getuid && statSync(directory).uid !== process.getuid()) continue
      const argv = readBoundedProcessArgv(path.join(directory, 'cmdline'))
      // Unrelated same-user services (notably WSL systemd --user) can legitimately hide cwd.
      // Only plausible Node launcher/bridge candidates need checkout resolution. Candidates
      // whose cwd is unreadable still fail closed; privacy cannot certify another bridge absent.
      if (!isPossibleCheckoutHostProcess(argv)) continue
      const cwd = readCwd(path.join(directory, 'cwd'))
      if (isCheckoutHostProcess({ argv, cwd }, repoRoot)) processes.push(Number(entry))
    } catch (error) {
      // A process may exit during enumeration. Permission errors cannot certify absence.
      if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error
    }
  }
  return processes
}

/** Read a bounded proc argv snapshot, rejecting truncation instead of hiding a later script arg. */
function readBoundedProcessArgv(file) {
  const descriptor = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(64 * 1024 + 1)
    const length = readSync(descriptor, buffer)
    if (length === buffer.length) throw new Error('process command line exceeds dev ownership inspection limit; launch refused')
    return buffer.subarray(0, length).toString('utf8').split('\0').filter(Boolean)
  } finally {
    closeSync(descriptor)
  }
}

/** Filter by executable/script shape before needing privileged cwd links; this grants no ownership. */
function isPossibleCheckoutHostProcess(argv) {
  if (!['node', 'nodejs', 'tsx'].includes(path.basename(argv[0] ?? ''))) return false
  const scripts = argv.slice(1).filter((arg) => !arg.startsWith('-')).map((arg) => path.basename(arg))
  const bridgeCandidate = scripts.some((script) => ['run-service-dev.mjs', 'index.ts', 'index.js'].includes(script))
  if (bridgeCandidate) return true
  return scripts.includes('run-dev.mjs') && !argv.includes('--container-runtime')
}

/** Match script identity plus checkout cwd, rather than arbitrary command substrings. */
export function isCheckoutHostProcess({ argv, cwd }, repoRoot) {
  const runner = path.join(repoRoot, 'scripts/dev/run-dev.mjs')
  const supervisor = path.join(repoRoot, 'scripts/dev/run-service-dev.mjs')
  const scripts = argv.slice(1).filter((arg) => !arg.startsWith('-')).map((arg) => path.resolve(cwd, arg))
  if (scripts.includes(runner)) return !argv.includes('--container-runtime')
  if (scripts.includes(supervisor)) {
    return argv.includes('--name=bridge')
  }
  // Also refuse an independently launched bridge's CLI process (no supervisor).
  return ['src/index.ts', 'dist/index.js']
    .some((entry) => scripts.includes(path.join(repoRoot, 'apps/bridge', entry)))
}

/** Refuse duplicate host ownership before routes, dependency installs or services are touched. */
export function assertNoCheckoutHostProcesses(repoRoot, options) {
  const pids = inspectCheckoutHostProcesses(repoRoot, options)
  if (pids.length) {
    throw new Error(`this checkout already has a host dev launcher or bridge (PID ${pids.join(', ')}); use that session or stop it deliberately before starting/resuming dev`)
  }
}

/**
 * Which part of a launch this process is, which decides whether it takes part in admission.
 *
 * `npm run dev:background` starts this runner twice: devkit's preflight re-executes it detached
 * (with `DEVKIT_BACKGROUND_CHILD=1`) and the invoking process waits for that child to report ready,
 * then exits. Only the child goes on to run the dev stack, so only it may hold the checkout lease.
 * If the waiting launcher took the lease first, the child found it held by a live process and
 * refused to start, which broke every background launch.
 *
 * Read before preflight, which consumes the child flag.
 *
 * @returns `launcher` (hands off and exits: skip admission), `background-child` (runs the stack;
 *   its waiting parent is part of the same launch, not a rival), or `foreground`.
 */
export function devRunnerAdmissionRole({ argv = process.argv, env = process.env } = {}) {
  if (env.DEVKIT_BACKGROUND_CHILD === '1') return 'background-child'
  if (argv.includes('--background')) return 'launcher'
  return 'foreground'
}
