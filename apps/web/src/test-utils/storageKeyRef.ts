/**
 * A storage key reference for tests of the storage hooks themselves, which exercise the mechanism
 * with throwaway names rather than the app's declared keys (and must not add those to the registry).
 */
import type { StorageKeyRef } from '../lib/browserStorageKeys'

/** A localStorage key with the given former names. */
export function testStorageKey(key: string, legacyKeys: readonly string[] = []): StorageKeyRef {
  return { key, storage: 'local', legacyKeys, retiredKeys: [] }
}
