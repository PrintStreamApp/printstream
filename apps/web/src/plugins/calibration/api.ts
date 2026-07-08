/**
 * Data layer for the calibration plugin: typed `apiFetch` wrappers over
 * `/api/plugins/calibration` plus TanStack Query keys. Runs are polled while any
 * is mid-slice/print (the slice queue has no WS event); everything else is
 * fetched on demand and invalidated after mutations.
 */
import type {
  CalibrationResult,
  CalibrationRun,
  CreateCalibrationRun,
  SaveCalibrationResult,
  SubmitCalibrationMeasurement
} from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'

export const calibrationKeys = {
  runs: ['calibration', 'runs'] as const,
  results: ['calibration', 'results'] as const
}

export async function fetchCalibrationRuns(signal?: AbortSignal): Promise<CalibrationRun[]> {
  const { runs } = await apiFetch<{ runs: CalibrationRun[] }>('/api/plugins/calibration/runs', { signal })
  return runs
}

export async function fetchCalibrationResults(signal?: AbortSignal): Promise<CalibrationResult[]> {
  const { results } = await apiFetch<{ results: CalibrationResult[] }>('/api/plugins/calibration/results', { signal })
  return results
}

export async function startCalibrationRun(body: CreateCalibrationRun): Promise<CalibrationRun> {
  const { run } = await apiFetch<{ run: CalibrationRun }>('/api/plugins/calibration/runs', { method: 'POST', body })
  return run
}

export async function printCalibrationRun(runId: string): Promise<CalibrationRun> {
  const { run } = await apiFetch<{ run: CalibrationRun }>(`/api/plugins/calibration/runs/${runId}/print`, { method: 'POST' })
  return run
}

export async function submitCalibrationMeasurement(runId: string, body: SubmitCalibrationMeasurement): Promise<{ run: CalibrationRun; value: number }> {
  return apiFetch<{ run: CalibrationRun; value: number }>(`/api/plugins/calibration/runs/${runId}/measurement`, { method: 'POST', body })
}

export async function saveCalibrationRun(runId: string, body: SaveCalibrationResult): Promise<CalibrationRun> {
  const { run } = await apiFetch<{ run: CalibrationRun }>(`/api/plugins/calibration/runs/${runId}/save`, { method: 'POST', body })
  return run
}

export async function deleteCalibrationRun(runId: string): Promise<void> {
  await apiFetch(`/api/plugins/calibration/runs/${runId}`, { method: 'DELETE' })
}

export async function deleteCalibrationResult(resultId: string): Promise<void> {
  await apiFetch(`/api/plugins/calibration/results/${resultId}`, { method: 'DELETE' })
}

/** A run is still working (slicing or printing) — poll while any is in these states. */
export function isCalibrationRunActive(run: CalibrationRun): boolean {
  return run.status === 'slicing' || run.status === 'readyToPrint' || run.status === 'printing'
}
