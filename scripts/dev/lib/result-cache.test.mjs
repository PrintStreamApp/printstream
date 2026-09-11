/**
 * Regression tests for the content-addressed test-result cache.
 *
 * The stakes here are asymmetric: a missed skip costs time, a WRONG skip hides a real failure
 * until the file's bytes happen to change. So the cases below concentrate on the invalidation
 * side, including the two that are easy to get backwards: a change to a workspace package that is
 * external to the import graph must still invalidate its consumers, and reverting a change must
 * restore the hit (the digest is content-derived, never mtime-derived).
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

import { planCachedRun, recordGreenRun } from './result-cache.mjs'

const repoRoot = path.resolve(import.meta.dirname, '../../..')

let sandbox
let cacheHome

/**
 * A throwaway repo whose layout is enough for the planner: a git dir (so the cache bucket resolves),
 * a lockfile and the tsconfigs the salt reads, one workspace package, and test files that import it.
 */
before(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'printstream-result-cache-'))
  cacheHome = mkdtempSync(path.join(tmpdir(), 'printstream-result-cache-home-'))
  process.env.XDG_CACHE_HOME = cacheHome

  execFileSync('git', ['init', '-q'], { cwd: sandbox })
  write('package-lock.json', '{}')
  write('tsconfig.base.json', '{}')
  write('tsconfig.test.json', '{}')
  // The salt hashes runner files by repo-relative path; copy them so the sandbox can resolve them.
  // The cache module hashes itself by absolute path, so it needs no copy.
  write('scripts/dev/run-tests.mjs', readFileSync(path.join(repoRoot, 'scripts/dev/run-tests.mjs'), 'utf8'))
  write(
    'scripts/dev/lib/test-concurrency.mjs',
    readFileSync(path.join(repoRoot, 'scripts/dev/lib/test-concurrency.mjs'), 'utf8')
  )
  write('apps/api/prisma/schema.prisma', 'generator client { provider = "prisma-client-js" }\n')

  write('packages/lib/package.json', JSON.stringify({ name: '@printstream/lib' }))
  write('packages/lib/src/index.ts', 'export const value = 1\n')
  write('packages/lib/src/index.test.ts', 'export const libTest = 1\n')

  write('apps/app/src/helper.ts', 'export const helper = 2\n')
  write('apps/app/src/uses-helper.test.ts', "import { helper } from './helper'\nexport default helper\n")
  write('apps/app/src/uses-package.test.ts', "import { value } from '@printstream/lib'\nexport default value\n")
  write('apps/app/src/standalone.test.ts', 'export default 3\n')
})

after(() => {
  rmSync(sandbox, { recursive: true, force: true })
  rmSync(cacheHome, { recursive: true, force: true })
  delete process.env.XDG_CACHE_HOME
})

function write(relative, contents) {
  const full = path.join(sandbox, relative)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, contents)
}

function absolute(...relatives) {
  return relatives.map((relative) => path.join(sandbox, relative))
}

const ALL = () => absolute('apps/app/src/uses-helper.test.ts', 'apps/app/src/uses-package.test.ts', 'apps/app/src/standalone.test.ts')

async function plan(files = ALL()) {
  return planCachedRun({ workspaceRoot: sandbox, testFiles: files })
}

function relativeNames(files) {
  return files.map((file) => path.relative(sandbox, file).split(path.sep).join('/')).sort()
}

test('a cold cache runs everything and records nothing until told', async () => {
  const first = await plan()
  assert.equal(first.enabled, true)
  assert.deepEqual(relativeNames(first.run), relativeNames(ALL()))
  assert.deepEqual(first.skip, [])
})

test('recording a green run makes the next plan skip those files', async () => {
  const first = await plan()
  recordGreenRun(first, first.run)

  const second = await plan()
  assert.deepEqual(relativeNames(second.skip), relativeNames(ALL()))
  assert.deepEqual(second.run, [])
})

