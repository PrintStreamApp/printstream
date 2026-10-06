/**
 * Owns the bundled, user-facing product changelog and the per-device unread rule used by the
 * app footer. Release automation updates the JSON source only after Ryan approves its wording.
 */
import { z } from 'zod'
import rawChangelog from '../product-changelog.json'
import { getUnreadReleaseEntries } from './releaseUnread'

const productReleaseSchema = z.object({
  version: z.string().min(1),
  releasedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  changes: z.array(z.string().min(1)).min(1)
})

const productChangelogSchema = z.object({
  releases: z.array(productReleaseSchema)
})

export type ProductRelease = z.infer<typeof productReleaseSchema>

/** Release notes embedded in this web build, newest first. */
export const productReleases = productChangelogSchema.parse(rawChangelog).releases

/** Returns unread releases up to this build, preserving the existing last-read version marker. */
export function getUnreadProductReleases(currentVersion: string, lastReadVersion: string | null, releases: ReadonlyArray<ProductRelease> = productReleases): readonly ProductRelease[] {
  return getUnreadReleaseEntries(currentVersion, lastReadVersion, releases)
}

/** Returns whether this build has release notes the device has not opened yet. */
export function hasUnreadProductRelease(
  currentVersion: string,
  lastReadVersion: string | null,
  releases: ReadonlyArray<ProductRelease> = productReleases
): boolean {
  return getUnreadProductReleases(currentVersion, lastReadVersion, releases).length > 0
}

export { formatDateOnly as formatProductReleaseDate } from './dateOnly'
