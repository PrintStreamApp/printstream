/**
 * Regression tests for the repo-wide heavy-job lock.
 *
 * The failure that matters most is not "two jobs overlapped" but "the lock wedged the repo": a
 * holder that dies without releasing, or a `fn` that throws, must never leave the next run waiting
 * forever. Those cases are covered first.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import { withRepoLock } from './repo-lock.mjs'
import { repoCacheDir } from './repo-cache-dir.mjs'

let sandbox
let cacheHome

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'printstream-repo-lock-'))
  cacheHome = mkdtempSync(path.join(tmpdir(), 'printstream-repo-lock-home-'))
  process.env.XDG_CACHE_HOME = cacheHome
  execFileSync('git', ['init', '-q'], { cwd: sandbox })
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
  rmSync(cacheHome, { recursive: true, force: true })
  delete process.env.XDG_CACHE_HOME
  delete process.env.PRINTSTREAM_NO_REPO_LOCK
})

function lockPath() {
  return path.join(repoCacheDir(process.cwd()), 'heavy-job.lock')
}

/** Plants a pre-existing holder record, creating the cache directory the lock would create itself. */
function plantHolder(holder) {
  mkdirSync(path.dirname(lockPath()), { recursive: true })
  writeFileSync(lockPath(), JSON.stringify(holder))
}

test('serialises overlapping jobs rather than running them together', async () => {
  const events = []
  const job = (name) => withRepoLock(name, async () => {
    events.push(`${name}:start`)
    await new Promise((resolve) => setTimeout(resolve, 30))
    events.push(`${name}:end`)
  })

  await Promise.all([job('first'), job('second')])

  // Whichever won, its start and end must be adjacent: no interleaving.
  assert.equal(events.length, 4)
  assert.equal(events[0].endsWith(':start'), true)
  assert.equal(events[1], `${events[0].split(':')[0]}:end`, `interleaved: ${events.join(', ')}`)
})

test('releases the lock when the job throws, so a failure cannot wedge the repo', async () => {
  await assert.rejects(withRepoLock('boom', async () => {
    throw new Error('job failed')
  }), /job failed/)

  assert.equal(existsSync(lockPath()), false, 'the lock file must not survive a failed job')

  let ran = false
  await withRepoLock('next', async () => { ran = true })
  assert.equal(ran, true)
})

test('steals a lock whose holder is gone', async () => {
  // A holder that died without releasing: a pid that cannot exist, on this host so the pid probe
  // is meaningful, with a fresh heartbeat so only the liveness check can free it.
  plantHolder({
    token: 'stale', pid: 2 ** 22, host: hostname(), pidNamespace: process.platform === 'linux' ? readlinkSync('/proc/self/ns/pid') : null, label: 'dead run', cwd: sandbox, heartbeatAt: Date.now()
  })

  let ran = false
  await withRepoLock('takeover', async () => { ran = true })
  assert.equal(ran, true, 'a dead holder must not block the next run')
})

test('steals a lock that has stopped heartbeating, even from an unknown host', async () => {
  // Another container: we cannot probe its pid, so staleness is the only signal available.
  plantHolder({
    token: 'stale', pid: process.pid, host: 'some-other-container', label: 'vanished', cwd: sandbox, heartbeatAt: Date.now() - 10 * 60_000
  })

  let ran = false
  await withRepoLock('takeover', async () => { ran = true })
  assert.equal(ran, true)
})

test('does not steal a lock from a live, heartbeating holder on another host', async () => {
  plantHolder({
    token: 'live', pid: process.pid, host: 'some-other-container', label: 'busy', cwd: sandbox, heartbeatAt: Date.now()
  })

  let ran = false
  const attempt = withRepoLock('waiter', async () => { ran = true })
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(ran, false, 'a healthy holder must be waited for, not stolen from')

  // Let the waiter through so the test can finish.
  rmSync(lockPath(), { force: true })
  await attempt
  assert.equal(ran, true)
})

test('records who holds the lock, so a waiting run can say what it is waiting for', async () => {
  await withRepoLock('validate', async () => {
    const holder = JSON.parse(readFileSync(lockPath(), 'utf8'))
    assert.equal(holder.label, 'validate')
    assert.equal(holder.pid, process.pid)
    assert.equal(holder.host, hostname())
  })
})

