/**
 * The runtime image must ship every file the compiled engine code imports.
 *
 * `src/engines/catalogue.ts` reaches OUT of `src/` for the pinned engine list
 * and download matrix (`docker/*.mjs`), because the container's baked-in set and
 * the runtime-installable set have to come from one source or they drift. That
 * import survives compilation as a relative path (`../../docker/x.mjs`), so
 * `dist/engines/catalogue.js` resolves it at `/app/apps/slicer/docker/x.mjs` in
 * the image -- and the Dockerfile's runtime stage copies `dist` alone.
 *
 * That gap is not a type error, not a test failure, and not visible in dev
 * (which runs from source, where the file is simply there). It surfaces only as
 * the deployed slicer crash-looping on `ERR_MODULE_NOT_FOUND`, which is how it
 * reached staging. This asserts the two lists agree.
 *
 * Counterpart: `apps/slicer/Dockerfile` (the `runtime` stage).
 */
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const slicerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * Every `docker/*.mjs` imported from anywhere under `src`.
 *
 * Scanned across the whole tree, not just `engines/`, so a second module
 * reaching out the same way is caught the day it is written rather than the day
 * it is deployed. Depth-agnostic on purpose -- the relative prefix differs by
 * nesting level and only the filename matters here.
 */
async function readEscapingImports(): Promise<string[]> {
  const found = new Set<string>()
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { await walk(full); continue }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
      const source = await readFile(full, 'utf8')
      for (const match of source.matchAll(/from '(?:\.\.\/)+docker\/([\w.-]+\.mjs)'/g)) {
        found.add(match[1]!)
      }
    }
  }
  await walk(path.join(slicerRoot, 'src'))
  return [...found].sort()
}

test('the Dockerfile runtime stage ships every docker/*.mjs the engine code imports', async () => {
  const imports = await readEscapingImports()
  // Guard the guard: if the imports ever move inside `src/`, this test must be
  // deleted rather than left passing vacuously over an empty list.
  assert.ok(imports.length > 0, 'expected src to import at least one docker/*.mjs')

  const dockerfile = await readFile(path.join(slicerRoot, 'Dockerfile'), 'utf8')
  // Only the runtime stage matters -- earlier stages copy the whole repo.
  const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('FROM '))

  for (const asset of imports) {
    const copied = runtimeStage.includes(`apps/slicer/docker/${asset} apps/slicer/docker/${asset}`)
    assert.ok(
      copied,
      `${asset} is imported from src but the Dockerfile runtime stage never copies it to `
        + `apps/slicer/docker/${asset}, so the container cannot start`
    )
  }
})
