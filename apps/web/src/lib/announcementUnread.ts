/** Per-device announcement read markers are stable slugs, scoped to the public feed source. */
import type { ProductAnnouncement } from '@printstream/shared'

export const EMPTY_READ_ANNOUNCEMENTS: readonly string[] = []

/** Invalid old storage falls back to unread; malformed data never hides an announcement. */
export function parseReadAnnouncementSlugs(raw: string): readonly string[] | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value) || !value.every((slug) => typeof slug === 'string')) return null
    return [...new Set(value as string[])]
  } catch {
    return null
  }
}

/** Counts articles in the fetched catalog that this device has not shown in the dialog. */
export function countUnreadAnnouncements(announcements: readonly ProductAnnouncement[], readSlugs: readonly string[]): number {
  const read = new Set(readSlugs)
  return announcements.filter((announcement) => !read.has(announcement.slug)).length
}

/** Retains older markers so an article temporarily absent from the feed does not become unread again. */
export function mergeReadAnnouncementSlugs(readSlugs: readonly string[], announcements: readonly ProductAnnouncement[]): readonly string[] {
  return [...new Set([...readSlugs, ...announcements.map((announcement) => announcement.slug)])]
}
