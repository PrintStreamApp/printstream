/**
 * Repo hygiene: static rules over the tracked tree, for defects that a normal
 * test cannot catch because they are invisible in the environment that writes
 * them. Each rule below states the trap it closes.
 *
 * Rule 1 - no raw NUL byte in a tracked text file.
 *
 * A file containing 0x00 is classified BINARY by git (these are `text: auto`, so
 * detection is content-based). That is permanent until fixed and costs more than
 * it sounds: `git diff` prints "Binary files differ", `git blame` stops working,
 * merges cannot 3-way and any concurrent edit becomes a hard conflict, and a
 * change to the file shows nothing in review.
 *
 * It is also invisible while editing -- most terminals render a NUL as a space,
 * so `.join('SPACE')` reads exactly like `.join('\u0000')`. Three files carried
 * one for months before anyone noticed, and the tool used to write the handoff
 * about them emitted more by interpreting the escape.
 *
 * The fix is never to remove the character: write it as the escape, which
 * produces the identical string at runtime. See `notification-snapshots.ts` for
 * the convention.
 *
 * Rule 2 - no `cpSync(..., { dereference: true })`.
 *
 * On Node 22 that option throws `ERR_FS_EISDIR` for a symlink pointing at an
 * ordinary file; on Node 20 it copies correctly. Local dev runs 20 and CI runs
 * 22, so the defect passes review, passes `npm run validate`, and then fails
 * every CI build. It did: `server-packages` was broken from 2026-08-11 to
 * 2026-08-22 staging `libpq.so.5`. `copyFileSync` dereferences on every version
 * and preserves the mode, so it is the single-file answer; a genuine tree copy
 * wants `{ recursive: true }`, which is unaffected.
 *
 * This is a STATIC rule on purpose. A behavioural test would only fail on Node
 * 22, i.e. it would reproduce the exact blind spot that let this ship.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Extensions whose content is genuinely binary, where a NUL means nothing. */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf',
  '.mp4', '.webm', '.mov', '.woff', '.woff2', '.ttf', '.otf',
  '.zip', '.gz', '.br', '.3mf', '.stl', '.step', '.stp', '.wasm'
])

test('no tracked text file contains a raw NUL byte', () => {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)

  const offenders = []
  for (const name of tracked) {
    if (BINARY_EXTENSIONS.has(path.extname(name).toLowerCase())) continue
    const absolute = path.join(repoRoot, name)
    let contents
    try {
      if (!statSync(absolute).isFile()) continue
      contents = readFileSync(absolute)
    } catch {
      // Tracked but absent (a submodule or a partial checkout) is not our business.
      continue
    }
    const count = contents.filter((byte) => byte === 0).length
    if (count > 0) offenders.push(`${name} (${count})`)
  }

  assert.deepEqual(
    offenders,
    [],
    `raw NUL bytes make these files binary to git; write the character as the \\u0000 escape instead:\n  ${offenders.join('\n  ')}`
  )
})

/** Source extensions that can call into `node:fs`. */
const SCRIPT_EXTENSIONS = new Set(['.mjs', '.cjs', '.js', '.ts', '.tsx', '.mts', '.cts'])

test('no tracked source copies a single file with cpSync + dereference', () => {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)

  const offenders = []
  for (const name of tracked) {
    if (!SCRIPT_EXTENSIONS.has(path.extname(name).toLowerCase())) continue
    if (name === 'scripts/source-hygiene.test.mjs') continue
    if (name.includes('/dist/')) continue
    let contents
    try {
      if (!statSync(path.join(repoRoot, name)).isFile()) continue
      contents = readFileSync(path.join(repoRoot, name), 'utf8')
    } catch {
      continue
    }
    contents.split('\n').forEach((line, index) => {
      // Prose explaining the ban (including this rule's own docs) is not a call site.
      if (/^\s*(\/\/|\/\*|\*)/.test(line)) return
      // Same statement, so the option object has to sit on the cpSync line.
      if (/\bcpSync\(/.test(line) && /\bdereference\s*:\s*true/.test(line)) {
        offenders.push(`${name}:${index + 1}`)
      }
    })
  }

  assert.deepEqual(
    offenders,
    [],
    'cpSync + dereference throws ERR_FS_EISDIR on a symlink under Node 22 (CI) while passing on Node 20 (local).\n'
      + `Use copyFileSync for a single file:\n  ${offenders.join('\n  ')}`
  )
})

