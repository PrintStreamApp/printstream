process.env.NODE_ENV = 'test'

/**
 * `apiFetch` serialises the body itself. Callers must not do it again.
 *
 * `body?: unknown` is passed through `JSON.stringify` inside `apiFetch`, so a
 * caller that hands it `JSON.stringify(x)` sends the STRING `"{\"a\":1}"`.
 * That is valid JSON but not a valid request body: Express's body-parser runs
 * in strict mode and rejects a non-object at the top level, so the endpoint
 * answers 500 with `createStrictSyntaxError` and the browser shows nothing but
 * "Internal server error".
 *
 * It cost eight call sites before it was noticed, because every one of them is
 * a mutation in a billing flow nobody exercises daily: retiring an account,
 * issuing a licence, renaming a key, self-hosted checkout, claiming a
 * community key, and creating a workspace from the billing scope. Typecheck
 * cannot catch it — `unknown` accepts a string quite happily — so the guard has
 * to be a source check, in the same spirit as `LazyDialogFallback.test.ts`.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : []
  })
}

test('no apiFetch caller stringifies its own body', () => {
  const offenders: string[] = []

  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, 'utf8')
    if (!source.includes('apiFetch')) continue
    const lines = source.split('\n')

    lines.forEach((line, index) => {
      if (!/body:\s*JSON\.stringify\(/.test(line)) return
      // Whose call is this body part of? A raw `fetch` MUST stringify, and
      // several modules legitimately do (the editor's import and export
      // paths), so a file-level check would flag them forever. Walk back to
      // the nearest call opener and only complain when it is `apiFetch`.
      for (let cursor = index; cursor >= 0 && index - cursor < 20; cursor -= 1) {
        const candidate = lines[cursor] ?? ''
        if (/\bapiFetch\s*[<(]/.test(candidate)) {
          offenders.push(`${path.relative(SRC, file)}:${index + 1}`)
          return
        }
        if (/\bfetch\w*\s*\(/.test(candidate)) return
      }
    })
  }

  assert.deepEqual(
    offenders,
    [],
    'apiFetch already serialises `body`; pass the object itself. Double-encoded '
      + `bodies are rejected by the server as invalid JSON. Offenders: ${offenders.join(', ')}`
  )
})

test('the scan actually reaches the files it is meant to check', () => {
  // The control. A broken walk would report zero offenders forever.
  const files = sourceFiles(SRC)
  assert.ok(files.length > 100, `expected to walk the web source, found ${files.length} files`)
  assert.ok(
    files.some((file) => file.endsWith(path.join('private', 'cloud', 'usePurchaseActions.ts'))),
    'the walk should reach the private cloud modules, where every offender lived'
  )
})
