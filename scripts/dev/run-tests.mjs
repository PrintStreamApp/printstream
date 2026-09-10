/**
 * Repo test runner for the node:test suite (run via `npm run test`).
 *
 * Responsibilities / invariants:
 * - Discovers every `*.test.ts(x)` under apps/ and packages/ (skipping dist/node_modules).
 * - Runs the whole suite in ONE `node --test` invocation. The CLI test runner already isolates each
 *   file in its own subprocess, so there is no shared-module-state leakage between files and peak
 *   memory is bounded by the concurrency cap (~8 subprocesses), not by the file count.
 * - Caps file concurrency (`--test-concurrency`) so we do not oversubscribe the CPU. Oversubscription
 *   (node's default concurrency = core count) is what makes the timing-sensitive suites flake, so the
 *   default deliberately leaves headroom.
 * - We deliberately do NOT pass `--test-force-exit`. It would skip the post-completion event-loop
 *   drain (a few suites leak a ref'd handle that adds dead teardown time), but it also force-kills the
 *   process before node:test flushes its failure summary: you lose the failing test name, assertion
 *   message, and stack. Correct diagnostics beat shaving a couple of seconds.
 * - node:test runs every file before reporting (no early abort). On failure we attribute the failing
 *   files from the output and re-run each one ALONE to separate real failures from load-induced
 *   flakes (a file that fails under the crowded run but passes in isolation). Exit is non-zero only
 *   for reproducible failures.
 * - Skips files whose exact content (plus their whole import graph) already passed, via the
 *   content-addressed cache in `lib/result-cache.mjs`. That cache is shared across every worktree of
 *   the clone, so re-validating an unchanged tree costs nothing and a worktree that touched one
 *   workspace inherits the other workspaces' results. Only a FULLY GREEN run records anything, and
 *   what was skipped is always printed: a cached run must never read like a full run.
 *
 * Flags / env (flags win): `--list`, `--reporter=<r>` / NODE_TEST_REPORTER (default dot),
 * `--concurrency=<n>` / NODE_TEST_CONCURRENCY (default ~half the cores, also the memory lever),
 * `--test-timeout=<ms>` / NODE_TEST_TIMEOUT (default 60000, the per-test hang guard),
 * `--no-cache` / PRINTSTREAM_NO_TEST_CACHE=1, `--clear-cache`.
 * Remaining args are path-substring filters.
 */
import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { clearTestCache, planCachedRun, recordGreenRun } from './lib/result-cache.mjs'

const workspaceRoot = path.resolve(new URL('../..', import.meta.url).pathname)
const searchRoots = ['apps', 'packages']
const rawArgs = process.argv.slice(2)

const listOnly = rawArgs.includes('--list')
const noCache = rawArgs.includes('--no-cache')
const clearCache = rawArgs.includes('--clear-cache')
const reporter = readFlag('--reporter=') ?? process.env.NODE_TEST_REPORTER ?? 'dot'
const defaultConcurrency = Math.max(2, Math.ceil(os.availableParallelism() / 2))
const concurrency = resolvePositiveInt(readFlag('--concurrency=') ?? process.env.NODE_TEST_CONCURRENCY, defaultConcurrency)
// Per-test timeout (ms). node:test defaults to Infinity, so a single hung test
// (a never-resolving await, a wedged server handle) stalls the whole run/CI
// forever. Bound it; a timeout fails that test with a normal node:test diagnostic
// (unlike --test-force-exit, which would lose the failure summary).
const testTimeoutMs = resolvePositiveInt(readFlag('--test-timeout=') ?? process.env.NODE_TEST_TIMEOUT, 60_000)
const filters = rawArgs.filter((arg) => arg !== '--list'
  && arg !== '--no-cache'
  && arg !== '--clear-cache'
  && !arg.startsWith('--reporter=')
  && !arg.startsWith('--concurrency=')
  && !arg.startsWith('--test-timeout='))