test('an unreadable lock file is reclaimed once it has aged out', async () => {
  // `tryClaim` creates the file and writes the record separately, so a process killed between the
  // two leaves a zero-byte lock. It can never heartbeat, so without an age check it is never stale
  // and every worktree on the clone waits on it forever.
  mkdirSync(path.dirname(lockPath()), { recursive: true })
  writeFileSync(lockPath(), '')
  const aged = new Date(Date.now() - 10 * 60_000)
  utimesSync(lockPath(), aged, aged)

  let ran = false
  await withRepoLock('takeover', async () => { ran = true })
  assert.equal(ran, true, 'an orphaned empty lock must not wedge the repo')
})

test('a lock file that is merely mid-write is NOT reclaimed', async () => {
  // The other half of the same rule: an empty file that was just created is a claim in progress,
  // and stealing it would hand the lock to two runs at once.
  mkdirSync(path.dirname(lockPath()), { recursive: true })
  writeFileSync(lockPath(), '')

  let ran = false
  const attempt = withRepoLock('waiter', async () => { ran = true })
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(ran, false, 'a fresh empty lock is a claim in flight, not a corpse')

  rmSync(lockPath(), { force: true })
  await attempt
  assert.equal(ran, true)
})

test('releasing takes its process listeners back off', async () => {
  // A handler left behind per acquisition trips Node's max-listeners warning and still fires at
  // shutdown. It is also what makes the signal path terminate: a listener still registered for a
  // signal suppresses its default disposition, so re-raising it would loop instead of exiting.
  const before = {
    exit: process.listenerCount('exit'),
    SIGINT: process.listenerCount('SIGINT'),
    SIGTERM: process.listenerCount('SIGTERM'),
    SIGHUP: process.listenerCount('SIGHUP')
  }

  for (let index = 0; index < 5; index += 1) {
    await withRepoLock(`run-${index}`, async () => {
      assert.ok(process.listenerCount('SIGINT') > before.SIGINT, 'the handler is installed while held')
    })
  }

  for (const [event, count] of Object.entries(before)) {
    assert.equal(process.listenerCount(event), count, `${event} listeners are not leaked`)
  }
})

test('the escape hatch skips locking entirely', async () => {
  process.env.PRINTSTREAM_NO_REPO_LOCK = '1'
  plantHolder({
    token: 'live', pid: process.pid, host: hostname(), label: 'busy', cwd: sandbox, heartbeatAt: Date.now()
  })

  let ran = false
  await withRepoLock('ignores the lock', async () => { ran = true })
  assert.equal(ran, true, 'PRINTSTREAM_NO_REPO_LOCK must run regardless of who holds the lock')
})

test('does not probe a live holder in another PID namespace with the same hostname', {
  skip: process.platform !== 'linux' && 'PID namespace isolation is Linux-specific'
}, async () => {
  plantHolder({ token: 'sandbox', pid: 2 ** 22, host: hostname(), pidNamespace: 'different', heartbeatAt: Date.now() })
  let ran = false
  const attempt = withRepoLock('waiter', async () => { ran = true })
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(ran, false)
  rmSync(lockPath(), { force: true })
  await attempt
})

test('an inaccessible lock directory fails rather than starting an uncoordinated job', async () => {
  writeFileSync(path.join(cacheHome, 'not-a-directory'), '')
  process.env.XDG_CACHE_HOME = path.join(cacheHome, 'not-a-directory')
  let ran = false
  await assert.rejects(withRepoLock('blocked', async () => { ran = true }))
  assert.equal(ran, false)
})

test('a live holder in our namespace is not stolen when its heartbeat is delayed', async () => {
  plantHolder({
    token: 'busy', pid: process.pid, host: hostname(),
    pidNamespace: process.platform === 'linux' ? readlinkSync('/proc/self/ns/pid') : null,
    heartbeatAt: Date.now() - 10 * 60_000
  })
  let ran = false
  const attempt = withRepoLock('waiter', async () => { ran = true })
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(ran, false)
  rmSync(lockPath(), { force: true })
  await attempt
})
