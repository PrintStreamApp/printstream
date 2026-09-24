/**
 * Owns the installed companion-app changelog and its per-device unread rule.
 * Release validation keeps its newest entry aligned with the package metadata.
 */
import { z } from 'zod'
import rawChangelog from '../companion-changelog.json'

const companionReleaseSchema = z.object({
  version: z.string().min(1),
  releasedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  changes: z.array(z.string().min(1)).min(1)
})

const companionChangelogSchema = z.object({
  releases: z.array(companionReleaseSchema)
})

export type CompanionRelease = z.infer<typeof companionReleaseSchema>

/** Installed-app release notes embedded in the web build, newest first. */
export const companionReleases = companionChangelogSchema.parse(rawChangelog).releases

/** Returns whether the installed app has release notes this device has not opened yet. */
export function hasUnreadCompanionRelease(
  currentVersion: string,
  lastReadVersion: string | null,
  releases: ReadonlyArray<CompanionRelease> = companionReleases
): boolean {
  return releases.some((release) => release.version === currentVersion)
    && lastReadVersion !== currentVersion
}
