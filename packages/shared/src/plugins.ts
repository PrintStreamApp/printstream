/**
 * Shared contract for the plugin catalog and management surfaces: the runtime/
 * manager surfaces a plugin runs on, its workspace-access mode, and the catalog +
 * management entry shapes the API serves and the plugin-manager UI consumes.
 */
import { z } from 'zod'

export const pluginSurfaceSchema = z.enum(['platform', 'workspace'])
export type PluginSurface = z.infer<typeof pluginSurfaceSchema>

export const pluginWorkspaceAccessSchema = z.enum(['none', 'always', 'controlled'])
export type PluginWorkspaceAccess = z.infer<typeof pluginWorkspaceAccessSchema>

export const pluginSourceSchema = z.enum(['builtin', 'upload', 'store'])
export type PluginSource = z.infer<typeof pluginSourceSchema>

export const workspacePluginAvailabilitySchema = z.object({
  allowed: z.boolean(),
  enabledByDefault: z.boolean()
})

export type WorkspacePluginAvailability = z.infer<typeof workspacePluginAvailabilitySchema>

export const pluginCatalogEntrySchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1).optional(),
  description: z.string().min(1).max(280).optional(),
  source: pluginSourceSchema,
  installed: z.boolean(),
  enabled: z.boolean(),
  /** Platform-workspace enablement; null/absent when the plugin has no platform surface. */
  platformEnabled: z.boolean().nullable().optional(),
  runtimeSurfaces: z.array(pluginSurfaceSchema).min(1),
  managerSurfaces: z.array(pluginSurfaceSchema).min(1),
  workspaceAccess: pluginWorkspaceAccessSchema,
  availableInCurrentContext: z.boolean(),
  /** True when the deployment's plan gate blocks this plugin for the current workspace (e.g. a Pro plugin on a Free plan). */
  planBlocked: z.boolean().optional()
})

export type PluginCatalogEntry = z.infer<typeof pluginCatalogEntrySchema>

export const pluginCatalogResponseSchema = z.object({
  plugins: z.array(pluginCatalogEntrySchema)
})

export type PluginCatalogResponse = z.infer<typeof pluginCatalogResponseSchema>

export const pluginManagementEntrySchema = pluginCatalogEntrySchema.extend({
  workspaceAvailability: workspacePluginAvailabilitySchema.nullable()
})

export type PluginManagementEntry = z.infer<typeof pluginManagementEntrySchema>

export const pluginManagementResponseSchema = z.object({
  plugins: z.array(pluginManagementEntrySchema)
})

export type PluginManagementResponse = z.infer<typeof pluginManagementResponseSchema>

export const updateWorkspacePluginAvailabilitySchema = workspacePluginAvailabilitySchema
export type UpdateWorkspacePluginAvailabilityInput = z.infer<typeof updateWorkspacePluginAvailabilitySchema>