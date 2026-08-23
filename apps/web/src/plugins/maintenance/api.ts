/**
 * Data layer for the maintenance plugin: typed `apiFetch` wrappers over
 * `/api/plugins/maintenance` plus TanStack Query keys.
 *
 * Counterpart: `apps/api/src/plugins/maintenance/routes.ts`.
 *
 * Nothing here polls: the printer detail query is fetched on demand and the grid
 * summary is one request covering every printer, so N printer cards do not make N
 * requests. Both keys are invalidated together after any write, since marking one
 * task done changes the card chip as well as the section.
 *
 * Due dates do NOT only move on the scale of days, which is what an earlier version of
 * this note assumed: print hours and filament kilograms advance on every completed
 * print. `useMaintenanceSync` below carries that.
 */
import type {
  MaintenanceCompleteRequest,
  MaintenanceCustomTaskRequest,
  MaintenanceHistoryResponse,
  MaintenancePrinterResponse,
  MaintenanceSummaryResponse,
  MaintenanceTaskPatchRequest
} from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { createWsQuerySync } from '../../lib/wsQuerySync'

const BASE = '/api/plugins/maintenance'

export const maintenanceKeys = {
  all: ['maintenance'] as const,
  summary: ['maintenance', 'summary'] as const,
  printer: (printerId: string) => ['maintenance', 'printer', printerId] as const,
  history: (printerId: string, taskKey: string) => ['maintenance', 'history', printerId, taskKey] as const
}

export function fetchMaintenanceSummary(signal?: AbortSignal): Promise<MaintenanceSummaryResponse> {
  return apiFetch<MaintenanceSummaryResponse>(`${BASE}/summary`, { signal })
}

export function fetchPrinterMaintenance(printerId: string, signal?: AbortSignal): Promise<MaintenancePrinterResponse> {
  return apiFetch<MaintenancePrinterResponse>(`${BASE}/printers/${printerId}`, { signal })
}

export function fetchMaintenanceHistory(printerId: string, taskKey: string, signal?: AbortSignal): Promise<MaintenanceHistoryResponse> {
  return apiFetch<MaintenanceHistoryResponse>(`${BASE}/printers/${printerId}/tasks/${encodeURIComponent(taskKey)}/history`, { signal })
}

export function completeMaintenanceTask(printerId: string, taskKey: string, body: MaintenanceCompleteRequest = {}): Promise<void> {
  return apiFetch<void>(`${BASE}/printers/${printerId}/tasks/${encodeURIComponent(taskKey)}/complete`, { method: 'POST', body })
}

export function patchMaintenanceTask(printerId: string, taskKey: string, body: MaintenanceTaskPatchRequest): Promise<void> {
  return apiFetch<void>(`${BASE}/printers/${printerId}/tasks/${encodeURIComponent(taskKey)}`, { method: 'PATCH', body })
}

export function resetMaintenanceTask(printerId: string, taskKey: string): Promise<void> {
  return apiFetch<void>(`${BASE}/printers/${printerId}/tasks/${encodeURIComponent(taskKey)}/reset`, { method: 'POST' })
}

export function createMaintenanceTask(printerId: string, body: MaintenanceCustomTaskRequest): Promise<{ taskKey: string }> {
  return apiFetch<{ taskKey: string }>(`${BASE}/printers/${printerId}/tasks`, { method: 'POST', body })
}

export function deleteMaintenanceTask(printerId: string, taskKey: string): Promise<void> {
  return apiFetch<void>(`${BASE}/printers/${printerId}/tasks/${encodeURIComponent(taskKey)}`, { method: 'DELETE' })
}

/**
 * Keeps the maintenance caches live. Mounted by the plugin's read surfaces rather than
 * offered to them, so a surface cannot show a stale due-date by forgetting to subscribe.
 *
 * A completed print is the trigger, not a clock: two of the three interval kinds
 * (`printHours`, `filamentKilograms`) advance from `PrinterStats`, which the API rewrites
 * on job completion, and `evaluateMaintenanceTask` grades on whichever elapses FIRST.
 * The header below used to reason only about calendar days, which is why nothing
 * refreshed these, a shop-floor grid left open all day would never surface a task that
 * came due mid-afternoon.
 */
export const useMaintenanceSync = createWsQuerySync((event) => (
  event.type === 'resource.changed' && event.resource === 'jobs' ? [maintenanceKeys.all] : null
))
