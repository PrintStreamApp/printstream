/**
 * Change-scoped validate for the inner loop (run via `npm run validate:changed`).
 *
 * Owns the "fast feedback while iterating" path. It is deliberately NOT a gate: `npm run validate`
 * stays the only thing that proves a change is good, and this script says so on every run. The
 * split exists because the full suite is dominated by process startup: 744 test files, each a cold
 * node process re-transpiling its import graph, which no concurrency setting improves (measured:
 * wall time is flat from 6 to 10 workers and worse at 14, because each worker already saturates
 * more than one core).
 *
 * What it runs, and why each stage is scoped the way it is:
 * - lint, over the changed files only. Exact: a rule can only newly fire on a file that changed.
 * - typecheck, in FULL. TypeScript is whole-program, and this is what catches a changed shared
 *   module breaking a consumer in another workspace, the exact blast radius that subtree-scoped
 *   tests miss. Skipping it (`--skip-typecheck`) removes that safety net, not just some time.
 * - tests, scoped to each changed file's SUBTREE (see `resolveScope`).
 *
 * The scoping is a heuristic and can miss a real failure: a behavioural break in a consumer that
 * lives outside the changed file's subtree is not covered (typecheck catches the type-level half of
 * that, nothing catches the rest). That is the accepted trade for the speed, so the run REPORTS the
 * gap rather than implying full coverage: it prints the scopes chosen and warns by name when a
 * change reaches across a workspace boundary. Never make this quieter: a scoped pass that reads
 * like a full pass is worse than no scoping at all.
 *
 * Flags: `--since=<ref>` (compare against a ref instead of the working tree), `--list` (print the
 * plan and exit), `--skip-typecheck`.
 */
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// `fileURLToPath`, not `.pathname`: the latter stays percent-encoded (a repo under "my repo"
// yields "my%20repo") and keeps its leading slash on Windows ("/C:/..."), so every spawn below
// would run with a cwd that does not exist. This script explicitly supports Windows (see `shell`
// in `run()`).
const workspaceRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const rawArgs = process.argv.slice(2)

const listOnly = rawArgs.includes('--list')
const skipTypecheck = rawArgs.includes('--skip-typecheck')
const since = readFlag('--since=')

// Extensions eslint and the test runner both understand. A changed file outside this set (docs,
// JSON, Prisma schema) still counts as a change but drives neither stage.
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
// Only these trees hold test files (mirrors run-tests.mjs's search roots), so only changes here can
// resolve to a test scope. A change under scripts/ or docs/ is still linted.
const TEST_ROOTS = ['apps', 'packages']

const changedFiles = collectChangedFiles()
if (changedFiles.length === 0) {
  console.error(since ? `No changes against ${since}.` : 'No uncommitted changes.')
  process.exit(0)
}

// A deleted file has no content to lint and no subtree to scope; its absence is covered by
// typecheck (a dangling import fails to resolve) and by whatever tests remain in its old scope.
const presentFiles = changedFiles.filter((file) => existsSync(path.join(workspaceRoot, file)))
const deletedCount = changedFiles.length - presentFiles.length

const lintTargets = presentFiles.filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)))
const scopeCandidates = lintTargets.filter((file) => TEST_ROOTS.includes(file.split('/')[0]))

const scopes = dedupeScopes(scopeCandidates.map(resolveScope).filter(Boolean))
const crossWorkspace = [...new Set(scopeCandidates.filter((file) => file.startsWith('packages/')).map(workspaceOf))]

console.error(`Changed: ${changedFiles.length} file(s)${deletedCount > 0 ? ` (${deletedCount} deleted)` : ''}${since ? ` vs ${since}` : ''}`)
for (const file of changedFiles) console.error(`    ${file}`)

console.error(`\nTest scopes (${scopes.length}):`)
if (scopes.length === 0) {
  console.error('    (none: no changed file sits under apps/ or packages/)')
} else {
  for (const scope of scopes) console.error(`    ${scope}`)
}

if (listOnly) {
  const planned = scopes.length > 0 ? listScopedTests(scopes) : []
  console.error(`\nWould lint ${lintTargets.length} file(s), ${skipTypecheck ? 'skip typecheck' : 'typecheck in full'}, run ${planned.length} test file(s).`)
  for (const file of planned) console.error(`    ${file}`)
  process.exit(0)
}

const startedAt = Date.now()
let failed = false

if (lintTargets.length > 0) {
  console.error(`\n=== lint (${lintTargets.length} changed file(s)) ===`)
  failed = (await run('npx', ['eslint', '--cache', '--cache-strategy', 'content', ...lintTargets])) !== 0 || failed
} else {
  console.error('\n=== lint: skipped (no changed source files) ===')
}