/**
 * Rule 3 - no em dash on a line this branch ADDED.
 *
 * The house style bans `—` from everything that gets committed or published: commit messages,
 * PR bodies, code comments, docs, and UI strings. It is a rule no reviewer should have to spend
 * attention on, and one that is broken in bulk when it is broken at all: a single change added 24
 * in one sitting, while the same change was removing them from three generator headers.
 *
 * DIFF-based, not tree-based, for two reasons. The tree already carries ~2400 of them, nearly all
 * in markdown (the backlog tracked by issue #100), so a whole-tree rule could not pass today. And a
 * committed baseline would have to name every offending file, 20 of which live under `private/`,
 * which would publish that structure into the OSS snapshot: this test is a shipped file.
 *
 * A missing base ref is a SKIP, never a failure. A shallow CI clone or a fresh checkout with no
 * remote cannot tell what is new, and refusing to build on that is worse than the defect.
 *
 * A line that genuinely needs the character (a test asserting how one is handled, vendored text)
 * opts out with an `em-dash-ok` marker on the same line.
 */
const EM_DASH = '—'

/** The branch point to diff against, or null when the repo cannot tell us. */
function resolveDiffBase() {
  for (const ref of ['origin/dev', 'origin/main', 'dev', 'main']) {
    try {
      const base = execFileSync('git', ['merge-base', 'HEAD', ref], {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'ignore']
      }).toString('utf8').trim()
      if (base) return base
    } catch {
      // Ref not present in this clone; try the next.
    }
  }
  return null
}

test('no em dash is introduced on a changed line', (t) => {
  const base = resolveDiffBase()
  if (!base) {
    t.skip('no base ref to diff against (shallow clone or no remote)')
    return
  }

  // Working tree against the branch point, so it covers commits on the branch AND uncommitted
  // edits: the point is to catch them before they are committed, not after.
  const diff = execFileSync('git', ['diff', '--unified=0', '--no-color', base, '--'], {
    cwd: repoRoot,
    maxBuffer: 256 * 1024 * 1024
  }).toString('utf8')

  const offenders = []
  let file = null
  let lineNumber = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) { file = line.slice(6); continue }
    if (line.startsWith('@@')) {
      // `@@ -a,b +c,d @@` - `c` is the first line number of the added run.
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line)
      lineNumber = match ? Number(match[1]) : 0
      continue
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue
    const text = line.slice(1)
    if (file && text.includes(EM_DASH) && !text.includes('em-dash-ok')) {
      // Generated files are the generator's output; fix the generator, not the artifact.
      if (!file.includes('.generated.') && file !== 'scripts/source-hygiene.test.mjs') {
        offenders.push(`${file}:${lineNumber}`)
      }
    }
    lineNumber += 1
  }

  // A file that is NEW and not yet committed shows up in no diff, so every one of its lines counts
  // as added. Missing this made the rule blind to exactly the case that motivated it: the change
  // that added 24 em dashes added several new files.
  const untracked = execFileSync('git', ['ls-files', '-z', '--others', '--exclude-standard'], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024
  }).toString('utf8').split('\0').filter(Boolean)
  for (const name of untracked) {
    if (BINARY_EXTENSIONS.has(path.extname(name).toLowerCase())) continue
    if (name.includes('.generated.')) continue
    let contents
    try {
      if (!statSync(path.join(repoRoot, name)).isFile()) continue
      contents = readFileSync(path.join(repoRoot, name), 'utf8')
    } catch {
      continue
    }
    contents.split('\n').forEach((text, index) => {
      if (text.includes(EM_DASH) && !text.includes('em-dash-ok')) offenders.push(`${name}:${index + 1}`)
    })
  }

  assert.deepEqual(
    offenders,
    [],
    `em dashes are not used in committed text; use a comma, colon, parentheses or a separate sentence:\n  ${offenders.join('\n  ')}`
  )
})
