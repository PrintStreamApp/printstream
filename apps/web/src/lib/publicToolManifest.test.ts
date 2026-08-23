/**
 * The manifest and the router that serves it must agree.
 *
 * `Root` picks the light `PublicToolApp` shell purely from this manifest, but the ROUTES live in
 * that component. A path listed here with no matching `<Route>` therefore renders the shell's
 * catch-all, a blank page, not a 404 and not the app, while a route added there but omitted here
 * never gets the shell at all: `Root` hands the path to the app branch, which redirects an
 * anonymous visitor to sign-in. Both failures look like the tool "not existing" and neither is a
 * type error, so the two lists are pinned against each other here.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PUBLIC_TOOL_ROUTE_PATHS, isPublicToolPath } from './publicToolManifest'

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The attribute text of each `<Route … />`. Scanned rather than regexed because an element prop
 * (`element={<LocalProjectEditor />}`) contains both `>` and `/>`, so any regex that stops at the
 * first one truncates the attributes and silently reports the route as unrouted.
 */
function routeElements(source: string): string[] {
  const out: string[] = []
  for (const match of source.matchAll(/<Route\b/g)) {
    const start = match.index + '<Route'.length
    let depth = 0
    for (let index = start; index < source.length - 1; index += 1) {
      const char = source[index]
      if (char === '{') depth += 1
      else if (char === '}') depth -= 1
      else if (depth === 0 && char === '/' && source[index + 1] === '>') {
        out.push(source.slice(start, index))
        break
      }
    }
  }
  return out
}

test('every manifest path is routed by the public shell, and vice versa', async () => {
  const source = await readFile(path.join(SRC_ROOT, 'PublicToolApp.tsx'), 'utf8')
  // Attribute order is not fixed, so read both parts out of the whole element. A route whose
  // element is `null` is the blank page this test exists to prevent, so it does not count as
  // routed: matching on `path=` alone would have accepted exactly that.
  // Routes generated FROM the manifest cannot drift from it by construction, which is the strongest
  // possible form of this guarantee, so accept it instead of punishing it.
  if (/PUBLIC_TOOL_ROUTE_PATHS\s*\.\s*map\s*\(/.test(source)) return

  const routed = routeElements(source).flatMap((attributes) => {
    const route = /\bpath="([^"]+)"/.exec(attributes)?.[1]
    if (!route || route === '*') return []
    const element = /\belement=\{([\s\S]*?)\}\s*$|\belement=\{([\s\S]*)\}/.exec(attributes)
    const rendered = (element?.[1] ?? element?.[2] ?? '').trim()
    // `null`, `undefined` and an empty fragment all paint the blank page this guard exists to stop.
    const paintsNothing = !rendered || rendered === 'null' || rendered === 'undefined' || /^<>\s*<\/>$/.test(rendered)
    return paintsNothing ? [] : [route]
  })
  assert.deepEqual(routed.sort(), [...PUBLIC_TOOL_ROUTE_PATHS].sort())
})

test('only the manifest paths take the public shell', () => {
  for (const route of PUBLIC_TOOL_ROUTE_PATHS) assert.equal(isPublicToolPath(route), true)
  // A sub-path is NOT a tool path: the manifest is an exact-match list, and `Root` treats anything
  // else as an app route.
  assert.equal(isPublicToolPath('/3mf-editor/settings'), false)
  assert.equal(isPublicToolPath('/library'), false)
  assert.equal(isPublicToolPath('/'), false)
})
