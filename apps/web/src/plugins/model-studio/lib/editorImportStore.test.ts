/**
 * The import seam's host-capability contract.
 *
 * Both rules here shipped broken on the public editor: `supportsLibrarySource` existed but had no
 * consumer, so "Load from library…" rendered on a host with no library and opened a workspace
 * picker that 403s; and the file input's `accept` was a hardcoded four-extension literal, so the
 * picker offered STEP and 3MF to a store that stages neither and only errored after the user had
 * chosen. Neither is catchable by the type checker, an optional callback passed unconditionally
 * type-checks fine, so the wiring is pinned at the source level below.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { importFileAccept } from './editorImportStore'
import { apiImportStore } from './editorImports'
import { createLocalImportStore, LocalImportError } from './localImportStore'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The `onX={…}` expression containing `at`, brace-matched so a nested object or arrow body does not
 * end it early. Returns null when `at` is not inside a JSX prop at all, which the caller treats as
 * ungated, since an unrecognized shape is exactly when a reviewer should look.
 */
function enclosingJsxProp(source: string, at: number): string | null {
  const before = source.slice(0, at)
  const start = before.lastIndexOf('={')
  if (start === -1) return null
  let depth = 0
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      // Closed before reaching `at`, so `at` sits in a LATER prop and this is the wrong opener.
      if (depth === 0) return index < at ? null : source.slice(start + 2, index).trim()
    }
  }
  return null
}

test('the api store offers every format its server can convert', () => {
  assert.equal(apiImportStore.supportsLibrarySource, true)
  assert.equal(importFileAccept(apiImportStore), '.stl,.step,.stp,.3mf')
})

test('a server-less store offers the same formats, having no library to import from', () => {
  const store = createLocalImportStore()
  // The one genuine difference between the hosts: no library. FORMATS are equal now that the 3MF
  // extraction and the STEP fold are shared and the OCCT WASM loads in the tab, a file must not
  // import differently depending on which host opened it.
  assert.equal(store.supportsLibrarySource, false)
  assert.deepEqual([...store.importableFormats].sort(), [...apiImportStore.importableFormats].sort())
  assert.equal(importFileAccept(store), '.stl,.step,.stp,.3mf')
  store.dispose()
})

test('an unsupported extension is still refused by name', async () => {
  const store = createLocalImportStore()
  const error = await store.stageFile(new File([new Uint8Array([1, 2, 3])], 'notes.txt'), 'object')
    .then(() => null, (thrown: unknown) => thrown)
  assert.ok(error instanceof LocalImportError)
  assert.match(error.message, /notes\.txt/)
  store.dispose()
})

/**
 * Keyed on the dangerous OPERATION rather than on prop names, so a fourth library entry point is
 * covered the day it is written. Whitespace is normalized first: a prettier re-wrap of a long JSX
 * prop must not read as a regression. The menus' own hide-the-row behaviour is asserted for real in
 * `editorPanels.libraryGating.test.tsx`; what can only be checked here is EditorView's wiring.
 */
test('nothing opens the workspace library picker without checking the store has a library', async () => {
  const normalized = (await readFile(path.join(PLUGIN_ROOT, 'EditorView.tsx'), 'utf8')).replace(/\s+/g, ' ')
  // Pin the gate's DEFINITION, not just its shape: `const canImportFromLibrary = true` satisfies
  // every ternary below while restoring the entire bug, and no render test mounts EditorView.
  assert.match(normalized, /const canImportFromLibrary = importStore\.supportsLibrarySource/)
  // Any spelling that OPENS the picker, not just `(true)`, a functional updater (`(open) => !open`)
  // is the same operation and slipped straight past a literal match. Closing it (`(false)`) is
  // legitimately ungated: the dialog's own onClose must work regardless of the store.
  const opens = [...normalized.matchAll(/setLibraryPickerOpen\((?!false\))/g)].map((match) => match.index)
  // Control: if the picker stops being opened this way, the guard below is measuring nothing.
  assert.ok(opens.length > 0, 'expected EditorView to open the library picker somewhere')

  const ungated = opens.filter((at) => {
    const expression = enclosingJsxProp(normalized, at)
    // Polarity matters as much as presence: an inverted ternary shows the picker on exactly the
    // host that cannot use it, and a check that merely looked for the identifier would accept it.
    return expression == null || !/^canImportFromLibrary \?/.test(expression) || !/: undefined$/.test(expression)
  })
  assert.deepEqual(ungated, [], 'every library-picker entry point must be `canImportFromLibrary ? … : undefined`')
})

test('the import picker takes its accept list from the store', async () => {
  const normalized = (await readFile(path.join(PLUGIN_ROOT, 'EditorView.tsx'), 'utf8')).replace(/\s+/g, ' ')
  // Both halves matter: the input must read the derived value, AND that value must come from the
  // store. Checking only the first let a literal be reintroduced one line up.
  assert.match(normalized, /accept=\{importAccept\}/)
  // Anchored on the closing paren of the memo body: an unanchored prefix match accepted
  // `importFileAccept(importStore) + ',.step,.stp,.3mf'`, which puts the whole bug back.
  assert.match(normalized, /const importAccept = useMemo\(\s*\(\) => importFileAccept\(importStore\),/)
  const hardcoded = /accept=\{?['"][^'"]*\.(?:stl|step|stp|3mf)/.exec(normalized)
  assert.equal(hardcoded, null, 'derive the accept list from the import store, not a literal')
})
