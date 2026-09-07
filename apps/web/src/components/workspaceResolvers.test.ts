/**
 * The two workspace preset-resolve routes each have exactly ONE caller.
 *
 * This is a regression guard, not tidiness. `ProcessSettingsDialog` used to call
 * `/api/slicing/profiles/resolve-process` itself, typed against a hand-written structural copy of
 * `ResolveProcessConfigResponse`, and the copy had already started to rot: `baselineOrigin` was
 * invisible to the dialog until someone remembered to add it to the mirror by hand. That is exactly
 * the boundary failure the root the development notes names ("rebuilding a shared type field-by-field at a
 * boundary silently drops every field the contract later grows").
 *
 * Neither half is catchable by the type checker: an inline `apiFetch` compiles, and a local
 * `type ResolveResponse = { … }` compiles even better because it is a valid supertype.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The module that is allowed to fetch each route. */
const OWNERS = new Map([
  ['/api/slicing/profiles/resolve-process', 'components/workspaceProcessResolver.ts'],
  ['/api/slicing/profiles/resolve-filament', 'components/library/workspaceFilamentResolver.ts'],
  ['/api/slicing/profiles/resolve-machine', 'components/workspaceMachineResolver.ts']
])

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) yield full
  }
}

test('each workspace resolve route is fetched from exactly one module', async () => {
  const offenders: string[] = []
  let owned = 0
  for await (const file of walk(SRC_ROOT)) {
    const relative = path.relative(SRC_ROOT, file).replaceAll(path.sep, '/')
    const lines = (await readFile(file, 'utf8')).split('\n')
    lines.forEach((line, index) => {
      for (const [route, owner] of OWNERS) {
        // The call, not a mention: prose in a module header names these routes on purpose.
        if (!line.includes(`apiFetch`) || !line.includes(route)) continue
        if (relative === owner) { owned += 1; return }
        offenders.push(`${relative}:${index + 1} fetches ${route} directly`)
      }
    })
  }
  // Control: if the owners stopped fetching, the scan below is measuring nothing.
  assert.equal(owned, OWNERS.size, 'each owner module should perform exactly one fetch')
  assert.deepEqual(offenders, [], 'call the resolver module instead, it names the shared response type')
})

test('nothing re-declares the resolve responses as a local structural type', async () => {
  const offenders: string[] = []
  for await (const file of walk(SRC_ROOT)) {
    const source = await readFile(file, 'utf8')
    // A local alias of the shared name is fine (`type X = ResolveProcessConfigResponse`); a local
    // OBJECT type standing in for it is the mirror this guard exists to stop.
    for (const match of source.matchAll(/\btype\s+(\w*Resolve\w*Response\w*)\s*=\s*\{/g)) {
      offenders.push(`${path.relative(SRC_ROOT, file).replaceAll(path.sep, '/')}: local ${match[1]}`)
    }
  }
  assert.deepEqual(offenders, [], 'import the response type from @printstream/shared instead of re-declaring its shape')
})