test('editing a file invalidates only the tests whose graph contains it', async () => {
  const warm = await plan()
  recordGreenRun(warm, warm.run)

  write('apps/app/src/helper.ts', 'export const helper = 99\n')
  const after = await plan()

  assert.deepEqual(relativeNames(after.run), ['apps/app/src/uses-helper.test.ts'])
  assert.deepEqual(relativeNames(after.skip), ['apps/app/src/standalone.test.ts', 'apps/app/src/uses-package.test.ts'])
})

test('reverting a change restores the hit, because the digest is content-derived not mtime-derived', async () => {
  write('apps/app/src/helper.ts', 'export const helper = 2\n')
  const restored = await plan()
  assert.deepEqual(restored.run, [])
  assert.deepEqual(relativeNames(restored.skip), relativeNames(ALL()))
})

test('editing a workspace package invalidates consumers even though it is external to the graph', async () => {
  // `packages: 'external'` keeps @printstream/* out of the esbuild graph, so this is the case a
  // graph-only digest would silently miss.
  write('packages/lib/src/index.ts', 'export const value = 42\n')
  const after = await plan()

  assert.deepEqual(relativeNames(after.run), ['apps/app/src/uses-package.test.ts'])
  assert.ok(!relativeNames(after.skip).includes('apps/app/src/uses-package.test.ts'))
})

test("a workspace package's own tests do not invalidate that package's consumers", async () => {
  write('packages/lib/src/index.ts', 'export const value = 1\n')
  const warm = await plan()
  recordGreenRun(warm, warm.run)

  write('packages/lib/src/index.test.ts', 'export const libTest = 777\n')
  const after = await plan()
  assert.deepEqual(after.run, [], 'a test-only edit in a dependency must not re-run its consumers')
})

test('a test that reads the repo from disk is never cached', async () => {
  write('apps/app/src/walks-tree.test.ts', "import { readdirSync } from 'node:fs'\nexport default readdirSync('.')\n")
  const files = [...ALL(), ...absolute('apps/app/src/walks-tree.test.ts')]

  const first = await planCachedRun({ workspaceRoot: sandbox, testFiles: files })
  recordGreenRun(first, first.run)
  const second = await planCachedRun({ workspaceRoot: sandbox, testFiles: files })

  assert.deepEqual(relativeNames(second.uncacheable), ['apps/app/src/walks-tree.test.ts'])
  assert.ok(
    relativeNames(second.run).includes('apps/app/src/walks-tree.test.ts'),
    'a file the digest cannot fully cover must run every time'
  )
})

test('a SELF-ANCHORED read in a plainly named helper disables the cache', async () => {
  // The scan used to cover the test file plus `*.testkit.*` / `test-utils/` only, so a plainly
  // named co-located helper slipped through: its read went unseen, the file was cached, and the
  // digest covered neither the helper's read nor the fixture it opens. Editing that fixture then
  // left the test recorded green and silently out of the suite, which is the one failure mode a
  // cache must not have. `import.meta.dirname` is what makes it a REPO read: the path is the
  // module's own location, so nothing the caller passes can account for it.
  write('apps/app/src/sample-fixtures.ts',
    "import { readFileSync } from 'node:fs'\nimport path from 'node:path'\n"
    + "export const sample = () => readFileSync(path.join(import.meta.dirname, 'sample.3mf'))\n")
  write('apps/app/src/reads-via-helper.test.ts', "import { sample } from './sample-fixtures'\nexport default sample\n")
  const files = [...ALL(), ...absolute('apps/app/src/reads-via-helper.test.ts')]

  const first = await planCachedRun({ workspaceRoot: sandbox, testFiles: files })
  recordGreenRun(first, first.run)
  const second = await planCachedRun({ workspaceRoot: sandbox, testFiles: files })

  assert.ok(
    relativeNames(second.uncacheable).includes('apps/app/src/reads-via-helper.test.ts'),
    'the read is in the graph, so it counts wherever in the graph it lives'
  )
  assert.ok(relativeNames(second.run).includes('apps/app/src/reads-via-helper.test.ts'))
})