// Cap on how many files we re-run individually to pinpoint failures. A broad failure (e.g. the DB is
// down) would otherwise trigger dozens of slow isolation runs; past this we just list the failures.
const ISOLATION_LIMIT = 60

const testFiles = []
for (const root of searchRoots) {
  await collectTests(path.join(workspaceRoot, root), testFiles)
}

if (testFiles.length === 0) {
  console.error('No test files found under apps/ or packages/.')
  process.exit(1)
}

const selectedTestFiles = (filters.length === 0 ? testFiles : testFiles.filter((file) => matchesAnyFilter(file, filters))).sort(
  (left, right) => left.localeCompare(right)
)

if (selectedTestFiles.length === 0) {
  console.error(`No test files found under apps/ or packages/ matching ${filters.join(', ')}.`)
  process.exit(1)
}

if (listOnly) {
  for (const file of selectedTestFiles) {
    console.log(path.relative(workspaceRoot, file))
  }
  process.exit(0)
}

if (clearCache) {
  clearTestCache(workspaceRoot)
  console.error('Cleared the cached test results for this clone.')
}

const startedAt = Date.now()

const plan = noCache
  ? { enabled: false, reason: 'disabled by --no-cache', skip: [], run: selectedTestFiles, uncacheable: [], digests: new Map(), store: '' }
  : await planCachedRun({ workspaceRoot, testFiles: selectedTestFiles, saltExtras: { testTimeoutMs: String(testTimeoutMs) } })

// State the coverage of this run before it starts, so a heavily cached run can never be mistaken
// for a full one. `run-changed.mjs` makes the same promise for its scoping.
if (!plan.enabled) {
  console.error(`Result cache off (${plan.reason}).`)
} else if (plan.skip.length > 0) {
  console.error(
    `Result cache: skipping ${plan.skip.length} of ${selectedTestFiles.length} file(s) unchanged since a green run`
      + `${plan.uncacheable.length > 0 ? `, ${plan.uncacheable.length} always run (not exactly hashable)` : ''}.`
  )
}

if (plan.run.length === 0) {
  console.error(`\n✓ All ${selectedTestFiles.length} test file(s) already green (nothing to run) in ${formatElapsed(startedAt)}.`)
  process.exit(0)
}

console.error(`Running ${plan.run.length} test file(s), ≤${concurrency} concurrent…`)

const { status, output } = await runTest(plan.run)

if (status === 0) {
  // Only a fully green run teaches the cache anything: see the contract in lib/result-cache.mjs.
  const recorded = plan.enabled ? recordGreenRun(plan, plan.run) : 0
  const skipped = plan.skip.length > 0 ? ` (+${plan.skip.length} cached)` : ''
  console.error(`\n✓ All ${plan.run.length} test file(s) passed in ${formatElapsed(startedAt)}${skipped}.`)
  if (recorded > 0) console.error(`Recorded ${recorded} result(s) for reuse.`)
  process.exit(0)
}

// Attribute failures to specific files. node:test only prints stack traces (which carry the file
// path) for tests that actually fail, so a file whose path appears in the output is a failing file;
// the files that merely passed alongside it never appear and are left untouched.
const attributed = plan.run.filter(
  (file) => output.includes(file) || output.includes(path.relative(workspaceRoot, file))
)

console.error('\n================ TEST SUMMARY ================')
console.error(
  `Files: ${plan.run.length} run${plan.skip.length > 0 ? ` + ${plan.skip.length} cached` : ''}`
    + ` | Wall clock: ${formatElapsed(startedAt)}`
)

if (attributed.length === 0) {
  console.error('\n✖ The run failed but no file could be attributed from the output (see the log above).')
  process.exit(1)
}

