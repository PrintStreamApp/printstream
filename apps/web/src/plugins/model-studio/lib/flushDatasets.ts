/**
 * BambuStudio's measured flush tables, fetched from the API rather than bundled.
 *
 * They ship inside the slicer image (see `apps/slicer/src/flush-data.ts` for why they are served
 * rather than vendored), so this is a small proxied fetch parsed by the SHARED
 * `parseFlushVolumeDataset`, the same parser the API and slicer sides use, so the format cannot be
 * understood two ways.
 *
 * Absence is a supported state, not an error: an install with no slicer configured, or an engine
 * that ships no tables, yields an empty map and the calculation falls back to Studio's colour
 * formula, exactly what Studio itself does with a missing data file. So this never throws into the
 * dialog; a failed fetch is a quieter calculation, not a broken one.
 *
 * `basePath` selects the surface: the workspace route by default, the anonymous catalogue for the
 * public 3MF editor (same shape, no account): mirroring `bedModel.ts`.
 *
 * The sibling {@link useFlushCalibration} closes the drift gap the tables alone cannot: our port is
 * verified against the vendored SOURCE, but the slicer IMAGE is bumped independently of it, so the
 * engine is also asked for its own answer and the two are compared. That check is a diagnostic,
 * it never blocks the dialog, it only decides how confidently the footnote can speak.
 */
import { useQuery } from '@tanstack/react-query'
import {
  evaluateFlushCalibration,
  parseFlushVolumeDataset,
  type FlushCalibrationVerdict,
  type FlushVolumeDataset
} from '@printstream/shared'
import { apiFetch } from '../../../lib/apiClient'

/** Parsed tables keyed by `nozzle_flush_dataset` code. */
export type FlushDatasets = Record<string, FlushVolumeDataset>

/** Immutable for the life of a slicer image; keep it for the session. */
const FLUSH_DATASET_STALE_TIME_MS = 60 * 60_000

export async function fetchFlushDatasets(input: {
  targetId: string | null | undefined
  basePath?: string
  signal?: AbortSignal
}): Promise<FlushDatasets> {
  const params = new URLSearchParams()
  if (input.targetId?.trim()) params.set('targetId', input.targetId.trim())
  const path = `${input.basePath ?? '/api/slicing/flush-data'}?${params.toString()}`
  const body = await apiFetch<{ datasets?: Record<string, string> }>(path, { signal: input.signal })
  const out: FlushDatasets = {}
  for (const [code, text] of Object.entries(body.datasets ?? {})) {
    const dataset = parseFlushVolumeDataset(text)
    if (dataset) out[code] = dataset
  }
  return out
}

/**
 * Whether the engine agrees with our port, checked against its OWN computed matrix.
 *
 * `null` means "not checked" (no slicer, an engine too old to probe, a failed fetch), which is not
 * the same as agreeing, and the dialog says so rather than claiming parity it did not verify.
 */
export function useFlushCalibration(
  targetId: string | null | undefined,
  datasets: FlushDatasets,
  basePath?: string
): FlushCalibrationVerdict | null {
  const query = useQuery({
    queryKey: ['flush-calibration', basePath ?? 'workspace', targetId ?? ''],
    // Pointless before the tables land: our side would compute from the formula while the engine
    // used its measured values, and the disagreement would be OURS to explain, not the engine's.
    enabled: Boolean(targetId) && Object.keys(datasets).length > 0,
    staleTime: FLUSH_DATASET_STALE_TIME_MS,
    // The probe spawns the CLI, so it is slow and worth retrying only once.
    retry: 1,
    queryFn: async ({ signal }) => {
      const path = `${basePath ?? '/api/slicing/flush-calibration'}?${targetId ? `targetId=${encodeURIComponent(targetId)}` : ''}`
      const body = await apiFetch<{ calibration?: { settingsJson?: string; matrix?: string[] } | null }>(path, { signal })
      const calibration = body.calibration
      if (!calibration?.settingsJson || !Array.isArray(calibration.matrix)) return null
      return evaluateFlushCalibration({
        settingsJson: calibration.settingsJson,
        engineMatrix: calibration.matrix,
        datasets
      })
    }
  })
  return query.data ?? null
}

/**
 * Query the measured tables for a slicer target. Never surfaces an error: a failure resolves to an
 * empty map so the dialog still calculates, one fidelity step down.
 */
export function useFlushDatasets(targetId: string | null | undefined, basePath?: string): FlushDatasets {
  const query = useQuery({
    queryKey: ['flush-datasets', basePath ?? 'workspace', targetId ?? ''],
    enabled: Boolean(targetId),
    staleTime: FLUSH_DATASET_STALE_TIME_MS,
    queryFn: async ({ signal }) => {
      try {
        return await fetchFlushDatasets({ targetId, basePath, signal })
      } catch {
        return {}
      }
    }
  })
  return query.data ?? {}
}