test('a production module reading a CALLER-supplied path does not disable the cache', async () => {
  // The other half of the same rule, and the one that keeps the cache worth having: almost every api
  // module reads a file at a path its caller names (a tmpdir, a stub), which the digest already
  // covers. Disqualifying on that flagged 281 of 760 files instead of 59.
  write('apps/app/src/reads-argument.ts', "import { readFileSync } from 'node:fs'\nexport const load = (at: string) => readFileSync(at)\n")
  write('apps/app/src/uses-reader.test.ts', "import { load } from './reads-argument'\nexport default load\n")
  const files = [...ALL(), ...absolute('apps/app/src/uses-reader.test.ts')]

  const first = await planCachedRun({ workspaceRoot: sandbox, testFiles: files })
  recordGreenRun(first, first.run)
  const second = await planCachedRun({ workspaceRoot: sandbox, testFiles: files })

  assert.ok(!relativeNames(second.uncacheable).includes('apps/app/src/uses-reader.test.ts'))
  assert.ok(!relativeNames(second.run).includes('apps/app/src/uses-reader.test.ts'), 'it is a cache hit')
})

test('an explicit opt-out marker is honoured', async () => {
  write('apps/app/src/opted-out.test.ts', '// @validate-cache-never\nexport default 5\n')
  const files = [...ALL(), ...absolute('apps/app/src/opted-out.test.ts')]

  const first = await planCachedRun({ workspaceRoot: sandbox, testFiles: files })
  recordGreenRun(first, first.run)
  const second = await planCachedRun({ workspaceRoot: sandbox, testFiles: files })

  assert.ok(relativeNames(second.uncacheable).includes('apps/app/src/opted-out.test.ts'))
  assert.ok(relativeNames(second.run).includes('apps/app/src/opted-out.test.ts'))
})

test('the opt-out marker is honoured on a HELPER, not only on the test file', async () => {
  // The modules that genuinely read the repo from a self-anchored directory cannot be recognised by
  // a regex (they bind the path to a variable first), so the marker is the remedy and only the
  // module knows it needs one. Honouring it on the test file alone left it unable to say so.
  write('apps/app/src/knows-it-reads.ts', '// @validate-cache-never\nexport const value = 1\n')
  write('apps/app/src/imports-marked-helper.test.ts', "import { value } from './knows-it-reads'\nexport default value\n")
  const files = [...ALL(), ...absolute('apps/app/src/imports-marked-helper.test.ts')]

  const first = await planCachedRun({ workspaceRoot: sandbox, testFiles: files })
  recordGreenRun(first, first.run)
  const second = await planCachedRun({ workspaceRoot: sandbox, testFiles: files })

  assert.ok(relativeNames(second.uncacheable).includes('apps/app/src/imports-marked-helper.test.ts'))
  assert.ok(relativeNames(second.run).includes('apps/app/src/imports-marked-helper.test.ts'))
})

test('a changed salt input invalidates everything', async () => {
  const warm = await planCachedRun({ workspaceRoot: sandbox, testFiles: ALL() })
  recordGreenRun(warm, warm.run)
  assert.deepEqual((await plan()).run, [])

  // The installed dependency set is not in any import graph, so it has to ride in the salt.
  write('package-lock.json', '{"lockfileVersion":3}')
  const after = await plan()
  assert.deepEqual(relativeNames(after.run), relativeNames(ALL()))
})

test('the extracted runner helper is part of the salt', async () => {
  const warm = await plan()
  recordGreenRun(warm, warm.run)
  assert.deepEqual((await plan()).run, [])

  write('scripts/dev/lib/test-concurrency.mjs', '// changed runner policy\n')
  assert.deepEqual(relativeNames((await plan()).run), relativeNames(ALL()))

  write(
    'scripts/dev/lib/test-concurrency.mjs',
    readFileSync(path.join(repoRoot, 'scripts/dev/lib/test-concurrency.mjs'), 'utf8')
  )
})

