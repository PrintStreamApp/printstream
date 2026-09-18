/**
 * The wrapper's signal behaviour, which is the part that can wedge a whole clone.
 *
 * Driven as a real subprocess because that is the only place the defect lived: a registered signal
 * listener suppresses the default disposition, so `withRepoLock`'s re-raise had nothing left to
 * terminate and the wrapper survived its own SIGTERM, heartbeating the lock forever. Nothing about
 * that is visible from calling a function.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const wrapper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'run-exclusive.mjs')
let cacheHome

before(() => {
  // Its own lock bucket, so a real validate on this clone is never disturbed by these runs.
  cacheHome = mkdtempSync(path.join(tmpdir(), 'printstream-run-exclusive-'))
})
after(() => rmSync(cacheHome, { recursive: true, force: true }))

/** Runs the wrapper around `childScript`, signals the WRAPPER's pid, and reports what happened. */
async function signalWrapper(childScript, signal) {
  const child = spawn(process.execPath, [wrapper, process.execPath, '-e', childScript], {
    env: { ...process.env, XDG_CACHE_HOME: cacheHome },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Isolate this test wrapper from the test runner when delivering signals.
    detached: true
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += String(chunk) })

  // Wait for the child to SAY it is ready rather than sleeping. `validate` runs these under
  // `run-low-priority` on a saturated CPU, where a fixed delay signalled the child before it had
  // installed its handler: it then died from the default disposition, printed nothing, and the test
  // failed for a reason that had nothing to do with the wrapper.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child never reported ready; output: ${output}`)), 15_000)
    const check = () => { if (output.includes('READY')) { clearTimeout(timer); resolve() } }
    child.stdout.on('data', check)
    check()
  })
  child.kill(signal)
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 4000)
    child.on('exit', () => { clearTimeout(timer); resolve(true) })
  })
  // The inner `node -e` is a grandchild and survives the wrapper when it ignores the signal, so
  // reap the tree rather than leaving one spinning for the rest of the suite.
  if (!exited) child.kill('SIGKILL')
  try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone, or no group to signal */ }
  return { exited, output }
}

test('a child ignoring cancellation is killed before the wrapper releases its lock', async () => {
  const result = await signalWrapper(
    'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); console.log("READY PID=" + process.pid)',
    'SIGTERM'
  )
  assert.equal(result.exited, true, 'shutdown must escalate rather than leave an orphan')
  const pid = Number(result.output.match(/PID=(\d+)/)[1])
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

test('the signal reaches the CHILD, which is the point of forwarding it', async () => {
  // Without this the suite the lock was serialising keeps running while the lock is released, and
  // the next run starts straight into contention.
  const result = await signalWrapper(
    'process.on("SIGTERM", () => { console.log("CHILD-SIGTERM"); process.exit(0) }); setInterval(() => {}, 1000); console.log("READY")',
    'SIGTERM'
  )
  assert.match(result.output, /CHILD-SIGTERM/)
  assert.equal(result.exited, true)
})
