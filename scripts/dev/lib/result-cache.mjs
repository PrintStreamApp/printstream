/**
 * Content-addressed "this test file already passed" cache, shared across every worktree of a clone.
 *
 * Owns the decision of which test files a run may SKIP. A file is skipped only when the exact
 * bytes it would execute (itself plus its whole first-party import graph plus the salt below) have
 * already been proved green. Nothing here decides pass/fail; it only removes work that would
 * re-prove a known result.
 *
 * Why it exists: the suite is 760 files and ~645 CPU-seconds, and concurrency cannot help (each
 * `node --test` child already saturates ~2 cores, so wall time is flat from 6 to 12 workers). The
 * only lever left is running fewer files. Two cases dominate real waiting: the same unchanged tree
 * being validated twice in a row, and several sibling worktrees of one clone each validating a tree
 * that differs from the others in a single workspace. The cache is
 * keyed on content and lives outside the tree (see `repo-cache-dir.mjs`), so both collapse: the
 * second run of an unchanged tree does no work, and a worktree that only touched `apps/web`
 * inherits every api/shared/bridge/slicer result another checkout already proved.
 *
 * Contract and invariants:
 * - **Only a fully green run records anything.** Attributing per-file results from a failed run
 *   would mean trusting output parsing to have spotted every failure; a file wrongly recorded as
 *   green disappears from the suite until its bytes change, which is exactly the failure mode a
 *   cache must not have. A red run therefore teaches the cache nothing, and that is deliberate.
 * - **A file that cannot be hashed EXACTLY is never cached** (see `classify`). Unresolvable
 *   dynamic imports and tests that read the repo from disk both mean the digest would not cover
 *   everything the test depends on, so those files run every time.
 * - **Skipping is reported, never silent.** A cached run must not read like a full run; the caller
 *   prints what was skipped and why.
 * - The graph comes from esbuild with `packages: 'external'`, so it contains first-party files
 *   only. Workspace packages (`@printstream/*`) are external to that graph and are folded in
 *   separately as a whole-src hash, which over-invalidates within a package's consumers (any
 *   `packages/shared` change re-runs everything importing it) and is the correct direction to err.
 *
 * Counterpart: `scripts/dev/run-tests.mjs`, the only caller. Disable with `PRINTSTREAM_NO_TEST_CACHE=1`.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { repoCacheDir } from './repo-cache-dir.mjs'

/**
 * Bump when anything about how a digest is derived changes, so old entries cannot be misread as
 * covering inputs the new scheme also considers.
 */
const CACHE_FORMAT_VERSION = 2

/** Markers untouched for this long are swept; a stale entry costs nothing but disk. */
const PRUNE_AFTER_MS = 14 * 24 * 60 * 60 * 1000

/**
 * Reads that could pull in repo files the import graph does not cover.
 *
 * Applied at two strengths, because where the read lives changes what it means. In a TEST FILE or a
 * testkit/test-util helper, any read at all disqualifies: those write the call themselves and are
 * the ones that walk the source tree (the `apps/web/src` convention guards, the demo simulator's
 * capture directory, the fixture readers). In any OTHER module in the graph, a read is normally
 * against a path the test supplies (a tmpdir, a stub), which the digest already covers, so
 * disqualifying on it would flag 268 of 760 files instead of 59 and gut the cache on exactly the
 * api tests most likely to import an fs-touching module.
 *
 * What is dangerous there is a read anchored to the module's OWN location, and the honest limit of a
 * regex is that it can only see the ONE-LINE form ({@link SELF_ANCHORED_READ_PATTERN}). The
 * codebase's real self-anchored readers bind the directory to a variable first
 * (`const moduleDir = path.dirname(fileURLToPath(import.meta.url))`, then `readdirSync(moduleDir)`),
 * which no pattern here can follow.
 *
 * That gap is left open deliberately rather than closed by marking those modules, and the reason is
 * that IMPORTING one is not depending on it: every one of them
 * (`private-modules.ts`, `apply-migrations.ts`, `app-build-info.ts`, `dev-source-staleness.ts`)
 * reads inside a function, so a test only depends on the directory it walks if it CALLS that
 * function, which no static scan here can tell. Marking them measured at 244 of 761 files
 * uncacheable against 61, nearly all of it for tests that merely import `app.ts`. A test that does
 * call one declares itself with {@link NEVER_CACHE_MARKER}, which is now honoured on any input in
 * the graph rather than only on the test file, so a helper can own that declaration too.
 */
