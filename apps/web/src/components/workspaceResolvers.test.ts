/**
 * The two workspace preset-resolve routes each have exactly ONE caller.
 *
 * This is a regression guard, not tidiness. `ProcessSettingsDialog` used to call
 * `/api/slicing/profiles/resolve-process` itself, typed against a hand-written structural copy of
 * `ResolveProcessConfigResponse`, and the copy had already started to rot: `baselineOrigin` was
 * invisible to the dialog until someone remembered to add it to the mirror by hand. That is the
 * standing rule about cross-process payloads: rebuilding a shared type field-by-field at a boundary
 * silently drops every field the contract later grows, so parse with the shared Zod schema instead.
 *
 * Neither half is catchable by the type checker: an inline `apiFetch` compiles, and a local
 * `type ResolveResponse = { … }` compiles even better because it is a valid supertype.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { readSourceTree, type SourceFile } from '../test-utils/sourceTree'

/** The module that is allowed to fetch each route. */
const OWNERS = new Map([
  ['/api/slicing/profiles/resolve-process', 'components/workspaceProcessResolver.ts'],
  ['/api/slicing/profiles/resolve-filament', 'components/library/workspaceFilamentResolver.ts'],
  ['/api/slicing/profiles/resolve-machine', 'components/workspaceMachineResolver.ts']
])

/** Module code only: a test naming one of these routes is describing the rule, not breaking it. */
async function appModules(): Promise<readonly SourceFile[]> {
  return (await readSourceTree()).filter((file) => !/\.test\.tsx?$/.test(file.relativePath))
}

/** The guards report offenders with `/` separators, whatever the platform's own is. */
function posixPath(relativePath: string) {
  return relativePath.replaceAll(path.sep, '/')
}

test('each workspace resolve route is fetched from exactly one module', async () => {
  const offenders: string[] = []
  let owned = 0
  for (const { relativePath, lines } of await appModules()) {
    const relative = posixPath(relativePath)
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
  for (const { relativePath, source } of await appModules()) {
    // A local alias of the shared name is fine (`type X = ResolveProcessConfigResponse`); a local
    // OBJECT type standing in for it is the mirror this guard exists to stop.
    for (const match of source.matchAll(/\btype\s+(\w*Resolve\w*Response\w*)\s*=\s*\{/g)) {
      offenders.push(`${posixPath(relativePath)}: local ${match[1]}`)
    }
  }
  assert.deepEqual(offenders, [], 'import the response type from @printstream/shared instead of re-declaring its shape')
})