test('the Prisma schema is part of the salt, because the generated client is in no import graph', async () => {
  // `packages: 'external'` keeps @prisma/client out of every graph and regenerating it does not
  // touch package-lock.json, so without this entry a schema change left every API test cached green.
  const warm = await plan()
  recordGreenRun(warm, warm.run)
  assert.deepEqual((await plan()).run, [])

  write('apps/api/prisma/schema.prisma', 'generator client { provider = "prisma-client-js" }\n// changed\n')
  assert.deepEqual(relativeNames((await plan()).run), relativeNames(ALL()))
})

test('the environment the runner keys off is part of the salt', async () => {
  write('package-lock.json', '{}')
  const warm = await plan()
  recordGreenRun(warm, warm.run)
  assert.deepEqual((await plan()).run, [])

  const previous = process.env.SELF_HOSTED
  // Flip to a value that DIFFERS from whatever the ambient environment already holds, rather than
  // hard-coding 'true'. This suite is itself run under `SELF_HOSTED=true` (the public-build check
  // that precedes every export), and there the warm run above was already recorded with it set, so
  // setting it again changed nothing, the plan was empty, and the assertion read as "the salt
  // ignores the environment" for a whole release's pre-export gate.
  process.env.SELF_HOSTED = previous === 'true' ? 'false' : 'true'
  try {
    // The public build strips private modules and flips behaviour, so a SELF_HOSTED run must never
    // reuse results proved without it.
    assert.deepEqual(relativeNames((await plan()).run), relativeNames(ALL()))
  } finally {
    if (previous === undefined) delete process.env.SELF_HOSTED
    else process.env.SELF_HOSTED = previous
  }
})

test('an unreadable salt input disables the cache instead of hashing around it', async () => {
  // A salt file that cannot be read means the digest would not cover something that changes
  // results. Renaming one used to degrade it to a constant, leaving every digest blind to it.
  rmSync(path.join(sandbox, 'scripts/dev/run-tests.mjs'))
  const result = await plan()
  assert.equal(result.enabled, false)
  assert.match(result.reason, /salt input unreadable \(scripts\/dev\/run-tests\.mjs\)/)
  assert.deepEqual(relativeNames(result.run), relativeNames(ALL()))

  write('scripts/dev/run-tests.mjs', readFileSync(path.join(repoRoot, 'scripts/dev/run-tests.mjs'), 'utf8'))
  write('apps/api/prisma/schema.prisma', 'generator client { provider = "prisma-client-js" }\n')
  assert.equal((await plan()).enabled, true)
})

test('a vanished graph input disables the cache instead of digesting its absence', async () => {
  // A digest built over a missing file would be stable, so restoring the file later would compare
  // against a result proved without it. In practice the esbuild pass fails to resolve the import
  // first, which disables the cache for the whole run; `computeDigest` returning null covers the
  // narrower race where a file disappears after that pass and before it is hashed.
  const warm = await plan()
  recordGreenRun(warm, warm.run)
  assert.deepEqual((await plan()).run, [])

  rmSync(path.join(sandbox, 'apps/app/src/helper.ts'))
  const after = await plan()
  assert.equal(after.enabled, false, 'an unresolvable graph must not yield digests')
  assert.match(after.reason, /import graph unavailable/)
  assert.deepEqual(relativeNames(after.run), relativeNames(ALL()), 'everything runs when the cache cannot be trusted')

  write('apps/app/src/helper.ts', 'export const helper = 2\n')
  assert.equal((await plan()).enabled, true)
})

test('the cache disables itself rather than guessing when it cannot be trusted', async () => {
  process.env.PRINTSTREAM_NO_TEST_CACHE = '1'
  try {
    const result = await plan()
    assert.equal(result.enabled, false)
    assert.deepEqual(relativeNames(result.run), relativeNames(ALL()))
    assert.deepEqual(result.skip, [])
  } finally {
    delete process.env.PRINTSTREAM_NO_TEST_CACHE
  }
})
