/**
 * Core application settings persisted in the shared `Setting` table.
 *
 * These settings are global to the installation, unlike web-only
 * device preferences that stay in browser localStorage.
 */
import type { AppLandingPageSetting, AppThemeSetting, GeneralSettings, UpdateGeneralSettingsInput } from '@printstream/shared'
import { DEFAULT_APP_LANDING_PAGE, appLandingPageSettingSchema, appThemeSettingSchema, generalSettingsSchema } from '@printstream/shared'
import { prisma } from './prisma.js'
import { scopeSettingKey } from './workspace-settings.js'
import { listAllWorkspaceSupportPermissions, serializeSupportAccessPermissions, SUPPORT_ACCESS_ENABLED_SETTING_KEY, SUPPORT_ACCESS_PERMISSIONS_SETTING_KEY } from './support-access.js'

const APP_THEME_KEY = 'app:general:theme'
const UNCONSTRAINED_WIDTH_KEY = 'app:general:unconstrainedWidth'
const SLICER_DEVELOPER_MODE_KEY = 'app:general:slicerDeveloperMode'
const LANDING_PAGE_KEY = 'app:general:landingPage'
// Value is a PrinterView id; an empty string encodes "no default" (Overview) —
// the store interface has no delete, so clearing writes ''.
const PRINTERS_DEFAULT_VIEW_KEY = 'app:general:printersDefaultViewId'
const NAV_TAB_ORDER_KEY = 'app:general:navTabOrder'
const QUICK_START_DISMISSED_KEY = 'app:general:quickStartDismissed'

interface GeneralSettingsStore {
  findUnique(args: { where: { key: string } }): Promise<{ value: string } | null>
  upsert(args: {
    where: { key: string }
    create: { key: string; value: string }
    update: { value: string }
  }): Promise<unknown>
}

export async function getGeneralSettings(store: GeneralSettingsStore = prisma.setting): Promise<GeneralSettings> {
  const [appThemeRow, unconstrainedWidthRow, slicerDeveloperModeRow, landingPageRow, printersDefaultViewRow, navTabOrderRow, quickStartDismissedRow, supportAccessEnabledRow, supportAccessPermissionsRow] = await Promise.all([
    store.findUnique({ where: { key: scopeSettingKey(APP_THEME_KEY) } }),
    store.findUnique({ where: { key: scopeSettingKey(UNCONSTRAINED_WIDTH_KEY) } }),
    store.findUnique({ where: { key: scopeSettingKey(SLICER_DEVELOPER_MODE_KEY) } }),
    store.findUnique({ where: { key: scopeSettingKey(LANDING_PAGE_KEY) } }),
    store.findUnique({ where: { key: scopeSettingKey(PRINTERS_DEFAULT_VIEW_KEY) } }),
    store.findUnique({ where: { key: scopeSettingKey(NAV_TAB_ORDER_KEY) } }),
    store.findUnique({ where: { key: scopeSettingKey(QUICK_START_DISMISSED_KEY) } }),
    store.findUnique({ where: { key: scopeSettingKey(SUPPORT_ACCESS_ENABLED_SETTING_KEY) } }),
    store.findUnique({ where: { key: scopeSettingKey(SUPPORT_ACCESS_PERMISSIONS_SETTING_KEY) } })
  ])

  return generalSettingsSchema.parse({
    appTheme: parseAppThemeSetting(appThemeRow?.value),
    unconstrainedWidth: unconstrainedWidthRow?.value === 'true',
    slicerDeveloperMode: slicerDeveloperModeRow?.value === 'true',
    landingPage: parseLandingPageSetting(landingPageRow?.value),
    printersDefaultViewId: printersDefaultViewRow?.value ? printersDefaultViewRow.value : null,
    navTabOrder: parseNavTabOrder(navTabOrderRow?.value),
    quickStartDismissed: quickStartDismissedRow?.value === 'true',
    supportAccessEnabled: supportAccessEnabledRow?.value !== 'false',
    supportAccessPermissions: parseSupportAccessPermissions(supportAccessPermissionsRow?.value)
  })
}

