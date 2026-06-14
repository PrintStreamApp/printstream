/**
 * Core tenant identity contracts: the slug rules and the summary shape that
 * auth bootstrap and workspace switching rely on. Tenant administration
 * (list/create/update) contracts live in the private cloud contracts under
 * `src/private` and are not part of the public package surface.
 */
import { z } from 'zod'

export const PUBLIC_DEMO_TENANT_SLUG = 'demo'

export const tenantSlugSchema = z.string().trim().min(1).max(63).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
  message: 'Tenant slugs must use lowercase letters, numbers, and hyphens only.'
})

export const tenantSummarySchema = z.object({
  id: z.string(),
  slug: tenantSlugSchema,
  name: z.string().min(1).max(120),
  description: z.string().nullable().optional(),
  userCount: z.number().int().nonnegative().optional(),
  bridgeCount: z.number().int().nonnegative().optional(),
  printerCount: z.number().int().nonnegative().optional(),
  supportAccessEnabled: z.boolean().optional()
})

export type TenantSummary = z.infer<typeof tenantSummarySchema>
