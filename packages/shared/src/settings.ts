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
 * Ordered list of primary nav-tab values (app-relative paths like `/printers`).
 * Empty means "use the built-in default order". Unknown/unavailable values are
 * ignored, and available tabs missing from the list fall back to the default
 * position, so the order survives plugins being enabled/disabled.
 */
const navTabOrderSchema = z.array(z.string()).default([])

/** Which side of the 3D viewport the model studio's settings/objects panel sits on. */
export const editorSidebarSideSchema = z.enum(['left', 'right'])
export type EditorSidebarSideSetting = z.infer<typeof editorSidebarSideSchema>

/**
 * Shared application-level settings exposed by the core API.
 *
 * `unconstrainedWidth` removes the shell's desktop max-width cap so the
 * app can expand to the full viewport width.
 * `slicerDeveloperMode` reveals BambuStudio's developer-mode (`develop`-tier)
 * options in the process-settings editor; it is the workspace-wide default that
 * a per-device override (browser localStorage) can shadow.
 * `landingPage` controls which tenant page opens first when the app enters a workspace.
 * `quickStartDismissed` hides the Get started page once a workspace is set up;
 * until then that page is the workspace's default landing page.
 * `supportAccessEnabled` allows support users to enter the current workspace.
 * `supportAccessPermissions` controls what non-bypass support users can do.
 * `editorShowBedModel` and `editorSidebarSide` are the model studio's viewport
 * preferences. Like `slicerDeveloperMode` these are workspace-wide DEFAULTS that a
 * per-device override (browser localStorage) can shadow — a workspace can set the
 * house style while a given machine still differs (e.g. a left-handed layout, or a
 * weak GPU skipping the modelled plate).
 */
export const generalSettingsSchema = z.object({
  appTheme: appThemeSettingSchema.default('default'),
  unconstrainedWidth: z.boolean().default(false),
  slicerDeveloperMode: z.boolean().default(false),
  landingPage: appLandingPageSettingSchema.default(DEFAULT_APP_LANDING_PAGE),
  navTabOrder: navTabOrderSchema,
  quickStartDismissed: z.boolean().default(false),
  supportAccessEnabled: z.boolean().default(true),
  supportAccessPermissions: uniquePermissionArraySchema.default([]),
  editorShowBedModel: z.boolean().default(true),
  editorSidebarSide: editorSidebarSideSchema.default('right')
})

export type GeneralSettings = z.infer<typeof generalSettingsSchema>

export const updateGeneralSettingsSchema = z.object({
  appTheme: appThemeSettingSchema.optional(),
  unconstrainedWidth: z.boolean().optional(),
  slicerDeveloperMode: z.boolean().optional(),
  landingPage: appLandingPageSettingSchema.optional(),
  navTabOrder: z.array(z.string()).optional(),
  quickStartDismissed: z.boolean().optional(),
  supportAccessEnabled: z.boolean().optional(),
  supportAccessPermissions: uniquePermissionArraySchema.optional(),
  editorShowBedModel: z.boolean().optional(),
  editorSidebarSide: editorSidebarSideSchema.optional()
}).refine(
  (value) => value.appTheme !== undefined || value.unconstrainedWidth !== undefined || value.slicerDeveloperMode !== undefined || value.landingPage !== undefined || value.navTabOrder !== undefined || value.quickStartDismissed !== undefined || value.supportAccessEnabled !== undefined || value.supportAccessPermissions !== undefined || value.editorShowBedModel !== undefined || value.editorSidebarSide !== undefined,
  'At least one general setting must be provided.'
)

export type UpdateGeneralSettingsInput = z.infer<typeof updateGeneralSettingsSchema>