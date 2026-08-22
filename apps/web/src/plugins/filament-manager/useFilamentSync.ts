/**
 * Keeps the filament-manager caches live for every surface that reads them.
 *
 * Invalidates the spool list and the usage stats whenever the plugin reports an
 * inventory change: an RFID spool moved slot or was removed, an auto-add, a remain
 * sync, consumption, or another client's edit. API counterpart:
 * `apps/api/src/plugins/filament-manager/events.ts`.
 *
 * Contract: **callers do not opt in.** `useSpoolsQuery` / `useFilamentStatsQuery` mount
 * this themselves, so no surface can read a stale spool by forgetting to subscribe. It
 * used to be mounted only by the Filament page, and every other reader — the print,
 * slice, storage-print and queue dialogs' slot pickers, the AMS slot editors — held
 * whatever the cache had when it opened. Swapping a spool then redrew the slot's swatch
 * (that comes from the live printer status) while its NAME and remaining figure still
 * described the spool that had been taken out.
 *
 * The one shared listener comes from `createWsQuerySync`, which matters here because an
 * open print dialog mounts `useSpoolsQuery` once per slot row.
 */
import { createWsQuerySync } from '../../lib/wsQuerySync'
import { FILAMENT_STATS_QUERY_KEY, SPOOLS_QUERY_KEY } from './queryKeys'

/**
 * Subscribe this component to filament inventory changes. `enabled` is the plugin's
 * per-workspace activation gate: a disabled plugin neither fetches nor listens.
 */
export const useFilamentSync = createWsQuerySync((event) => (
  event.type === 'plugin.event' && event.pluginName === 'filament-manager'
    ? [SPOOLS_QUERY_KEY, FILAMENT_STATS_QUERY_KEY]
    : null
))
