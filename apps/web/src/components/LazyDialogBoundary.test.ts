import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { readSourceFile, readSourceTree } from '../test-utils/sourceTree'

/** The wrapper itself: the one module that may pair a `Suspense` with the loading shell. */
const OWNER = path.join('components', 'LazyDialogBoundary.tsx')

/** And the shell it renders, which necessarily names itself. */
const SHELL = path.join('components', 'LazyDialogFallback.tsx')

/**
 * A REGRESSION guard: a lazily-loaded dialog goes through `LazyDialogBoundary`, never a bare
 * `Suspense` around `LazyDialogFallback`.
 *
 * The pending state was already handled everywhere; the FAILED state was handled nowhere, and it is
 * the one that costs. `React.lazy` rejects when its chunk cannot be fetched, and with no error
 * boundary above it React unmounts from the root: the whole app goes blank, taking any unsaved work
 * with it. Measured on the public 3MF editor with the parameter table's chunk blocked, the document
 * went from 599 characters of rendered editor to 0.
 *
 * That is not a rare condition. A deploy renames every hashed chunk, and `appStaleness.ts`
 * deliberately does not reload a busy tab, which an open editor always is. So the tabs left on the
 * old bundle are exactly the ones holding unsaved work.
 *
 * Nothing else would catch a regression: a dialog wrapped in a bare `Suspense` renders identically
 * and the loss only appears the next time a chunk is missing, on someone else's machine.
 */
test('a lazy dialog uses LazyDialogBoundary, not a bare Suspense', async () => {
  const offenders: string[] = []
  for (const { relativePath: relative, lines } of await readSourceTree()) {
    if (!relative.endsWith('.tsx')) continue
    if (relative === OWNER || relative === SHELL) continue
    lines.forEach((line, index) => {
      if (!line.includes('LazyDialogFallback')) return
      // Prose, not JSX: the rule is quoted in several module headers, this file's included.
      const trimmed = line.trimStart()
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return
      offenders.push(`${relative}:${index + 1}`)
    })
  }
  assert.deepEqual(
    offenders,
    [],
    `Mount <LazyDialogBoundary> (it renders the shell AND survives a chunk that never loads):\n  ${offenders.join('\n  ')}`
  )
})

/**
 * The boundary is only worth having if it renders something the user can act on and get out of.
 *
 * Pinned at the source level for the same reason as the rule above: an error boundary whose
 * fallback drifted to `null` would look fine (the app no longer blanks) while leaving the caller's
 * open-state stuck true, so the button that opened the dialog goes inert with nothing on screen to
 * explain it.
 */
test('the boundary offers a way out of a failed dialog', async () => {
  const { source } = await readSourceFile(OWNER)
  assert.match(source, /getDerivedStateFromError/, 'it must actually be an error boundary')
  assert.match(source, /onClose/, 'the notice must reset the caller\'s open state')
  assert.match(source, /BackAwareModal/, 'the notice is a real dialog, so Escape and Back must close it')
  // Reloading here is `appStaleness.ts`'s call, not this component's: it would destroy the unsaved
  // work the boundary exists to keep reachable.
  assert.doesNotMatch(source, /location\s*\.\s*reload/, 'the boundary must not reload the page')
})
