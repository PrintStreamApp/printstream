/**
 * Subscribe to the workspace's live printer statuses.
 *
 * The cache is fed by `usePrinterWebSocket` from MQTT deltas, so there is nothing to fetch — the
 * query exists only to read and subscribe. It was hand-rolled identically in four places before
 * this; one definition means one place to change the semantics.
 *
 * SUBSCRIBE ONLY WHERE THE VALUE IS READ. Statuses arrive a few times a SECOND, and every observer
 * re-renders on each frame whether or not it uses the data. `LibraryView` subscribed purely to
 * forward the value to a dialog that is usually closed, and paid ~100ms of render 4x/s for it —
 * measured at 50 long tasks / 4.5s per 15s on an idle library page, which is the stutter that
 * surfaced while orbiting the 3D editor. Silencing that one subscription took it to zero. So a
 * component that only PASSES statuses along should not subscribe; let the consumer call this.
 */
import { useQuery } from '@tanstack/react-query'
import type { PrinterStatus } from '@printstream/shared'
import { readCurrentWorkspaceScopeKey, workspaceQueryKeys } from '../lib/workspaceScope'

/**
 * Drop the continuously-moving fields from a status.
 *
 * STRIPS known telemetry rather than selecting a read-set, deliberately. Getting this wrong by
 * leaving a new noisy field in only costs some re-renders; getting it wrong the other way silently
 * removes something a consumer reads. Everything structural — AMS units and their slots, external
 * spools, nozzle identity/diameter/flow — survives, because that is what the material pickers and
 * the tray map are built from.
 */
function withoutTelemetry(status: PrinterStatus): PrinterStatus {
  const {
    bedTemp: _bed, nozzleTemp: _nozzle, chamberTemp: _chamber,
    auxFanPercent: _aux, partFanPercent: _part, chamberFanPercent: _chamberFan,
    wifiSignalDbm: _wifi, observedAt: _observed,
    // Print progress moves continuously during a job and no slice surface reads it.
    remainingMinutes: _remaining, currentLayer: _layer,
    ...rest
  } = status as PrinterStatus & Record<string, unknown>
  return {
    ...rest,
    nozzles: status.nozzles.map(({ currentTemp: _c, targetTemp: _t, ...nozzle }) => nozzle),
    ams: status.ams.map(({
      humidityPercent: _h, humidityLevel: _hl, temperature: _temp,
      dryingActive: _da, dryingPhase: _dp, dryFilament: _df, dryTemperature: _dt, dryDurationHours: _dd,
      ...unit
    }) => unit)
  } as unknown as PrinterStatus
}

/**
 * Stripped projections, keyed by the raw status object they came from.
 *
 * A frame changes ONE printer, but the select runs over the whole map, so without this every
 * printer was re-stripped — fresh objects for statuses that had not moved. That cost twice: the
 * allocation, and then `replaceEqualDeep` having to walk each one to discover it was equal after
 * all. Reusing the projection makes an untouched printer identical BY REFERENCE, which that walk
 * short-circuits on (`if (a === b) return a`, and again per key), so the comparison collapses to
 * one shallow check per printer plus a real compare of only the one that changed.
 *
 * A WeakMap because the key is the status object itself: entries die with the frames that produced
 * them, and identity keying means two workspaces can never collide.
 *
 * ASSUMES status objects are never mutated in place — cache-key identity is the only staleness
 * check there is. That holds because the cache is written through `setQueryData`, which produces
 * new objects; an in-place mutation would already defeat React Query's own structural sharing.
 */
const strippedByStatus = new WeakMap<PrinterStatus, PrinterStatus>()

function stripTelemetry(statuses: Record<string, PrinterStatus>): Record<string, PrinterStatus> {
  const out: Record<string, PrinterStatus> = {}
  for (const [printerId, status] of Object.entries(statuses)) {
    const cached = strippedByStatus.get(status)
    if (cached) {
      out[printerId] = cached
      continue
    }
    const stripped = withoutTelemetry(status)
    strippedByStatus.set(status, stripped)
    out[printerId] = stripped
  }
  return out
}

export function usePrinterStatuses(options: {
  /**
   * Ignore temperatures, fan speeds, humidity and the observation timestamp, so the subscriber
   * re-renders only when something STRUCTURAL changes (a tray swapped, a nozzle changed).
   *
   * Load-bearing for the slice dialog, which the 3D editor borrows its controller from: without
   * it, opening the editor put back the whole per-frame render cost the library page had just been
   * freed from — measured at 53 long tasks / 5.0s per 15s with the editor merely open and idle.
   * React Query's structural sharing returns the previous reference when the stripped result is
   * deeply equal, so an identical projection notifies nobody.
   *
   * Only pass this if the consumer genuinely does not read those fields; the printers dashboard
   * obviously does.
   */
  ignoreTelemetry?: boolean
} = {}): Record<string, PrinterStatus> {
  const workspaceScopeKey = readCurrentWorkspaceScopeKey()
  const query = useQuery<Record<string, PrinterStatus>, Error, Record<string, PrinterStatus>>({
    queryKey: workspaceQueryKeys.printerStatus(workspaceScopeKey),
    // WS-fed: there is no endpoint behind this key, so the "fetch" resolves to the empty map and
    // the cache is only ever written by the socket handler.
    queryFn: () => Promise.resolve({}),
    initialData: {},
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    select: options.ignoreTelemetry ? stripTelemetry : undefined
  })
  return query.data ?? {}
}
