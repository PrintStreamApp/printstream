/** Shared read boundary for newest-first product and companion release catalogs. */
interface ReleaseWithChanges {
  version: string
  changes: readonly string[]
}

/**
 * Returns releases through the running version and newer than the last-read version.
 * First use or a missing old marker counts only the current release, preserving the existing
 * onboarding behavior. A downgrade does not re-mark older notes as unread. Catalogs are newest first.
 */
export function getUnreadReleaseEntries<T extends ReleaseWithChanges>(
  currentVersion: string,
  lastReadVersion: string | null,
  releases: readonly T[]
): readonly T[] {
  const currentIndex = releases.findIndex((release) => release.version === currentVersion)
  if (currentIndex < 0) return []

  const lastReadIndex = releases.findIndex((release) => release.version === lastReadVersion)
  if (lastReadIndex >= 0 && lastReadIndex <= currentIndex) return []
  if (lastReadIndex < 0) return releases.slice(currentIndex, currentIndex + 1)
  return releases.slice(currentIndex, lastReadIndex)
}
