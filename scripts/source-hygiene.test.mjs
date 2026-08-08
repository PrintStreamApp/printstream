/**
 * Repo hygiene: no raw NUL byte in a tracked text file.
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
