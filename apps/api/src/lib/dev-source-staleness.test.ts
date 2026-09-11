/**
 * The staleness detector has to be right in BOTH directions, and each wrong answer is its own
 * failure. A missed staleness returns this API to the condition the module exists to end (hours of
 * debugging correct code). A false alarm is worse than useless: a warning that cries wolf gets
 * ignored, and then the real one is ignored too.
 *
 * The roots test is the one that will actually catch a regression. The watch list is a MIRROR of
 * what the service supervisor is told to watch, kept in two files that nothing links, so it goes
 * out of step the first time someone adds a `--watch` to the dev script.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { WATCH_ROOTS, evaluateSourceStaleness } from './dev-source-staleness.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

/**
 * A tree whose files all predate `baseMs`, so a test can then age ONE file forward. Removed when the
 * test finishes: `npm run validate` is the repo's inner loop, and leaked trees accumulate in tmp.
 */
async function makeTree(t: { after: (fn: () => void | Promise<void>) => void }): Promise<{ root: string; baseMs: number }> {
  const root = await mkdtemp(path.join(tmpdir(), 'staleness-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const baseMs = Date.now() - 60_000
  await mkdir(path.join(root, 'apps/api/src/lib'), { recursive: true })
  await mkdir(path.join(root, 'packages/shared/dist'), { recursive: true })
  await mkdir(path.join(root, 'apps/api/src/node_modules/junk'), { recursive: true })
  const old = new Date(baseMs - 60_000)
  for (const relative of ['apps/api/src/index.ts', 'apps/api/src/lib/thing.ts', 'packages/shared/dist/index.js']) {
    await writeFile(path.join(root, relative), '// x')
    await utimes(path.join(root, relative), old, old)
  }
  return { root, baseMs }
}

const ROOTS = ['apps/api/src', 'packages/shared/dist'] as const

test('a tree older than the process is not stale', async (t) => {
  const { root, baseMs } = await makeTree(t)
  const result = await evaluateSourceStaleness({ roots: ROOTS, startedAtMs: baseMs, root })
  assert.equal(result.stale, false)
  assert.ok(result.lastCheckedAt, 'a completed scan always reports when it ran')
})

test('one file newer than the process makes it stale, and names that file', async (t) => {
  const { root, baseMs } = await makeTree(t)
  const edited = new Date(baseMs + 30_000)
  await utimes(path.join(root, 'apps/api/src/lib/thing.ts'), edited, edited)

  const result = await evaluateSourceStaleness({ roots: ROOTS, startedAtMs: baseMs, root })
  assert.equal(result.stale, true)
  // Naming the file is most of the value: it turns "something is stale" into "this edit is the one
  // you are not running", which is the sentence that ends the wrong-headed debugging session.
  assert.equal(result.newestPath, 'apps/api/src/lib/thing.ts')
})

test('a compiled package rebuilt after boot counts, not just this app\'s own source', async (t) => {
  // The second shape of the bug: the API's watcher is fine but `packages/shared` was rebuilt and
  // never picked up, so the API runs against a dist it has not loaded.
  const { root, baseMs } = await makeTree(t)
  const rebuilt = new Date(baseMs + 30_000)
  await utimes(path.join(root, 'packages/shared/dist/index.js'), rebuilt, rebuilt)

  const result = await evaluateSourceStaleness({ roots: ROOTS, startedAtMs: baseMs, root })
  assert.equal(result.stale, true)
  assert.equal(result.newestPath, 'packages/shared/dist/index.js')
})

test('a colocated test file is ignored, so editing one cannot raise a false alarm', async (t) => {
  // `apps/api/src` holds ~270 `*.test.ts`, none of them imported by `server.ts`, so the supervisor
  // never reloads for one. Counting them latched "RUNNING STALE CODE" true for the life of the
  // process the first time anyone edited a test -- which this repo asks for with every change. A
  // warning that is wrong most of the time is how a warning stops being read at all.
  const { root, baseMs } = await makeTree(t)
  const edited = new Date(baseMs + 30_000)
  const testFile = path.join(root, 'apps/api/src/lib/thing.test.ts')
  await writeFile(testFile, '// a regression test')
  await utimes(testFile, edited, edited)

  const result = await evaluateSourceStaleness({ roots: ROOTS, startedAtMs: baseMs, root })
  assert.equal(result.stale, false)
})

test('node_modules is ignored, so an install cannot raise a false alarm', async (t) => {
  // `npm install` touches thousands of files under a watched tree and reloads nothing. Counting
  // them would report staleness on every install, which is exactly how a warning stops being read.
  const { root, baseMs } = await makeTree(t)
  const installed = new Date(baseMs + 30_000)
  const junk = path.join(root, 'apps/api/src/node_modules/junk/index.js')
  await writeFile(junk, '// installed')
  await utimes(junk, installed, installed)

  const result = await evaluateSourceStaleness({ roots: ROOTS, startedAtMs: baseMs, root })
  assert.equal(result.stale, false)
})

test('missing roots are skipped rather than failing the scan', async (t) => {
  // A fresh checkout has no `dist` yet. Refusing to answer would turn "not built" into "not checked".
  const { root, baseMs } = await makeTree(t)
  const result = await evaluateSourceStaleness({ roots: [...ROOTS, 'packages/nope/dist'], startedAtMs: baseMs, root })
  assert.equal(result.stale, false)
  assert.ok(result.lastCheckedAt)
})

test('WATCH_ROOTS covers everything the dev script tells the service supervisor to watch', async () => {
  // The two lists live in different files with no link between them, so this is the regression that
  // will actually happen: someone adds a `--watch` and the detector silently stops seeing it.
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'apps/api/package.json'), 'utf8')) as {
    scripts: Record<string, string>
  }
  const dev = packageJson.scripts.dev ?? ''

  const included = [...dev.matchAll(/--watch=(\S+)/g)]
    .map((match) => match[1]!)
    // `../../packages/shared/dist` is stated relative to apps/api; the detector's roots are
    // stated relative to the repo, so compare on the repo-relative form.
    .map((root) => path.normalize(path.join('apps/api', root)))

  for (const root of included) {
    assert.ok(WATCH_ROOTS.includes(root), `the dev script watches ${root} but WATCH_ROOTS does not, so staleness there is invisible`)
  }
  assert.ok(WATCH_ROOTS.includes('apps/api/src'), 'the API\'s own source tree must be watched')
})
