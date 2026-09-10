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
 * ordinary file; on Node 20 it copies correctly. Local dev once ran 20 while CI
 * ran 22, so the defect passed review and local validation, then failed every CI
 * build. It did: `server-packages` was broken from 2026-08-11 to
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
    'cpSync + dereference throws ERR_FS_EISDIR on a symlink under Node 22 while passing on Node 20.\n'
      + `Use copyFileSync for a single file:\n  ${offenders.join('\n  ')}`
  )
})

/**
 * Rule 3 - no em dash (U+2014) anywhere in the tree.
 *
 * The house style bans the character from everything that gets committed or published: commit
 * messages, PR bodies, code comments, docs, and UI strings. It is a rule no reviewer should have
 * to spend attention on, and one that is broken in bulk when it is broken at all: a single change
 * added 24 in one sitting, while the same change was removing them from three generator headers.
 *
 * WHOLE-TREE since issue #100 cleared the backlog. It was diff-based before that, because the
 * tree carried ~2,400 of them (nearly all in markdown) and a whole-tree rule could not have
 * passed. A diff rule has two holes this one does not: it cannot see a dash that arrives on an
 * UNCHANGED line through a revert, a rename, or a cherry-pick, and it SKIPS outright when no base
 * ref resolves, which is exactly the shallow-clone CI case it most needed to cover. Scanning the
 * tree needs no committed baseline either, which matters because a baseline would have had to
 * name every offending file, 20 of them under `private/`, publishing that structure into the OSS
 * snapshot: this test is a shipped file.
 *
 * Untracked files are scanned too, because a file that is NEW and not yet committed is where the
 * rule was previously blindest: the change that added 24 dashes added several new files. A nested
 * git worktree is safe to leave in, and must be: `git ls-files --others` reports one whose
 * directory holds a `.git` entry as a single directory name and never descends into it, so a
 * sibling worktree mid-edit cannot fail validate in the main clone.
 *
 * The character is written below as an escape rather than a literal, so this file does not have
 * to exempt itself from its own rule. Same convention as Rule 1.
 *
 * A line that genuinely needs the character (a test asserting how one is handled, vendored text)
 * opts out with an `em-dash-ok` marker on the same line.
 */
const EM_DASH = '\u2014'

/**
 * Paths whose em dashes are not ours to rewrite.
 *
 * A Prisma migration is checksummed into `_prisma_migrations` when it is applied, so editing the
 * SQL, comments included, makes `prisma migrate` refuse to run against every database that
 * already ran it. The notices files are vendored licence text reproduced verbatim by
 * `scripts/dev/generate-third-party-notices.mjs`, and a generated artifact is the generator's
 * output rather than something to edit in place.
 */
function isExemptFromEmDashRule(name) {
  return name.startsWith('apps/api/prisma/migrations/')
    || name.endsWith('THIRD-PARTY-NOTICES.txt')
    || name.includes('.generated.')
}

test('no em dash appears anywhere in the tree', () => {
  const list = (extra) => execFileSync('git', ['ls-files', '-z', ...extra], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024
  }).toString('utf8').split('\0').filter(Boolean)

  const offenders = []
  for (const name of [...list([]), ...list(['--others', '--exclude-standard'])]) {
    if (BINARY_EXTENSIONS.has(path.extname(name).toLowerCase())) continue
    if (isExemptFromEmDashRule(name)) continue
    let contents
    try {
      const absolute = path.join(repoRoot, name)
      if (!statSync(absolute).isFile()) continue
      contents = readFileSync(absolute, 'utf8')
    } catch {
      // Tracked but absent, or an untracked directory entry; neither is our business.
      continue
    }
    // Cheap reject first: almost every file in the tree has none.
    if (!contents.includes(EM_DASH)) continue
    contents.split('\n').forEach((text, index) => {
      if (text.includes(EM_DASH) && !text.includes('em-dash-ok')) offenders.push(`${name}:${index + 1}`)
    })
  }

  assert.deepEqual(
    offenders,
    [],
    'em dashes are not used in committed text; use a comma, colon, semicolon, parentheses or a '
      + `separate sentence:\n  ${offenders.join('\n  ')}`
  )
})
