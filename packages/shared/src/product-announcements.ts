/**
 * Public product news catalog shared by marketing pages and installed-client dialogs.
 * The hosted JSON catalog is the editorial source of truth. Stable slugs own URLs; array order does not.
 * Content is plain text, never arbitrary HTML, and carries no account or workspace data.
 */
import { z } from 'zod'

const announcementBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('paragraph'), text: z.string().min(1) }),
  z.object({
    type: z.literal('list'),
    items: z.array(z.object({ title: z.string().min(1).optional(), text: z.string().min(1) })).min(1)
  })
])

export const productAnnouncementSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z.string().min(1),
  publishedOn: z.string().date(),
  summary: z.string().min(1),
  label: z.string().min(1).optional(),
  blocks: z.array(announcementBlockSchema).min(1)
})

export const productAnnouncementsCatalogSchema = z.object({
  featuredSlug: z.string(),
  announcements: z.array(productAnnouncementSchema).min(1)
}).superRefine((catalog, context) => {
  const slugs = catalog.announcements.map((announcement) => announcement.slug)
  if (new Set(slugs).size !== slugs.length) {
    context.addIssue({ code: 'custom', message: 'Announcement slugs must be unique.' })
  }
  if (!slugs.includes(catalog.featuredSlug)) {
    context.addIssue({ code: 'custom', message: 'The featured announcement must exist in the catalog.' })
  }
})

export type ProductAnnouncement = z.infer<typeof productAnnouncementSchema>
export type ProductAnnouncementsCatalog = z.infer<typeof productAnnouncementsCatalogSchema>

/** Validates catalog identity and returns a copy with announcements sorted newest first. */
export function parseProductAnnouncementsCatalog(value: unknown): ProductAnnouncementsCatalog {
  const catalog = productAnnouncementsCatalogSchema.parse(value)
  return {
    ...catalog,
    announcements: [...catalog.announcements].sort((left, right) =>
      right.publishedOn.localeCompare(left.publishedOn) || left.slug.localeCompare(right.slug)
    )
  }
}

/** Returns the stable public article path for an already-validated catalog slug. */
export function getProductAnnouncementPath(slug: string): string {
  return `/announcements/${slug}`
}

/** Resolves a catalog slug; missing entries are intentionally not replaced with a different article. */
export function findProductAnnouncement(slug: string, announcements: readonly ProductAnnouncement[]): ProductAnnouncement | undefined {
  return announcements.find((announcement) => announcement.slug === slug)
}
