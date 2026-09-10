/**
 * Runs a command at the lowest CPU scheduling priority.
 *
 * Owns the "heavy repo scripts must not starve co-resident dev servers" rule: `npm run validate`
 * (lint + full test suite + seven tsc builds) shares the devcontainer with the dev API and Vite,
 * and an un-niced run starves them badly enough that multi-megabyte responses stall past the web
 * app's transfer watchdogs mid-smoke-test. Lowering priority costs validate wall-clock time only
 * when something else wants the CPU, which is exactly the intended trade.
 *
 * Priority is set on THIS process before spawning, so every descendant inherits it: POSIX children
 * inherit the nice value, and Windows children inherit a lowered priority class (only NORMAL and
 * above reset to NORMAL). `os.setPriority` is used instead of `nice` for that Windows coverage.
 * Best-effort on purpose: a sandbox that forbids setpriority() should still run the command.
 */
import { spawn } from 'node:child_process'
import os from 'node:os'

try {
  os.setPriority(os.constants.priority.PRIORITY_LOW)
} catch (error) {
  console.warn(`run-low-priority: could not lower CPU priority (${error.message}); running at normal priority`)
}

const [command, ...args] = process.argv.slice(2)
if (!command) {
  console.error('usage: node scripts/dev/run-low-priority.mjs <command> [args...]')
  process.exit(2)
}

// shell on Windows so `npm` resolves to npm.cmd; stdio inherited so output/interactivity pass through.
const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' })
child.on('error', (error) => {
  console.error(`run-low-priority: failed to start ${command}: ${error.message}`)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0))
})
