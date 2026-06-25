/**
 * App-shell helpers: pure route/path utilities, device-override localStorage keys,
 * and JSON parsers for nullable per-device setting overrides used by `App`.
 *
 * These are module-level, side-effect-free declarations factored out of `App.tsx`
 * to keep the component file focused on the shell component itself.
 */
import {
  appLandingPageSettingSchema,
  type AppLandingPageSetting,
  type AppThemeSetting
} from '@printstream/shared'

export const DEVICE_APP_THEME_OVERRIDE_KEY = 'printstream.general.appTheme.override'
export const DEVICE_LANDING_PAGE_OVERRIDE_KEY_PREFIX = 'printstream.general.landingPage.override'
export const DEVICE_NAV_TAB_ORDER_OVERRIDE_KEY_PREFIX = 'printstream.general.navTabOrder.override'
export const DEVICE_UNCONSTRAINED_WIDTH_OVERRIDE_KEY = 'bambu.general.unconstrainedWidth.override'

export function tenantScopedRoutePath(path: string): string {
  return path === '/' ? '/workspaces/:tenantSlug' : `/workspaces/:tenantSlug${path}`
}

export function parseNullableBoolean(raw: string): boolean | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'boolean' || parsed === null ? parsed : null
  } catch {
    return null
  }
}

export function parseNullableAppThemeSetting(raw: string): AppThemeSetting | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed === 'default' || parsed === 'aurora' || parsed === null ? parsed : null
  } catch {
    return null
  }
}

export function parseNullableAppLandingPageSetting(raw: string): AppLandingPageSetting | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null) {
      return null
    }

    const result = appLandingPageSettingSchema.safeParse(parsed)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

/** Per-device nav-tab order override: an array of tab values, or null to follow the workspace default. */
export function parseNullableNavTabOrder(raw: string): string[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null) return null
    return Array.isArray(parsed) && parsed.every((value) => typeof value === 'string') ? parsed : null
  } catch {
    return null
  }
}
