/**
 * The public shell must render the things a tool needs to speak to the user.
 *
 * `App` mounts the `Toaster` inside its `StatusToastStack`; `PublicToolApp` is a separate entry
 * branch and got neither. Every `toast.error` on `/3mf-editor` therefore went nowhere: importing a
 * 3MF with no printable geometry raised the right refusal, and the page showed absolutely nothing,
 * which reads as a click that did not register. Nothing else catches this: the editor's own tests
 * never mount a shell, and a missing toast host is not a type error.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readSourceFile } from './test-utils/sourceTree'

/** The shell all three tests read. `readSourceFile` caches it, so it is read once per process. */
const SHELL = 'PublicToolApp.tsx'

test('the public shell mounts a toast host', async () => {
  const { source } = await readSourceFile(SHELL)
  assert.match(source, /<Toaster\s*\/>/, 'public tools have no other way to report a failure')
  assert.match(source, /from '\.\/components\/Toaster'/)
})

test('the public shell positions its toasts through the shared stack', async () => {
  const { source } = await readSourceFile(SHELL)
  // A bare `Toaster` renders as an ordinary flex child of the full-height editor column, so every
  // toast steals height from the 3D viewport instead of floating over it, and none of the stack's
  // placement (portalled, fixed, above the modal layer, top-of-screen on a phone) applies.
  assert.match(source, /<StatusToastStack>\s*<Toaster\s*\/>\s*<\/StatusToastStack>/)
})

test('the public shell does not mount the workspace-only toast stacks', async () => {
  const { source } = await readSourceFile(SHELL)
  // These need a workspace, permissions, and the dispatch/slicing query providers. Mounting one
  // here would fire workspace-scoped queries on a page whose whole point is that it needs none.
  for (const workspaceOnly of ['DispatchToasts', 'SlicingToasts', 'EngineInstallToast', 'DeleteOperationToasts']) {
    assert.ok(!source.includes(workspaceOnly), `${workspaceOnly} needs a workspace`)
  }
})
