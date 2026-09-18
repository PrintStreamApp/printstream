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

// On POSIX the owned process group includes npm's shells and all compiler/test descendants.
// Keep the lock until shutdown completes; forwarding only to npm can leave those children alive.
const code = await withRepoLock(label, () => new Promise((resolve) => {
  const grouped = process.platform !== 'win32'
  const child = spawn(command, args, {
    stdio: 'inherit',
    shell: !grouped,
    detached: grouped
  })
  let receivedSignal
  let escalation
  const handlers = new Map()

  const signalTree = (signal) => {
    try {
      if (grouped) process.kill(-child.pid, signal)
      else child.kill(signal)
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
  const finish = (code) => {
    clearTimeout(escalation)
    for (const [signal, handler] of handlers) process.removeListener(signal, handler)
    // A shell may exit before its children. Reap only this command's group before releasing.
    if (receivedSignal && grouped) signalTree('SIGKILL')
    resolve(receivedSignal ? { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }[receivedSignal] : code)
  }
  child.on('error', (error) => {
    console.error(`run-exclusive: failed to start ${command}: ${error.message}`)
    finish(1)
  })
  child.on('close', (childCode, signal) => finish(childCode ?? (signal ? 1 : 0)))

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => {
      if (receivedSignal) return
      receivedSignal = signal
      signalTree(signal)
      escalation = setTimeout(() => signalTree('SIGKILL'), 2000)
    }
    handlers.set(signal, handler)
    process.on(signal, handler)
  }
}), { handleSignals: false })

process.exit(code)