// Confirm each attributed failure in isolation: a file that now passes alone failed only under the
// crowded run (a load-induced flake), not because the code is broken.
const realFailures = []
const flakes = []
const toIsolate = attributed.slice(0, ISOLATION_LIMIT)
console.error(`\nRe-running ${toIsolate.length} failing file(s) individually to confirm…`)
for (const file of toIsolate) {
  const result = await runTest([file], { quiet: true })
  if (result.status !== 0) {
    realFailures.push({ file, output: result.output })
  } else {
    flakes.push(file)
  }
}
for (const file of attributed.slice(ISOLATION_LIMIT)) {
  realFailures.push({ file, output: '' })
}

if (flakes.length > 0) {
  console.error(`\n⚠ ${flakes.length} file(s) failed under the full run but PASSED when re-run alone (load-induced flake):`)
  for (const file of flakes) {
    console.error(`    ${path.relative(workspaceRoot, file)}`)
  }
}

if (realFailures.length === 0) {
  console.error('\nNo reproducible failures: every failure was a load-induced flake.')
  console.error('Treating the run as PASSING. If flakes recur, lower --concurrency or harden the tests above.')
  process.exit(0)
}

for (const { file, output: failureOutput } of realFailures) {
  if (failureOutput) {
    console.error(`\n----- ${path.relative(workspaceRoot, file)} -----`)
    process.stderr.write(failureOutput.endsWith('\n') ? failureOutput : `${failureOutput}\n`)
  }
}

console.error(`\n✖ ${realFailures.length} file(s) FAILED:`)
for (const { file } of realFailures) {
  console.error(`    ${path.relative(workspaceRoot, file)}`)
}
console.error('\nRe-run one file with:  npm run test -- <path-or-substring>')
process.exit(1)

function runTest(files, { quiet = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(
      'node',
      ['--import', 'tsx', '--test', `--test-concurrency=${concurrency}`, `--test-timeout=${testTimeoutMs}`, `--test-reporter=${reporter}`, ...files],
      {
        cwd: workspaceRoot,
        // TZ is pinned so a result cannot depend on where the developer is sitting. Tests that build
        // a UTC instant and assert on LOCAL formatting (apps/web/src/lib/time.test.ts) silently
        // assumed the devcontainer and CI, both of which run with TZ unset (UTC); on a host machine
        // in any other zone they failed with no hint that the clock was the variable. Override it
        // deliberately for a test that needs a specific zone, rather than relying on the ambient one.
        env: {
          ...process.env,
          TZ: process.env.TZ ?? 'UTC',
          TSX_TSCONFIG_PATH: path.join(workspaceRoot, 'tsconfig.test.json')
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )

    const chunks = []
    const capture = (chunk, stream) => {
      chunks.push(chunk)
      if (!quiet) stream.write(chunk)
    }
    child.stdout.on('data', (chunk) => capture(chunk, process.stdout))
    child.stderr.on('data', (chunk) => capture(chunk, process.stderr))

    child.on('error', (error) => {
      resolve({ status: 1, output: String(error?.stack ?? error) })
    })
    child.on('close', (code, signal) => {
      const status = signal ? 1 : code ?? 1
      resolve({ status, output: Buffer.concat(chunks).toString('utf8') })
    })
  })
}

async function collectTests(dirPath, out) {
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      await collectTests(fullPath, out)
      continue
    }
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) {
      out.push(fullPath)
    }
  }
}

function matchesAnyFilter(filePath, activeFilters) {
  const normalizedPath = filePath.toLowerCase()
  const relativePath = path.relative(workspaceRoot, filePath).toLowerCase()
  return activeFilters.some((filter) => {
    const normalizedFilter = filter.toLowerCase()
    return normalizedPath.includes(normalizedFilter) || relativePath.includes(normalizedFilter)
  })
}

function readFlag(prefix) {
  const found = rawArgs.find((arg) => arg.startsWith(prefix))
  return found ? found.slice(prefix.length) : undefined
}

function resolvePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return parsed
}

function formatElapsed(since) {
  const seconds = (Date.now() - since) / 1000
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s` : `${seconds.toFixed(1)}s`
}