const FS_READ_PATTERN = /\b(readFileSync|readdirSync|globSync|opendirSync|readFile|readdir|opendir|glob)\s*\(/

/**
 * A read whose OWN ARGUMENT is anchored to the module's location, so it addresses a repo file the
 * caller never named. Measured over the real suite: matching the anchor anywhere in the file flags
 * 268 of 760 (`fileURLToPath(import.meta.url)` is idiomatic in modules that also read caller-supplied
 * paths), while requiring it inside the call flags 61 against the 59 of a test-file-only scan. It
 * cannot see an anchor bound to a variable first, which is what the opt-out marker is for.
 */
const SELF_ANCHORED_READ_PATTERN = /\b(readFileSync|readdirSync|globSync|opendirSync|readFile|readdir|opendir|glob)\s*\([^)]*\b(import\.meta\.(dirname|url)|__dirname|__filename)\b/

/** A file whose own reads count wholesale: the test itself, and the helpers written to serve it. */
const TEST_AUTHORED_PATTERN = /(\.test\.[tj]sx?$)|(\.testkit\.[tj]sx?$)|((^|\/)test-utils?\/)/

/**
 * An opt-out a file can declare when it knows it depends on something the digest cannot see.
 *
 * Honoured on EVERY input in a test's graph, not just the test file: the modules that genuinely read
 * the repo from a self-anchored directory are ordinary production modules, they cannot be recognised
 * by a regex (see above), and only they know what they read. Marking one disables the cache for
 * every test that imports it, which is the correct blast radius.
 */
const NEVER_CACHE_MARKER = '@validate-cache-never'

/** Sentinel for a file that could not be read, so a caller can refuse to build a digest from it. */
const MISSING = '\0missing'

/** Env vars that change which tests run or how they behave, so they belong in the salt. */
const SALT_ENV_KEYS = ['NODE_ENV', 'DATABASE_URL', 'TEST_ADMIN_DATABASE_URL', 'SELF_HOSTED']

/**
 * Decides which of `testFiles` can be skipped.
 *
 * Never throws: any failure (esbuild missing, a graph that will not build) degrades to "cache
 * nothing, run everything" with a stated reason, because a slow correct run beats a fast wrong one.
 *
 * @returns {Promise<{enabled: boolean, reason?: string, skip: string[], run: string[],
 *   uncacheable: string[], digests: Map<string, string>, store: string}>} paths are absolute,
 *   matching the input. Pass the whole result to {@link recordGreenRun}.
 */
export async function planCachedRun({ workspaceRoot, testFiles, saltExtras = {} }) {
  const store = markerDir(workspaceRoot)
  const disabled = (reason) => ({ enabled: false, reason, skip: [], run: testFiles, uncacheable: [], digests: new Map(), store })

  if (process.env.PRINTSTREAM_NO_TEST_CACHE === '1') return disabled('disabled by PRINTSTREAM_NO_TEST_CACHE')

  let graph
  try {
    graph = await buildGraph({ workspaceRoot, testFiles })
  } catch (error) {
    return disabled(`import graph unavailable (${error.message})`)
  }

  const salted = computeSalt({ workspaceRoot, saltExtras })
  if (salted.missing) return disabled(`salt input unreadable (${salted.missing})`)
  const salt = salted.salt
  const contentHashes = new Map()
  const hashOf = (relativePath) => {
    if (!contentHashes.has(relativePath)) {
      contentHashes.set(relativePath, hashFile(path.join(workspaceRoot, relativePath)))
    }
    return contentHashes.get(relativePath)
  }
  const packageHashes = new Map()
  const hashPackage = (name) => {
    if (!packageHashes.has(name)) packageHashes.set(name, hashWorkspacePackageSources(workspaceRoot, name))
    return packageHashes.get(name)
  }

  const digests = new Map()
  const uncacheable = []
  const skip = []
  const run = []
  mkdirSync(store, { recursive: true })
  const present = new Set(readdirSafe(store))

  for (const absolute of testFiles) {
    const relative = toPosixRelative(workspaceRoot, absolute)
    const entry = graph.entries.get(relative)
    if (!entry) {
      // No graph for this file (esbuild skipped it): treat as uncacheable rather than guessing.
      uncacheable.push(absolute)
      run.push(absolute)
      continue
    }

    const reason = classify({ workspaceRoot, relative, entry, graph })
    if (reason) {
      uncacheable.push(absolute)
      run.push(absolute)
      continue
    }

    const digest = computeDigest({ salt, entry, hashOf, hashPackage })
    if (digest === null) {
      uncacheable.push(absolute)
      run.push(absolute)
      continue
    }
    digests.set(absolute, digest)
    if (present.has(digest)) {
      touch(path.join(store, digest))
      skip.push(absolute)
    } else {
      run.push(absolute)
    }
  }

  prune(store)
  return { enabled: true, skip, run, uncacheable, digests, store }
}

/**
 * Records the given files as green.
 *
 * Call this ONLY after a run whose every selected file passed (see the module contract). Silent
 * best-effort: a cache we cannot write is a slow next run, never a failed this run.
 *
 * @param {{digests: Map<string, string>, store: string}} plan the result of {@link planCachedRun}
 * @param {string[]} files the files that actually ran and passed
 * @returns {number} how many results were recorded
 */
export function recordGreenRun(plan, files) {
  try {
    mkdirSync(plan.store, { recursive: true })
  } catch {
    return 0
  }
  let written = 0
  for (const file of files) {
    const digest = plan.digests.get(file)
    if (!digest) continue
    try {
      writeFileSync(path.join(plan.store, digest), '')
      written += 1
    } catch {
      // Ignore: a partially written cache is still a valid cache.
    }
  }
  return written
}

/** Removes every recorded result for the clone containing `workspaceRoot`. */
export function clearTestCache(workspaceRoot) {
  rmSync(markerDir(workspaceRoot), { recursive: true, force: true })
}

function markerDir(workspaceRoot) {
  return path.join(repoCacheDir(workspaceRoot), 'test-results')
}

/**
 * Builds the first-party import graph for every test file in one esbuild pass (~1.5s for 760
 * entries). `packages: 'external'` keeps node_modules and workspace packages out of the graph;
 * `write: false` means nothing is emitted, we only want the metafile.
 */
async function buildGraph({ workspaceRoot, testFiles }) {
  const esbuild = await import('esbuild')
  const result = await esbuild.build({
    entryPoints: testFiles,
    bundle: true,
    write: false,
    metafile: true,
    packages: 'external',
    platform: 'neutral',
    format: 'esm',
    logLevel: 'silent',
    outdir: path.join(workspaceRoot, '.esbuild-graph-unused'),
    absWorkingDir: workspaceRoot
  })

  // Files esbuild could not fully analyse. Its warning is the only signal that a dynamic import
  // was left out of the graph, which would make a digest cover less than the test actually runs.
  const unanalysable = new Set(
    result.warnings
      .filter((warning) => /did not match any files|could not be analyzed/i.test(warning.text))
      .map((warning) => warning.location?.file)
      .filter(Boolean)
  )

  const entries = new Map()
  for (const output of Object.values(result.metafile.outputs)) {
    if (!output.entryPoint) continue
    entries.set(output.entryPoint, {
      entryPoint: output.entryPoint,
      inputs: Object.keys(output.inputs).sort(),
      packages: workspacePackagesIn(result.metafile, Object.keys(output.inputs))
    })
  }

  return { entries, unanalysable }
}

/** Workspace packages (`@printstream/*`) a graph reaches, which are external to the graph itself. */
function workspacePackagesIn(metafile, inputs) {
  const names = new Set()
  for (const input of inputs) {
    for (const imported of metafile.inputs[input]?.imports ?? []) {
      if (imported.external && imported.path.startsWith('@printstream/')) {
        // Subpath imports (`@printstream/shared/three-mf`) resolve to the same package.
        names.add(imported.path.split('/').slice(0, 2).join('/'))
      }
    }
  }
  return [...names].sort()
}

/** Returns a reason string when the file must never be cached, or null when it may be. */
function classify({ workspaceRoot, relative, entry, graph }) {
  if (entry.inputs.some((input) => graph.unanalysable.has(input))) return 'unanalysable dynamic import'

  const source = readSafe(path.join(workspaceRoot, relative))
  // Unreadable means the scan below proves nothing, so it cannot clear the file for caching.
  if (source === null) return 'unreadable'

  // EVERY input in the graph, at the two strengths `FS_READ_PATTERN` documents, plus the opt-out
  // marker wherever it appears. Scoping the scan to the test file plus a named helper SHAPE was a
  // claim about today's tree; scanning every input at full strength is the opposite error and costs
  // most of the cache. Verdicts are memoised per FILE because a widely-imported module appears in
  // dozens of graphs: unmemoised this ran 15,081 reads over 1,678 distinct files on this tree, and
  // regex-scanned each of them again every time.
  for (const input of entry.inputs) {
    const verdict = input === relative
      ? readVerdictFrom(source)
      : readVerdictFor(workspaceRoot, input)
    if (verdict === null) return 'unreadable'
    if (verdict.optedOut) return 'opted out'
    if (!verdict.reads) continue
    if (input === relative || TEST_AUTHORED_PATTERN.test(input) || verdict.selfAnchored) {
      return 'reads the repo from disk'
    }
  }
  return null
}

/** @see classify. Memoised per file, keyed by repo-relative path. */
const readVerdicts = new Map()

function readVerdictFor(workspaceRoot, relative) {
  const cached = readVerdicts.get(relative)
  if (cached !== undefined) return cached
  const text = readSafe(path.join(workspaceRoot, relative))
  const verdict = text === null ? null : readVerdictFrom(text)
  readVerdicts.set(relative, verdict)
  return verdict
}

function readVerdictFrom(text) {
  return {
    optedOut: text.includes(NEVER_CACHE_MARKER),
    reads: FS_READ_PATTERN.test(text),
    selfAnchored: SELF_ANCHORED_READ_PATTERN.test(text)
  }
}

/**
 * Digest of everything the file executes, or null when an input could not be read.
 *
 * Null rather than a digest-over-"missing": a file that vanished between the graph pass and the
 * hash would otherwise get a stable digest derived from its absence, so a later run with the file
 * restored would compare against a result proved without it.
 */
function computeDigest({ salt, entry, hashOf, hashPackage }) {
  const hash = createHash('sha256')
  hash.update(salt)
  hash.update('\0entry\0')
  hash.update(entry.entryPoint)
  for (const input of entry.inputs) {
    if (hashOf(input) === MISSING) return null
    hash.update('\0')
    hash.update(input)
    hash.update('\0')
    hash.update(hashOf(input))
  }
  for (const name of entry.packages) {
    hash.update('\0pkg\0')
    hash.update(name)
    hash.update('\0')
    hash.update(hashPackage(name))
  }
  return hash.digest('hex')
}

/**
 * Repo-relative salt inputs. A missing one disables the cache rather than weakening a digest.
 *
 * `schema.prisma` is here because the generated client is invisible to everything else: the graph
 * runs with `packages: 'external'` so `@prisma/client` is never an input, `workspacePackagesIn`
 * only folds in `@printstream/*`, and regenerating the client does not touch `package-lock.json`.
 * Without it, editing the schema and running `db:generate` left every one of the ~58 API test files
 * that import Prisma digesting identically to the last green run, so validate reported the whole
 * suite already green for a change that could break every query in it. The migrations directory
 * needs no entry: the tests that read it (`apply-migrations`, `repair-migration-guards`) do their
 * own disk reads and are therefore never cached anyway.
 */
const SALT_FILES = [
  'package-lock.json',
  'tsconfig.base.json',
  'tsconfig.test.json',
  'scripts/dev/run-tests.mjs',
  'scripts/dev/lib/test-concurrency.mjs',
  'apps/api/prisma/schema.prisma'
]

/**
 * Everything outside the import graph that can still change a result: the toolchain, the installed
 * dependency set, the runner itself, and the env the runner keys off.
 *
 * This module hashes ITSELF by absolute path rather than by a repo-relative string. A relative
 * entry silently degrades to "missing" when the file is renamed, which would leave every digest
 * blind to the very code that computes it.
 *
 * @returns {{salt: string} | {missing: string}} the salt, or the first unreadable input
 */
function computeSalt({ workspaceRoot, saltExtras }) {
  const hash = createHash('sha256')
  hash.update(`v${CACHE_FORMAT_VERSION}\0`)
  hash.update(`node${process.versions.node.split('.')[0]}\0`)
  for (const file of SALT_FILES) {
    const digest = hashFile(path.join(workspaceRoot, file))
    if (digest === MISSING) return { missing: file }
    hash.update(`${file}\0${digest}\0`)
  }
  hash.update(`self\0${hashFile(fileURLToPath(import.meta.url))}\0`)
  for (const key of SALT_ENV_KEYS) {
    hash.update(`${key}=${process.env[key] ?? ''}\0`)
  }
  for (const [key, value] of Object.entries(saltExtras).sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(`${key}=${value}\0`)
  }
  return { salt: hash.digest('hex') }
}

/**
 * Hash of a workspace package's shippable sources. Test files are excluded so that editing one
 * package's tests does not invalidate every consumer's results in other workspaces.
 */
function hashWorkspacePackageSources(workspaceRoot, packageName) {
  const directory = workspaceDirectoryFor(workspaceRoot, packageName)
  if (!directory) return 'unresolved'
  const hash = createHash('sha256')
  const source = path.join(directory, 'src')
  for (const file of walkFiles(source)) {
    if (/\.test\.[tj]sx?$/.test(file)) continue
    hash.update(path.relative(source, file).split(path.sep).join('/'))
    hash.update('\0')
    hash.update(hashFile(file))
    hash.update('\0')
  }
  return hash.digest('hex')
}

let workspaceIndex

function workspaceDirectoryFor(workspaceRoot, packageName) {
  if (!workspaceIndex) {
    workspaceIndex = new Map()
    for (const group of ['apps', 'packages']) {
      for (const entry of readdirSafe(path.join(workspaceRoot, group), { withFileTypes: true })) {
        if (!entry.isDirectory?.()) continue
        const directory = path.join(workspaceRoot, group, entry.name)
        const manifest = readSafe(path.join(directory, 'package.json'))
        if (!manifest) continue
        try {
          workspaceIndex.set(JSON.parse(manifest).name, directory)
        } catch {
          // A malformed manifest just means that package is not indexed.
        }
      }
    }
  }
  return workspaceIndex.get(packageName)
}

/**
 * Yields files in NAME order, never raw directory order.
 *
 * The order is folded into a hash, so an unsorted walk makes the same bytes digest differently on
 * two checkouts whose directories were created in a different sequence (a fresh clone against an
 * incrementally updated worktree, or two filesystems). That does not corrupt anything, it just
 * silently stops every worktree sharing results with every other, which is the whole point of
 * keying the cache on the clone.
 *
 * Deliberately untested: `readdir` order is unspecified by POSIX but the filesystems this repo is
 * developed on (overlayfs, ext4 with dir_index) already return names sorted, so a regression test
 * written here would pass with the sort removed and read as coverage it does not provide.
 */
function* walkFiles(directory) {
  const entries = readdirSafe(directory, { withFileTypes: true })
    .slice()
    // Raw code-unit order, NOT `localeCompare`: that uses ICU's default locale, which is derived
    // from LANG/LC_ALL and differs between a full-icu and a small-icu Node build. Two worktrees of
    // one clone with different environments would then digest identical bytes differently, which is
    // precisely the machine-stability this sort exists to provide.
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = path.join(directory, entry.name)
    if (entry.isDirectory?.()) yield* walkFiles(full)
    else yield full
  }
}

function prune(store) {
  const cutoff = Date.now() - PRUNE_AFTER_MS
  for (const name of readdirSafe(store)) {
    const full = path.join(store, name)
    try {
      if (statSync(full).mtimeMs < cutoff) rmSync(full, { force: true })
    } catch {
      // Racing with another run's prune is fine.
    }
  }
}

function touch(file) {
  try {
    const now = new Date()
    utimesSync(file, now, now)
  } catch {
    // Only affects when the entry is swept.
  }
}

function hashFile(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return MISSING
  }
}

function readSafe(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function readdirSafe(directory, options) {
  try {
    return readdirSync(directory, options)
  } catch {
    return []
  }
}

function toPosixRelative(workspaceRoot, absolute) {
  return path.relative(workspaceRoot, absolute).split(path.sep).join('/')
}
