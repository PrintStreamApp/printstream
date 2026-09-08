/**
 * Runs a command while holding the repo-wide heavy-job lock (see `lib/repo-lock.mjs`).
 *
 * Composed with `run-low-priority.mjs` rather than merged into it, so each wrapper keeps one job:
 * that one lowers CPU priority, this one serialises. `npm run validate` stacks both.
 *
 * Why serialise at all: sibling worktrees of one clone each run their own validate, and concurrent
 * full suites do not finish sooner in aggregate (the CPU is saturated by one run) while making every
 * individual run ~3.4x slower and introducing load-induced flakes. Queuing is strictly better for
 * the person waiting on the first result.
 *
 * `PRINTSTREAM_NO_REPO_LOCK=1` runs immediately regardless of who else is going.
 */
import { spawn } from 'node:child_process'

import { withRepoLock } from './lib/repo-lock.mjs'

const [command, ...args] = process.argv.slice(2)
if (!command) {
  console.error('usage: node scripts/dev/run-exclusive.mjs <command> [args...]')
  process.exit(2)
}

const label = process.env.PRINTSTREAM_LOCK_LABEL || [command, ...args].join(' ')

const code = await withRepoLock(label, () => new Promise((resolve) => {
  // shell on Windows so `npm` resolves to npm.cmd; stdio inherited so output/interactivity pass through.
  const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' })
  child.on('error', (error) => {
    console.error(`run-exclusive: failed to start ${command}: ${error.message}`)
    resolve(1)
  })
  child.on('exit', (childCode, signal) => resolve(childCode ?? (signal ? 1 : 0)))

  // A signal aimed at THIS pid rather than the process group (a supervisor, an IDE stop button)
  // reaches the wrapper alone. Without forwarding, `withRepoLock`'s own handler removes the lock
  // file and re-raises, and the suite this was serialising keeps running with the lock gone: the
  // next run on the same clone starts immediately and the two contend, which is exactly the ~3.4x
  // slowdown and load-induced flaking the lock exists to prevent.
  //
  // A signal aimed at THIS pid rather than the process group (a supervisor, an IDE stop button)
  // reaches the wrapper alone. Without forwarding, `withRepoLock`'s own handler removes the lock file
  // and re-raises, and the suite this was serialising keeps running with the lock gone: the next run
  // on the same clone starts immediately and the two contend, which is the ~3.4x slowdown and
  // load-induced flaking the lock exists to prevent.
  //
  // `prependOnceListener`, and BOTH halves of that matter. Prepend, so this runs before repo-lock's
  // handler releases the lock. ONCE, because a registered listener suppresses the signal's default
  // disposition: with a permanent one, repo-lock's `process.kill(process.pid, sig)` re-raise cannot
  // terminate anything and merely re-enters this forwarder, so the wrapper stays alive holding the
  // lock forever (`repo-lock.mjs` documents the same trap for its own listener). `once` removes it
  // before invoking, so by the time the re-raise lands there is nothing left to intercept it.
  //
  // KNOWN LIMIT, stated rather than papered over: this hands the signal on, it does not wait. The
  // wrapper is killed by the re-raise in the same delivery, and Node emits no `'exit'` for a
  // signal-caused termination, so there is no hook left from which to escalate. A child that IGNORES
  // the signal therefore outlives the wrapper with the lock already released. Covering that would
  // mean run-exclusive owning the whole shutdown (catch, kill, await the child, release, exit)
  // instead of composing with `withRepoLock`, which is a bigger change than the failure justifies:
  // every command this wraps is an npm script that dies on SIGINT/SIGTERM. On Windows the shell
  // wrapper receives it, the same reach the uninstrumented version had.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.prependOnceListener(signal, () => { child.kill(signal) })
  }
}))

process.exit(code)
