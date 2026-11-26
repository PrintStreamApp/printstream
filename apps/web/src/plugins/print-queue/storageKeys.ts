/**
 * Browser storage keys owned by the print-queue plugin (CONF-7, D-105; the registry is
 * `lib/browserStorageKeys.ts`). They were unprefixed (`print-queue.*`) and carry over from there.
 */
import { defineStorageKey } from '../../lib/browserStorageKeys'

const owner = 'plugin:print-queue'

/** A queue directory preference, read from its unprefixed former name. */
function preference(name: string) {
  return defineStorageKey({ key: `printstream.printQueue.${name}`, storage: 'local', kind: 'preference', owner, legacyKeys: [`print-queue.${name}`] })
}

export const queueGroupKey = preference('group')
export const queuePageSizeKey = preference('pageSize')
export const queueStatusesKey = preference('statuses')