if (!failed && !skipTypecheck) {
  console.error('\n=== typecheck (full, whole-program) ===')
  failed = (await run('npm', ['run', 'typecheck'])) !== 0 || failed
}

if (!failed && scopes.length > 0) {
  console.error('\n=== tests (scoped) ===')
  failed = (await run('node', [path.join('scripts', 'dev', 'run-tests.mjs'), ...scopes], { NODE_ENV: 'test' })) !== 0 || failed
} else if (!failed) {
  console.error('\n=== tests: skipped (no changed file resolved to a scope) ===')
}

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
console.error(`\n${'='.repeat(60)}`)
if (failed) {
  console.error(`✖ Scoped validate FAILED in ${elapsed}s.`)
} else {
  console.error(`✓ Scoped validate passed in ${elapsed}s.`)
}

// Always state the gap, pass or fail. This run is a subset by construction and must never read as
// a full pass; the warnings below name the parts of the blast radius it could not reach.
console.error('\nThis is a SUBSET, not the gate. Not covered by this run:')
console.error('    - behavioural breakage in consumers outside the scopes above')
if (skipTypecheck) console.error('    - ALL cross-workspace type breakage (--skip-typecheck was passed)')
if (crossWorkspace.length > 0) {
  console.error(`    - consumers of the changed shared package(s): ${crossWorkspace.join(', ')}`)
  console.error('      (typecheck covers type-level breaks there; nothing here covers behaviour)')
}
console.error('\nRun `npm run validate` before committing.')

process.exit(failed ? 1 : 0)

/**
 * Maps a changed file to the subtree whose tests should run for it: the nearest ancestor directory
 * that directly contains test files, bounded at the workspace root.
 *
 * Walking up (rather than using the file's own directory) is what makes a change to
 * `plugins/model-studio/EditorView.tsx` run the whole model-studio suite instead of nothing. The
 * bound matters: without it, a change to a workspace's entry file would walk to the repo root and
 * silently select every test in the repo.
 *
 * Returns a path with a trailing slash because run-tests.mjs filters by SUBSTRING, so bare
 * `apps/web/src/lib` would also match `apps/web/src/library/`.
 */
function resolveScope(file) {
  const workspace = workspaceOf(file)
  if (!workspace) return null
  let dir = path.dirname(file)
  while (dir.startsWith(workspace) && dir !== workspace) {
    if (directoryHasTests(dir)) return `${dir}/`
    dir = path.dirname(dir)
  }
  // No ancestor below the workspace root holds tests: fall back to the whole workspace rather than
  // returning nothing, so the change is at least covered by its own workspace's suite.
  return `${workspace}/`
}

function directoryHasTests(dir) {
  const entries = readdirSync(path.join(workspaceRoot, dir), { withFileTypes: true })
  return entries.some((entry) => entry.isFile() && /\.test\.tsx?$/.test(entry.name))
}

/** `apps/web/src/lib/foo.ts` -> `apps/web`. Null for a path outside a workspace. */
function workspaceOf(file) {
  const segments = file.split('/')
  if (segments.length < 2 || !TEST_ROOTS.includes(segments[0])) return null
  return `${segments[0]}/${segments[1]}`
}

/** Drops any scope contained by another, so a subtree is never run twice. */
function dedupeScopes(scopes) {
  const unique = [...new Set(scopes)]
  return unique
    .filter((scope) => !unique.some((other) => other !== scope && scope.startsWith(other)))
    .sort()
}

function collectChangedFiles() {
  const files = since
    ? git(['diff', '--name-only', since])
    : [...git(['diff', '--name-only', 'HEAD']), ...git(['ls-files', '--others', '--exclude-standard'])]
  return [...new Set(files)].sort()
}

function listScopedTests(activeScopes) {
  const output = execFileSync('node', [path.join('scripts', 'dev', 'run-tests.mjs'), '--list', ...activeScopes], {
    cwd: workspaceRoot,
    encoding: 'utf8'
  })
  return output.split('\n').filter(Boolean)
}

function git(args) {
  return execFileSync('git', args, { cwd: workspaceRoot, encoding: 'utf8' }).split('\n').filter(Boolean)
}

function run(command, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: workspaceRoot,
      env: { ...process.env, ...extraEnv },
      stdio: 'inherit',
      shell: process.platform === 'win32'
    })
    child.on('error', (error) => {
      console.error(`Failed to start ${command}: ${error.message}`)
      resolve(1)
    })
    child.on('close', (code, signal) => resolve(signal ? 1 : code ?? 1))
  })
}

function readFlag(prefix) {
  const found = rawArgs.find((arg) => arg.startsWith(prefix))
  return found ? found.slice(prefix.length) : undefined
}
