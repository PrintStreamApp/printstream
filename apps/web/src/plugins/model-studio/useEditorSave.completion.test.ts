/**
 * Regression guard for the boundary between a completed save and cache refresh.
 *
 * A library invalidation can refetch active queries and wait on the network. The persisted file is
 * already committed by then, so awaiting that refresh keeps the blocking save dialog open while no
 * save work remains. The hook must release the user first and let cache convergence run in the
 * background.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('./useEditorSave.ts', import.meta.url)), 'utf8')

test('a completed save does not wait for library query refetches', () => {
  assert.doesNotMatch(source, /await\s+invalidateLibraryQueries\(/)
  assert.match(source, /void\s+invalidateLibraryQueries\(queryClient\)\.catch\(/)
})

test('the concurrent-save check uses the lightweight cancellable version endpoint', () => {
  assert.match(source, /`\/api\/library\/\$\{fileId\}\/current-version`/)
  assert.match(source, /signal,\s*timeoutMs:\s*5_000/)
  assert.doesNotMatch(source, /apiFetch<\{ file: \{ currentVersionNumber/)
})

test('a failed concurrent-save check leaves an operational warning before allowing the save', () => {
  assert.match(source, /catch \(error\) \{\s*signal\?\.throwIfAborted\(\)\s*console\.warn\(/)
  assert.match(source, /could not check the current version of project/)
})
