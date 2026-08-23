import assert from 'node:assert/strict'
import test from 'node:test'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The modules allowed to name determinacy, because each DERIVES it from `value`
 * rather than taking it as a second, independently-settable prop.
 */
const OWNERS = new Set([
  path.join('components', 'ProgressBar.tsx'),
  path.join('components', 'ProgressSpinner.tsx'),
  path.join('components', 'printerJobProgressStyles.ts')
])

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) yield full
  }
}

/**
 * A REGRESSION guard, not a style rule.
 *
 * Joy's `LinearProgress`/`CircularProgress` take the *size of the moving segment*
 * from the same `value` prop a determinate bar uses for its *position*, so the
 * natural-looking `determinate={x != null} value={x ?? 0}` renders a zero-width
 * segment: the indeterminate bar animates nothing and reads as stuck. Fourteen
 * surfaces independently wrote that pair, and nothing, typecheck, lint, or render
 * test, objects to it, because both props are individually valid.
 *
 * `ProgressBar`/`ProgressSpinner` derive determinacy from `value`, which makes the
 * pair unwritable. This keeps the raw props from coming back. Note that a bare
 * `<CircularProgress size="sm" />` with no `determinate` and no `value` is safe and
 * deliberately not flagged.
 */
test('progress determinacy is decided by ProgressBar/ProgressSpinner, not by call sites', async () => {
  const offenders: string[] = []

  for await (const file of walk(SRC_ROOT)) {
    const relative = path.relative(SRC_ROOT, file)
    if (OWNERS.has(relative) || relative.includes('.test.')) continue

    const lines = (await readFile(file, 'utf8')).split('\n')
    lines.forEach((line, index) => {
      // `indeterminate` is Checkbox's tri-state prop, not this.
      if (!/(?<![A-Za-z])determinate(?![A-Za-z])/.test(line)) return
      const trimmed = line.trimStart()
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return
      offenders.push(`${relative}:${index + 1}`)
    })
  }

  assert.deepEqual(
    offenders,
    [],
    'Use <ProgressBar value={…}> / <ProgressSpinner value={…}> and pass null when the extent is '
      + `unknown, instead of Joy's determinate prop:\n  ${offenders.join('\n  ')}`
  )
})
