/**
 * Browser storage keys owned by the firmware-updates plugin (CONF-7, D-105; the registry is
 * `lib/browserStorageKeys.ts`).
 */
import { defineStorageKeyFamily } from '../../lib/browserStorageKeys'

/**
 * The last firmware check, per workspace (or `platform`). A cache, so its old `bambu.` entries are
 * cleared rather than read: the next check refills it.
 */
export const firmwareUpdatesCacheKeys = defineStorageKeyFamily({
  prefix: 'printstream.firmwareUpdates.cache',
  storage: 'local',
  kind: 'cache',
  owner: 'plugin:firmware-updates',
  retiredPrefixes: ['bambu.firmware-updates.cache.v1']
})