export async function updateGeneralSettings(
  input: UpdateGeneralSettingsInput,
  store: GeneralSettingsStore = prisma.setting
): Promise<GeneralSettings> {
  const current = await getGeneralSettings(store)

  if (input.appTheme !== undefined) {
    const key = scopeSettingKey(APP_THEME_KEY)
    await store.upsert({
      where: { key },
      create: { key, value: input.appTheme },
      update: { value: input.appTheme }
    })
  }

  if (input.unconstrainedWidth !== undefined) {
    const key = scopeSettingKey(UNCONSTRAINED_WIDTH_KEY)
    await store.upsert({
      where: { key },
      create: { key, value: String(input.unconstrainedWidth) },
      update: { value: String(input.unconstrainedWidth) }
    })
  }

  if (input.slicerDeveloperMode !== undefined) {
    const key = scopeSettingKey(SLICER_DEVELOPER_MODE_KEY)
    await store.upsert({
      where: { key },
      create: { key, value: String(input.slicerDeveloperMode) },
      update: { value: String(input.slicerDeveloperMode) }
    })
  }

  if (input.landingPage !== undefined) {
    const key = scopeSettingKey(LANDING_PAGE_KEY)
    await store.upsert({
      where: { key },
      create: { key, value: input.landingPage },
      update: { value: input.landingPage }
    })
  }

  if (input.printersDefaultViewId !== undefined) {
    const key = scopeSettingKey(PRINTERS_DEFAULT_VIEW_KEY)
    const value = input.printersDefaultViewId ?? ''
    await store.upsert({
      where: { key },
      create: { key, value },
      update: { value }
    })
  }

  if (input.navTabOrder !== undefined) {
    const key = scopeSettingKey(NAV_TAB_ORDER_KEY)
    const value = JSON.stringify(input.navTabOrder)
    await store.upsert({
      where: { key },
      create: { key, value },
      update: { value }
    })
  }

  if (input.quickStartDismissed !== undefined) {
    const key = scopeSettingKey(QUICK_START_DISMISSED_KEY)
    await store.upsert({
      where: { key },
      create: { key, value: String(input.quickStartDismissed) },
      update: { value: String(input.quickStartDismissed) }
    })
  }

  if (input.supportAccessEnabled !== undefined) {
    const key = scopeSettingKey(SUPPORT_ACCESS_ENABLED_SETTING_KEY)
    await store.upsert({
      where: { key },
      create: { key, value: String(input.supportAccessEnabled) },
      update: { value: String(input.supportAccessEnabled) }
    })
  }

  if (input.supportAccessPermissions !== undefined) {
    const key = scopeSettingKey(SUPPORT_ACCESS_PERMISSIONS_SETTING_KEY)
    await store.upsert({
      where: { key },
      create: { key, value: serializeSupportAccessPermissions(input.supportAccessPermissions) },
      update: { value: serializeSupportAccessPermissions(input.supportAccessPermissions) }
    })
  }

  return generalSettingsSchema.parse({
    ...current,
    ...input
  })
}

/**
 * Clear the workspace's default printer view when the view it names is deleted,
 * so the setting never advertises a dangling id. Readers tolerate a stale id
 * anyway (they fall back to the Overview), so a raced delete is harmless —
 * this just keeps the stored state honest. Runs in the caller's workspace scope.
 */
export async function clearPrintersDefaultViewIdIfMatches(
  viewId: string,
  store: GeneralSettingsStore = prisma.setting
): Promise<void> {
  const key = scopeSettingKey(PRINTERS_DEFAULT_VIEW_KEY)
  const row = await store.findUnique({ where: { key } })
  if (row?.value !== viewId) return
  await store.upsert({
    where: { key },
    create: { key, value: '' },
    update: { value: '' }
  })
}

function parseSupportAccessPermissions(value: string | undefined): string[] {
  if (!value) return listAllWorkspaceSupportPermissions()
  try {
    const parsed = JSON.parse(value) as unknown
    return generalSettingsSchema.shape.supportAccessPermissions.parse(parsed)
  } catch {
    return listAllWorkspaceSupportPermissions()
  }
}

function parseNavTabOrder(value: string | undefined): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return generalSettingsSchema.shape.navTabOrder.parse(parsed)
  } catch {
    return []
  }
}

function parseAppThemeSetting(value: string | undefined): AppThemeSetting {
  const parsed = appThemeSettingSchema.safeParse(value)
  return parsed.success ? parsed.data : 'default'
}

function parseLandingPageSetting(value: string | undefined): AppLandingPageSetting {
  const parsed = appLandingPageSettingSchema.safeParse(value)
  return parsed.success ? parsed.data : DEFAULT_APP_LANDING_PAGE
}