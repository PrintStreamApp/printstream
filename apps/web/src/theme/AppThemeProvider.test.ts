import assert from 'node:assert/strict'
import test from 'node:test'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The one module allowed to mount Joy's provider, because it pins the mode. */
const OWNER = path.join('theme', 'AppThemeProvider.tsx')

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) yield full
  }
}

/**
 * A REGRESSION guard: app code must mount `AppThemeProvider`, never Joy's
 * `CssVarsProvider` directly.
 *
 * Joy persists its mode per ORIGIN, and a stored value outranks `defaultMode`. A
 * bare `<CssVarsProvider>` defaults to `light`, so mounting one anywhere on the
 * origin, a scratch page, a demo route, a stray import, writes `light` into
 * storage and every subsequent load of the real app inherits it. This app has no
 * light palette, so the result is Joy's untested stock light theme with no way for
 * the user to get back. That happened once already, via a throwaway probe page on
 * the dev origin; the marketing feature cards rendered solid white.
 *
 * Render tests and their `.testkit.` harnesses are exempt: jsdom is a fresh origin
 * per run, so they cannot poison a real browser.
 */
test('app code mounts AppThemeProvider, never Joy CssVarsProvider directly', async () => {
  const offenders: string[] = []

  for await (const file of walk(SRC_ROOT)) {
    const relative = path.relative(SRC_ROOT, file)
    if (relative === OWNER || relative.includes('.test.') || relative.includes('.testkit.')) continue

    const lines = (await readFile(file, 'utf8')).split('\n')
    lines.forEach((line, index) => {
      if (!line.includes('CssVarsProvider')) return
      const trimmed = line.trimStart()
      // Prose, not code: this rule is quoted in several module headers.
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return
      offenders.push(`${relative}:${index + 1}`)
    })
  }

  assert.deepEqual(
    offenders,
    [],
    `Use <AppThemeProvider theme={…}> from theme/AppThemeProvider instead of Joy's CssVarsProvider:\n  ${offenders.join('\n  ')}`
  )
})
