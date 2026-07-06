import { z } from 'zod'
import { permissionSchema } from './permissions.js'

const uniquePermissionArraySchema = z.array(permissionSchema).refine(
  (permissions) => new Set(permissions).size === permissions.length,
  'Permissions must be unique.'
)

export const appThemeSettingSchema = z.enum([
  'default',
  'aurora',
  'graphite-green',
  'graphite-sky',
  'graphite-violet',
  'graphite-rose',
  'slate',
  'code-dark'
])
const appLandingPagePathSchema = z.string().regex(/^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/, 'Landing page must be an app-relative path.')
const legacyAppLandingPageSettingSchema = z.enum(['printers', 'library', 'jobs', 'stats', 'settings']).transform((value) => `/${value}`)
export const DEFAULT_APP_LANDING_PAGE = '/printers'
export const appLandingPageSettingSchema = z.union([appLandingPagePathSchema, legacyAppLandingPageSettingSchema])

export type AppThemeSetting = z.infer<typeof appThemeSettingSchema>
export type AppLandingPageSetting = z.infer<typeof appLandingPageSettingSchema>

/**
 * Shared application-level settings exposed by the core API.
 *
 * `unconstrainedWidth` removes the shell's desktop max-width cap so the
 * app can expand to the full viewport width.
 * `landingPage` controls which tenant page opens first when the app enters a workspace.
 * `quickStartDismissed` hides the Get started page once a workspace is set up;
 * until then that page is the workspace's default landing page.
 * `supportAccessEnabled` allows support users to enter the current workspace.
 * `supportAccessPermissions` controls what non-bypass support users can do.
 */
/**
 * Ordered list of primary nav-tab values (app-relative paths like `/printers`).
 * Empty means "use the built-in default order". Unknown/unavailable values are
 * ignored, and available tabs missing from the list fall back to the default
 * position, so the order survives plugins being enabled/disabled.
 */
const navTabOrderSchema = z.array(z.string()).default([])

export const generalSettingsSchema = z.object({
  appTheme: appThemeSettingSchema.default('default'),
  unconstrainedWidth: z.boolean().default(false),
  landingPage: appLandingPageSettingSchema.default(DEFAULT_APP_LANDING_PAGE),
  navTabOrder: navTabOrderSchema,
  quickStartDismissed: z.boolean().default(false),
  supportAccessEnabled: z.boolean().default(true),
  supportAccessPermissions: uniquePermissionArraySchema.default([])
})

export type GeneralSettings = z.infer<typeof generalSettingsSchema>

export const updateGeneralSettingsSchema = z.object({
  appTheme: appThemeSettingSchema.optional(),
  unconstrainedWidth: z.boolean().optional(),
  landingPage: appLandingPageSettingSchema.optional(),
  navTabOrder: z.array(z.string()).optional(),
  quickStartDismissed: z.boolean().optional(),
  supportAccessEnabled: z.boolean().optional(),
  supportAccessPermissions: uniquePermissionArraySchema.optional()
}).refine(
  (value) => value.appTheme !== undefined || value.unconstrainedWidth !== undefined || value.landingPage !== undefined || value.navTabOrder !== undefined || value.quickStartDismissed !== undefined || value.supportAccessEnabled !== undefined || value.supportAccessPermissions !== undefined,
  'At least one general setting must be provided.'
)

export type UpdateGeneralSettingsInput = z.infer<typeof updateGeneralSettingsSchema>