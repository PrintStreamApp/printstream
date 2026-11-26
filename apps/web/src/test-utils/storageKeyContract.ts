/**
 * The contract every owner's storage key declarations are tested against (CONF-7, D-105).
 *
 * Each owner (core, each plugin, the private cloud module) has a `storageKeys.test.tsx` that imports
 * its own `storageKeys.ts` and calls `testStorageKeyDeclarations` with what it declares. One shared
 * contract, so the rules cannot drift between owners, and no core test has to import a plugin or a
 * private module.
 *
 * What it proves, per declaration:
 * - the name, or a family's prefix, follows D-105's grammar;
 * - no two declarations, current or former, share a name;
 * - a renamed preference, record or flow key carries a saved value over, both through the storage
 *   hook (which most surfaces use) and through the helpers (which the rest use): the old value is
 *   read, and after the first write it lives under the new name;
 * - a renamed cache does not carry over, and its old entry is cleared by the next write.
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { JSDOM } from 'jsdom'
import { installJsdomGlobals } from './jsdom'
import {
  STORAGE_KEY_FAMILY_GRAMMAR,
  STORAGE_KEY_GRAMMAR,
  readStoredValue,
  writeStoredValue,
  type AnyStorageKeyDefinition,
  type StorageKeyRef
} from '../lib/browserStorageKeys'

/** A suffix for family members; any value works, the contract only needs one member. */
const SAMPLE_SUFFIX = 'sample-scope'

/** The one concrete key the contract exercises for a declaration. */
function sampleRef(definition: AnyStorageKeyDefinition): StorageKeyRef {
  return 'prefix' in definition ? definition.at(SAMPLE_SUFFIX) : definition
}

/** The name a declaration is known by: a fixed key, or a family's prefix. */
function declaredName(definition: AnyStorageKeyDefinition): string {
  return 'prefix' in definition ? definition.prefix : definition.key
}

/**
 * Registers the contract's tests for one owner's declarations.
 *
 * @param owner the label used in test names (`core`, `plugin:orders`).
 * @param exported the owner module's exports; every storage key declaration among them is tested.
 */
export function testStorageKeyDeclarations(owner: string, exported: Record<string, unknown>): void {
  const definitions = Object.values(exported).filter(isDeclaration)

  let dom: JSDOM
  let createElement: typeof import('react').createElement
  let render: typeof import('@testing-library/react').render
  let cleanup: typeof import('@testing-library/react').cleanup
  let useLocalStorageState: typeof import('../hooks/useLocalStorageState').useLocalStorageState

  before(async () => {
    dom = installJsdomGlobals()
    createElement = (await import('react')).createElement
    const testingLibrary = await import('@testing-library/react')
    render = testingLibrary.render
    cleanup = testingLibrary.cleanup
    useLocalStorageState = (await import('../hooks/useLocalStorageState')).useLocalStorageState
  })

  after(() => {
    dom.window.close()
  })

  test(`${owner}: declares at least one storage key, each owned by ${owner}`, () => {
    assert.ok(definitions.length > 0, 'the module exports no declarations: is the right module imported?')
    for (const definition of definitions) assert.equal(definition.owner, owner, declaredName(definition))
  })

  test(`${owner}: every name follows printstream.<area>.<name>`, () => {
    for (const definition of definitions) {
      const grammar = 'prefix' in definition ? STORAGE_KEY_FAMILY_GRAMMAR : STORAGE_KEY_GRAMMAR
      assert.match(declaredName(definition), grammar, declaredName(definition))
    }
  })

  test(`${owner}: no two declarations share a current or former name`, () => {
    const seen = new Map<string, string>()
    for (const definition of definitions) {
      const ref = sampleRef(definition)
      for (const name of [ref.key, ...ref.legacyKeys, ...ref.retiredKeys]) {
        assert.equal(seen.get(name), undefined, `${name} is claimed by ${seen.get(name)} and ${declaredName(definition)}`)
        seen.set(name, declaredName(definition))
      }
    }
  })

  test(`${owner}: a renamed key carries a saved value over through the storage hook`, () => {
    // The hook serves localStorage keys only; session keys are covered by the helper test below.
    const renamed = definitions.filter((definition) => definition.kind !== 'cache' && definition.storage === 'local')
      .map(sampleRef)
      .filter((ref) => ref.legacyKeys.length > 0)

    for (const ref of renamed) {
      window.localStorage.clear()
      const saved = `saved value of ${ref.legacyKeys[0]}`
      window.localStorage.setItem(ref.legacyKeys[0]!, saved)

      let seen: string | null = null
      function Reader() {
        const [value] = useLocalStorageState<string>(ref, 'fallback', (raw) => raw, String)
        seen = value
        return null
      }
      render(createElement(Reader))
      cleanup()

      assert.equal(seen, saved, `${ref.key} did not read ${ref.legacyKeys[0]}`)
      assert.equal(window.localStorage.getItem(ref.key), saved, `${ref.key} did not take the value over`)
    }
  })

  test(`${owner}: a renamed key carries a saved value over through the helpers`, () => {
    for (const definition of definitions) {
      const ref = sampleRef(definition)
      const store = ref.storage === 'local' ? window.localStorage : window.sessionStorage
      window.localStorage.clear()
      window.sessionStorage.clear()

      for (const legacy of ref.legacyKeys) {
        store.clear()
        store.setItem(legacy, 'from the old name')
        assert.equal(readStoredValue(ref), 'from the old name', `${ref.key} did not read ${legacy}`)
        writeStoredValue(ref, 'rewritten')
        assert.equal(store.getItem(ref.key), 'rewritten')
      }

      // The current name always wins over a former one.
      if (ref.legacyKeys.length > 0) {
        store.setItem(ref.key, 'current')
        store.setItem(ref.legacyKeys[0]!, 'stale')
        assert.equal(readStoredValue(ref), 'current', ref.key)
      }
    }
  })

  test(`${owner}: a renamed cache is cleared, never read`, () => {
    const caches = definitions.filter((definition) => definition.kind === 'cache').map(sampleRef)
    for (const ref of caches) {
      assert.deepEqual(ref.legacyKeys, [], `${ref.key} is a cache, so it must not read old entries`)
      const store = ref.storage === 'local' ? window.localStorage : window.sessionStorage
      store.clear()
      for (const retired of ref.retiredKeys) store.setItem(retired, 'old cache')
      assert.equal(readStoredValue(ref), null, ref.key)
      writeStoredValue(ref, 'fresh')
      for (const retired of ref.retiredKeys) assert.equal(store.getItem(retired), null, `${retired} was not cleared`)
    }
  })
}

/** Whether a module export is a storage key declaration (fixed or family). */
function isDeclaration(value: unknown): value is AnyStorageKeyDefinition {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AnyStorageKeyDefinition>
  return typeof candidate.owner === 'string' && typeof candidate.kind === 'string'
    && ('key' in candidate || 'prefix' in candidate)
}
