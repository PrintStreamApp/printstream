/**
 * Current-print task identity helpers.
 *
 * Some printers reuse the same `subtask_name` and `Metadata/plate_N.gcode`
 * hints across distinct active prints, so cache keys need the live MQTT
 * `task_id` when it is available.
 */
export function normalizeActivePrintTaskId(taskId: string | null | undefined): string | null {
  const normalized = taskId?.trim() ?? ''
  return normalized.length > 0 ? normalized : null
}

export function matchesActivePrintTask(cachedTaskId: string | null | undefined, currentTaskId: string | null | undefined): boolean {
  const normalizedCached = normalizeActivePrintTaskId(cachedTaskId)
  const normalizedCurrent = normalizeActivePrintTaskId(currentTaskId)
  if (normalizedCached || normalizedCurrent) {
    return normalizedCached != null && normalizedCurrent != null && normalizedCached === normalizedCurrent
  }

  return true
}

export function buildTaskScopedAliasKey(alias: string, taskId: string | null | undefined): string {
  const normalizedTaskId = normalizeActivePrintTaskId(taskId)
  return normalizedTaskId ? `${alias}:task:${normalizedTaskId}` : alias
}