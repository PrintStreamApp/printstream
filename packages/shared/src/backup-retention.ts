/**
 * Smart backup retention: which snapshots of a rolling backup series to keep.
 *
 * Owns the pruning POLICY only: callers own the on-disk snapshots and apply
 * the returned decision. Shared so every backup surface (today the bridge's
 * on-disk snapshots, next the server-side backups of issue #78) ages its
 * history the same way instead of each growing its own keep-N constant.
 *
 * The scheme is the Duplicati-style ladder: keep everything recent, then thin
 * to one per week, then one per month, then drop. Within a week/month bucket
 * the OLDEST snapshot is kept, so the survivor's age is stable as the window
 * slides: keeping the newest instead would make "the weekly backup" a moving
 * target that never ages past the bucket boundary.
 */

export interface BackupRetentionPolicy {
  /** Every snapshot younger than this is kept. */
  keepAllDays: number
  /** After the keep-all window: one snapshot per 7-day bucket, for this many buckets. */
  weeklyBuckets: number
  /** After the weekly region: one snapshot per 30-day bucket, for this many buckets. */
  monthlyBuckets: number
}

/** Keep a week of every backup, a month of weeklies, a year of monthlies. */
export const DEFAULT_BACKUP_RETENTION: BackupRetentionPolicy = {
  keepAllDays: 7,
  weeklyBuckets: 4,
  monthlyBuckets: 12
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Returns the subset of `snapshotTimesMs` that the policy prunes (the caller
 * deletes exactly these). Times in the future are treated as age 0 and kept.
 * Deterministic and pure: same inputs, same decision.
 */
export function selectBackupsToPrune(
  snapshotTimesMs: readonly number[],
  nowMs: number,
  policy: BackupRetentionPolicy = DEFAULT_BACKUP_RETENTION
): number[] {
  const keepAllMs = policy.keepAllDays * DAY_MS
  const weeklyEndMs = keepAllMs + policy.weeklyBuckets * 7 * DAY_MS

  // Oldest snapshot per bucket wins; everything else in the bucket is pruned.
  // Buckets are half-open ([start, end)) so a snapshot ages through exactly one
  // region at a time and a boundary age can never mint an extra bucket.
  const bucketKeeper = new Map<string, number>()
  const prune: number[] = []

  for (const timeMs of snapshotTimesMs) {
    const age = Math.max(0, nowMs - timeMs)
    if (age < keepAllMs) continue
    let bucketKey: string
    const weeklyIndex = Math.floor((age - keepAllMs) / (7 * DAY_MS))
    if (weeklyIndex < policy.weeklyBuckets) {
      bucketKey = `w${weeklyIndex}`
    } else {
      const monthlyIndex = Math.floor((age - weeklyEndMs) / (30 * DAY_MS))
      if (monthlyIndex >= policy.monthlyBuckets) {
        prune.push(timeMs)
        continue
      }
      bucketKey = `m${monthlyIndex}`
    }
    const current = bucketKeeper.get(bucketKey)
    if (current === undefined) {
      bucketKeeper.set(bucketKey, timeMs)
    } else if (timeMs < current) {
      // This snapshot is older: it becomes the bucket's keeper, the previous one goes.
      bucketKeeper.set(bucketKey, timeMs)
      prune.push(current)
    } else {
      prune.push(timeMs)
    }
  }

  return prune
}
