/**
 * Core workspace identity contracts: the slug rules and the summary shape that
 * auth bootstrap and workspace switching rely on. Workspace administration
 * (list/create/update) contracts live in the private cloud contracts under
 * `src/private` and are not part of the public package surface.
 */
import { z } from 'zod'

export const PUBLIC_DEMO_WORKSPACE_SLUG = 'demo'

export const workspaceSlugSchema = z.string().trim().min(1).max(63).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
  message: 'Workspace slugs must use lowercase letters, numbers, and hyphens only.'
})

export const workspaceSummarySchema = z.object({
  id: z.string(),
  slug: workspaceSlugSchema,
  name: z.string().min(1).max(120),
  description: z.string().nullable().optional(),
  userCount: z.number().int().nonnegative().optional(),
  bridgeCount: z.number().int().nonnegative().optional(),
  printerCount: z.number().int().nonnegative().optional(),
  supportAccessEnabled: z.boolean().optional()
})

export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>
