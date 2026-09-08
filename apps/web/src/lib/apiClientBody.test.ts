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
 * cannot catch it, `unknown` accepts a string quite happily, so the guard has
 * to be a source check, in the same spirit as `LazyDialogFallback.test.ts`.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { WEB_SRC_ROOT, readSourceTree, type SourceFile } from '../test-utils/sourceTree'

/** App code only: a test may quote a double-encoded body as the very thing it is asserting about. */
async function appModules(): Promise<readonly SourceFile[]> {
  return (await readSourceTree()).filter((file) => !/\.test\.tsx?$/.test(file.relativePath))
}

test('no apiFetch caller stringifies its own body', async () => {
  const offenders: string[] = []

  for (const { relativePath, source, lines } of await appModules()) {
    if (!source.includes('apiFetch')) continue

    lines.forEach((line, index) => {
      if (!/body:\s*JSON\.stringify\(/.test(line)) return
      // Whose call is this body part of? A raw `fetch` MUST stringify, and
      // several modules legitimately do (the editor's import and export
      // paths), so a file-level check would flag them forever. Walk back to
      // the nearest call opener and only complain when it is `apiFetch`.
      for (let cursor = index; cursor >= 0 && index - cursor < 20; cursor -= 1) {
        const candidate = lines[cursor] ?? ''
        if (/\bapiFetch\s*[<(]/.test(candidate)) {
          offenders.push(`${relativePath}:${index + 1}`)
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

test('the scan actually reaches the files it is meant to check', async () => {
  // The control. A broken walk would report zero offenders forever.
  const files = await appModules()
  assert.ok(files.length > 100, `expected to walk the web source, found ${files.length} files`)
  // Anchored on a CORE file: the public snapshot ships no `private/` at all, so
  // a control that names one fails there for a reason that has nothing to do
  // with the walk, which is not a control, it is a false alarm.
  assert.ok(
    files.some((file) => file.relativePath === path.join('lib', 'apiClient.ts')),
    'the walk should reach the core lib modules'
  )
  // Where every offender actually lived, asserted only where that tree exists.
  if (existsSync(path.join(WEB_SRC_ROOT, 'private'))) {
    assert.ok(
      files.some((file) => file.relativePath.includes(path.join('private', 'cloud'))),
      'the walk should reach the private cloud modules, where every offender lived'
    )
  }
})
