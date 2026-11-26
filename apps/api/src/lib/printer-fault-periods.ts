/**
 * Projects observed idle intervals around durable job coverage without destroying
 * evidence during delayed activation. Open job spans temporarily hide later idle
 * observations; their final observed end reveals those original observations again.
 */
interface Interval { startedAt: Date; endedAt: Date | null }
interface ObservedPeriod extends Interval { id: string }

/** Coalesce overlapping source intervals, then subtract job spans with stable fragment identities. */
export function visibleFaultIdlePeriods(periods: readonly ObservedPeriod[], jobs: readonly Interval[]): ObservedPeriod[] {
  const merged: ObservedPeriod[] = []
  for (const period of [...periods].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())) {
    const previous = merged.at(-1)
    if (previous && (!previous.endedAt || previous.endedAt >= period.startedAt)) {
      previous.endedAt = !previous.endedAt || !period.endedAt ? null : new Date(Math.max(previous.endedAt.getTime(), period.endedAt.getTime()))
    } else {
      merged.push({ ...period })
    }
  }
  let visible = merged

  // Database include ordering is not part of the history identity contract.
  const orderedJobs = [...jobs].sort((left, right) => {
    const startOrder = left.startedAt.getTime() - right.startedAt.getTime()
    if (startOrder) return startOrder
    const leftEnd = left.endedAt?.getTime() ?? Infinity
    const rightEnd = right.endedAt?.getTime() ?? Infinity
    return leftEnd === rightEnd ? 0 : leftEnd - rightEnd
  })
  for (const job of orderedJobs) {
    visible = visible.flatMap((period) => {
      const end = period.endedAt?.getTime() ?? Infinity
      const jobEnd = job.endedAt?.getTime() ?? Infinity
      if (end <= job.startedAt.getTime() || jobEnd <= period.startedAt.getTime()) return [period]
      const fragments: ObservedPeriod[] = []
      if (period.startedAt < job.startedAt) fragments.push({ ...period, endedAt: job.startedAt })
      if (jobEnd < end) fragments.push({ ...period, id: `${period.id}:${job.endedAt!.toISOString()}`, startedAt: job.endedAt! })
      return fragments
    })
  }
  return visible.filter((period) => !period.endedAt || period.endedAt > period.startedAt)
}
