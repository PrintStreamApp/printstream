import { z } from 'zod'

export const pluginSurfaceSchema = z.enum(['platform', 'tenant'])
export type PluginSurface = z.infer<typeof pluginSurfaceSchema>

export const pluginTenantAccessSchema = z.enum(['none', 'always', 'controlled'])
export type PluginTenantAccess = z.infer<typeof pluginTenantAccessSchema>

export const pluginSourceSchema = z.enum(['builtin', 'upload', 'store'])
export type PluginSource = z.infer<typeof pluginSourceSchema>

export const tenantPluginAvailabilitySchema = z.object({
  allowed: z.boolean(),
  enabledByDefault: z.boolean()
})

export type TenantPluginAvailability = z.infer<typeof tenantPluginAvailabilitySchema>

export const pluginCatalogEntrySchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1).optional(),
  description: z.string().min(1).max(280).optional(),
  source: pluginSourceSchema,
  installed: z.boolean(),
  enabled: z.boolean(),
  runtimeSurfaces: z.array(pluginSurfaceSchema).min(1),
  managerSurfaces: z.array(pluginSurfaceSchema).min(1),
  tenantAccess: pluginTenantAccessSchema,
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
  tenantAvailability: tenantPluginAvailabilitySchema.nullable()
})

export type PluginManagementEntry = z.infer<typeof pluginManagementEntrySchema>

export const pluginManagementResponseSchema = z.object({
  plugins: z.array(pluginManagementEntrySchema)
})

export type PluginManagementResponse = z.infer<typeof pluginManagementResponseSchema>

export const updateTenantPluginAvailabilitySchema = tenantPluginAvailabilitySchema
export type UpdateTenantPluginAvailabilityInput = z.infer<typeof updateTenantPluginAvailabilitySchema>