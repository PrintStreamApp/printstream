/**
 * What a host is supposed to end up with, and the ways that list goes wrong.
 *
 * The parsing matters more than it looks: this is what stands between the
 * hosted deployment having every engine and a workspace's slice dialog losing
 * the version its project was saved by.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolvePreloadEngineIds } from './ensure-engines.js'
import { defaultCatalogueEngine, listCatalogue } from './catalogue.js'

const LINUX = ['linux', 'x64'] as const

test('unset means just the default, which is what a self-hoster wants', () => {
  const { ids } = resolvePreloadEngineIds(undefined, ...LINUX)
  assert.deepEqual(ids, [defaultCatalogueEngine(...LINUX)?.id])
  assert.deepEqual(resolvePreloadEngineIds('   ', ...LINUX).ids, ids)
})

test('"all" means every installable engine, which is what the hosted plan needs', () => {
  // Its users cannot install engines themselves, so a project saved by an older
  // Bambu Studio is unsliceable unless the deployment already has that engine.
  const { ids } = resolvePreloadEngineIds('all', ...LINUX)
  assert.deepEqual(ids, listCatalogue(...LINUX).map((engine) => engine.id))
  assert.ok(ids.length > 1)
  assert.deepEqual(resolvePreloadEngineIds('ALL', ...LINUX).ids, ids)
})

test('an explicit list is honoured, and a typo does not take the rest down with it', () => {
  const real = listCatalogue(...LINUX)[0]!.id
  const { ids, unknown } = resolvePreloadEngineIds(`${real}, not-an-engine`, ...LINUX)
  // One stale entry in a deployment's configuration must not leave the slicer
  // with no engine at all: the failure would be total and silent.
  assert.deepEqual(ids, [real])
  assert.deepEqual(unknown, ['not-an-engine'])
})

test('a host with no installable engine asks for nothing', () => {
  // arm64 on a bare host: the artifact is x86-64 and there is no emulator.
  assert.deepEqual(resolvePreloadEngineIds('all', 'linux', 'arm64').ids, [])
})
