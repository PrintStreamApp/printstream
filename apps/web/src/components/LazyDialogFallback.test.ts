import assert from 'node:assert/strict'
import test from 'node:test'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Opt out on the line above a boundary that genuinely should render nothing while it loads. */
const OPT_OUT = 'suspense-fallback-null-ok'

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.name.endsWith('.tsx')) yield full
  }
}

/**
 * Every lazily-loaded dialog must show something while its chunk downloads.
 *
 * This is a REGRESSION guard, not a style rule: `fallback={null}` on a code-split dialog means the
 * click that opens it paints nothing at all until the chunk lands — on the 3MF editor that was
 * ~800KB of dead air, which reads as a click that did nothing. `LazyDialogFallback` renders the
 * dialog's shell instead. A new `lazy()` dialog added without a fallback silently reintroduces the
 * bug and no other test would catch it, so the check lives at the source level.
 */
test('no Suspense boundary renders a null fallback', async () => {
  const offenders: string[] = []
  for await (const file of walk(SRC_ROOT)) {
    const lines = (await readFile(file, 'utf8')).split('\n')
    lines.forEach((line, index) => {
      if (!line.includes('fallback={null}')) return
      // Prose, not a prop: this very rule is quoted in comments (including LazyDialogFallback's).
      const trimmed = line.trimStart()
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return
      // The opt-out sits on the line itself or the one above it (JSX prop comments read better
      // on their own line).
      if (line.includes(OPT_OUT) || (lines[index - 1]?.includes(OPT_OUT) ?? false)) return
      offenders.push(`${path.relative(SRC_ROOT, file)}:${index + 1}`)
    })
  }
  assert.deepEqual(
    offenders,
    [],
    `Suspense boundaries with a null fallback (use <LazyDialogFallback>, or mark the line ${OPT_OUT}):\n  ${offenders.join('\n  ')}`
  )
})
