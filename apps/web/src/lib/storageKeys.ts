/**
 * Browser storage keys owned by core (CONF-7, D-105). Plugins and the private cloud module declare
 * their own in their own `storageKeys.ts`; `browserStorageKeys.ts` explains the registry.
 *
 * Keys already in `printstream.<area>.<name>` form keep their names. The others were renamed in one
 * pass, each listing its former name so a saved value carries over: the `bambu.` prefix from the
 * product's old name, unprefixed keys, and the `printstream:` / `printstream-` / two-segment
 * spellings.
 */
import { defineStorageKey, defineStorageKeyFamily } from './browserStorageKeys'

const owner = 'core'

/** Old `bambu.<rest>` name for a key renamed to `printstream.<rest>`. */
function bambu(key: string): string {
  return key.replace(/^printstream\./, 'bambu.')
}

/** A device preference in localStorage, renamed from its `bambu.` spelling when `renamed` is set. */
function preference(key: string, options: { renamed?: boolean } = {}) {
  return defineStorageKey({ key, storage: 'local', kind: 'preference', owner, legacyKeys: options.renamed ? [bambu(key)] : [] })
}

/** A family of device preferences, renamed from its `bambu.` spelling when `renamed` is set. */
function preferenceFamily(prefix: string, options: { renamed?: boolean } = {}) {
  return defineStorageKeyFamily({ prefix, storage: 'local', kind: 'preference', owner, legacyPrefixes: options.renamed ? [bambu(prefix)] : [] })
}

// ---------------------------------------------------------------------------
// App shell and appearance
// ---------------------------------------------------------------------------

/** This device's theme override inside a workspace. */
export const appThemeOverrideKey = preference('printstream.general.appTheme.override')
/**
 * Platform surfaces keep their own device override so a theme chosen inside a workspace never
 * restyles the platform workspace (and vice versa).
 */
export const platformAppThemeOverrideKey = preference('printstream.general.appTheme.override.platform')
/**
 * The billing scope's own theme, per device.
 *
 * It needs a third key because it is neither of the other two. The scope has no workspace context,
 * so it used to fall through to the WORKSPACE device override paired with the shared setting, and a
 * shared setting read without a workspace resolves to the `platform:` scope, which is the
 * OPERATOR's. A customer's billing pages were therefore styled by whatever theme the operator had
 * chosen for the platform.
 *
 * Device-only, deliberately: a per-account shared theme would need a new server scope, and the thing
 * a customer actually wants here is for their own screen to match the workspace they just came from.
 */
export const billingAppThemeOverrideKey = preference('printstream.general.appTheme.override.billing')

/**
 * Cache of the last theme background the app painted (`{ background, color }` JSON). The
 * `apps/web/index.html` pre-bundle script applies it before first paint, so the boot splash matches
 * the theme that loads afterwards; it reads this name as a literal, so the name cannot change
 * without changing that file in the same commit.
 */
export const bootBackgroundKey = defineStorageKey({ key: 'printstream.appearance.bootBackground', storage: 'local', kind: 'cache', owner })

/** This device's landing page and nav tab order, per workspace slug. */
export const landingPageOverrideKeys = preferenceFamily('printstream.general.landingPage.override')
export const navTabOrderOverrideKeys = preferenceFamily('printstream.general.navTabOrder.override')

export const unconstrainedWidthOverrideKey = preference('printstream.general.unconstrainedWidth.override', { renamed: true })
/**
 * Per-device override for the workspace-wide "developer slicer settings" default. Device-global
 * (like the theme override), so the preference to see BambuStudio's develop-tier options follows the
 * browser across workspaces.
 */
export const slicerDeveloperModeOverrideKey = preference('printstream.slicer.developerMode.override')

/**
 * Model studio viewport overrides. Workspace-scoped (like the nav-order and landing-page overrides,
 * and unlike the device-global theme and developer-mode ones): each workspace sets its own shared
 * default, so a device override that leaked across workspaces would silently shadow a default it was
 * never chosen against. The suffix is the editor scope: see `lib/editorViewportSettings.ts`.
 */
export const editorShowBedModelOverrideKeys = preferenceFamily('printstream.editor.bedModel3d.override')
export const editorSidebarSideOverrideKeys = preferenceFamily('printstream.editor.sidebarSide.override')

/**
 * Joy's colour-mode storage, forced to dark on every load (`AppThemeProvider`). Joy reads and writes
 * these itself, appending `-light` / `-dark` to the scheme key; the old `printstream-color-*` names
 * are not carried over because the forced mode rewrites them anyway.
 */
export const colorModeKey = defineStorageKey({ key: 'printstream.theme.colorMode', storage: 'local', kind: 'library', owner })
export const colorSchemeKey = defineStorageKey({ key: 'printstream.theme.colorScheme', storage: 'local', kind: 'library', owner })

// ---------------------------------------------------------------------------
// Shared directory controls
// ---------------------------------------------------------------------------

/**
 * Which filters a directory toolbar keeps pinned open, per toolbar (`pinStorageKey`). A toolbar
 * without one, which cannot pin, uses the `default` member.
 */
export const directoryToolbarPinnedKeys = defineStorageKeyFamily({
  prefix: 'printstream.directory.toolbarPinned',
  storage: 'local',
  kind: 'preference',
  owner,
  legacyKeysFor: (suffix) => [suffix === 'default' ? 'directory.toolbar.pinned' : `directory.toolbar.pinned.${suffix}`]
})

/**
 * A tag filter's selection: `<area>.<route scope>`. Its old name was built from a caller-specific
 * key, so the tag filter hooks pass that old name themselves.
 */
export const tagFilterKeys = defineStorageKeyFamily({ prefix: 'printstream.tagFilter', storage: 'local', kind: 'preference', owner })

// ---------------------------------------------------------------------------
// Settings: people
// ---------------------------------------------------------------------------

export const userDirectoryViewModeKey = preference('printstream.auth.users.viewMode', { renamed: true })
export const userDirectorySortKey = preference('printstream.auth.users.sort', { renamed: true })
export const userDirectorySortDirKey = preference('printstream.auth.users.sortDir', { renamed: true })
export const userDirectoryStatusFilterKey = preference('printstream.auth.users.statusFilter', { renamed: true })
export const userDirectoryRoleFiltersKey = preference('printstream.auth.users.roleFilters', { renamed: true })
export const userDirectoryPageSizeKey = preference('printstream.auth.users.pageSize', { renamed: true })

// ---------------------------------------------------------------------------
// Announcements and changelogs
// ---------------------------------------------------------------------------

/** The newest changelog entry this device has read: not refillable, so a record. */
export const productChangelogLastReadKey = defineStorageKey({ key: 'printstream.productChangelog.lastReadVersion', storage: 'local', kind: 'record', owner })
export const companionChangelogLastReadKey = defineStorageKey({ key: 'printstream.companionChangelog.lastReadVersion', storage: 'local', kind: 'record', owner })

/** Announcements read on this device, per feed URL (the URL follows a `:`). */
export const announcementReadSlugsKeys = defineStorageKeyFamily({ prefix: 'printstream.announcements.readSlugs', separator: ':', storage: 'local', kind: 'record', owner })
/** The last announcement feed fetched, per feed URL. */
export const announcementLastFetchKeys = defineStorageKeyFamily({ prefix: 'printstream.announcements.lastFetch', separator: ':', storage: 'local', kind: 'cache', owner })

// ---------------------------------------------------------------------------
// Slicing presets
// ---------------------------------------------------------------------------

export const slicingPresetKindTabKey = preference('printstream.slicingPresets.kindTab')
// The older `slicingProfiles` spelling is kept: it already fits D-105, and renaming would only add a
// migration for nothing.
export const slicingPresetSortKey = preference('printstream.slicingProfiles.sort')
export const slicingPresetSortDirKey = preference('printstream.slicingProfiles.sortDir')
export const slicingPresetPageSizeKey = preference('printstream.slicingProfiles.pageSize')

// ---------------------------------------------------------------------------
// Printers
// ---------------------------------------------------------------------------

/** Whether a printer card shows its external spools, per printer id. */
export const printerExternalSpoolsExpandedKeys = preferenceFamily('printstream.printers.externalSpoolsExpanded', { renamed: true })

/** The printer overview's preferences, per workspace preference scope. */
export const printerCardsPerRowKeys = preferenceFamily('printstream.printers.cardsPerRow', { renamed: true })
export const printerStateFilterKeys = preferenceFamily('printstream.printers.stateFilter', { renamed: true })
export const printerModelFilterKeys = preferenceFamily('printstream.printers.modelFilter', { renamed: true })
export const printerNozzleDiameterFilterKeys = preferenceFamily('printstream.printers.nozzleDiameterFilter', { renamed: true })
export const printerPlateTypeFilterKeys = preferenceFamily('printstream.printers.plateTypeFilter', { renamed: true })
export const printerCardContentSettingsKeys = preferenceFamily('printstream.printers.cardContentSettings', { renamed: true })
export const printerSingleCardContentSettingsKeys = preferenceFamily('printstream.printers.singleCardContentSettings', { renamed: true })
export const printerViewPrinterIdsKeys = preferenceFamily('printstream.printers.viewPrinterIds', { renamed: true })
export const printerViewSortKeys = preferenceFamily('printstream.printers.viewSort', { renamed: true })
export const printerOverviewGroupKeys = preferenceFamily('printstream.printers.overviewGroup', { renamed: true })
export const printerOverviewPageSizeKeys = preferenceFamily('printstream.printers.overviewPageSize', { renamed: true })
export const printerDefaultViewIdKeys = preferenceFamily('printstream.printers.defaultViewId', { renamed: true })

/** A printer's job history panel. */
export const printerHistoryViewModeKey = preference('printstream.printers.history.viewMode')
export const printerHistorySortDirKey = preference('printstream.printers.history.sortDir')
export const printerHistoryResultFilterKey = preference('printstream.printers.history.resultFilter')
export const printerHistoryPageSizeKey = preference('printstream.printers.history.pageSize')

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export const jobHistoryViewModeKey = preference('printstream.jobs.history.viewMode')
export const jobHistorySortKey = preference('printstream.jobs.history.sort')
export const jobHistorySortDirKey = preference('printstream.jobs.history.sortDir')
export const jobHistoryResultFilterKey = preference('printstream.jobs.history.resultFilter')
export const jobHistoryKindFilterKey = preference('printstream.jobs.history.kindFilter')
export const jobHistoryPrinterFilterKey = preference('printstream.jobs.history.printerFilter')
export const jobHistoryPageSizeKey = preference('printstream.jobs.history.pageSize')

// ---------------------------------------------------------------------------
// Library (also used by the orders plugin's library pickers)
// ---------------------------------------------------------------------------

export const libraryViewModeKey = preference('printstream.library.viewMode', { renamed: true })
export const librarySortKey = preference('printstream.library.sort', { renamed: true })
export const libraryGroupKey = preference('printstream.library.group', { renamed: true })
export const libraryPageSizeKey = preference('printstream.library.pageSize', { renamed: true })
export const libraryFileTypeFiltersKey = preference('printstream.library.fileTypeFilters', { renamed: true })
export const libraryPrinterModelFiltersKey = preference('printstream.library.printerModelFilters', { renamed: true })
export const libraryNozzleSizeFiltersKey = preference('printstream.library.nozzleSizeFilters', { renamed: true })
export const libraryPlateTypeFiltersKey = preference('printstream.library.plateTypeFilters', { renamed: true })

/**
 * Whether the 3MF preview opens maximized. Declared here rather than in model-studio because core's
 * lazy-loading placeholder sizes itself from it before the plugin's chunk arrives.
 */
export const previewMaximizedKey = preference('printstream.preview.maximized', { renamed: true })

// ---------------------------------------------------------------------------
// Prompts and one-shot flows
// ---------------------------------------------------------------------------

/** A dismissed passkey setup offer, per user id. */
export const passkeySetupDismissedKeys = defineStorageKeyFamily({
  prefix: 'printstream.passkeySetup.dismissed',
  storage: 'local',
  kind: 'record',
  owner,
  legacyPrefixes: ['printstream.passkeySetupPromptDismissed']
})
/** Set by sign-up or sign-in to offer passkey setup on the next screen. */
export const passkeySetupPromptKey = defineStorageKey({ key: 'printstream.passkeySetup.prompt', storage: 'session', kind: 'flow', owner, legacyKeys: ['printstream.passkeySetupPrompt'] })

/** A dismissed native app offer, per platform. */
export const nativeAppPromotionDismissedKeys = defineStorageKeyFamily({ prefix: 'printstream.nativeAppPromotion.dismissed.v1', storage: 'local', kind: 'record', owner })
export const nativeAppPromotionAfterSignInKey = defineStorageKey({ key: 'printstream.nativeAppPromotion.afterSignIn.v1', storage: 'session', kind: 'flow', owner })
export const nativeAppPromotionDevResetKey = defineStorageKey({ key: 'printstream.nativeAppPromotion.devReset.v1', storage: 'session', kind: 'flow', owner })

/**
 * A dismissed mobile notification offer for a set of scopes, keyed by account and scopes. Built in
 * core (`native/notificationScopes.ts`) and read by the notifications-mobile plugin.
 */
export const mobileNotificationOfferKeys = defineStorageKeyFamily({
  prefix: 'printstream.mobileNotifications.v2',
  separator: ':',
  storage: 'local',
  kind: 'record',
  owner,
  legacyPrefixes: ['printstream.mobile-notifications.v2']
})

/** This tab's client id, kept for the tab's lifetime. */
export const tabSessionIdKey = defineStorageKey({ key: 'printstream.tab.sessionId', storage: 'session', kind: 'flow', owner, legacyKeys: ['printstream.tabSessionId'] })
/** The build a stale tab last reloaded onto, so it never loops. */
export const staleReloadTargetKey = defineStorageKey({ key: 'printstream.appUpdate.reloadTarget', storage: 'session', kind: 'flow', owner, legacyKeys: ['printstream:stale-reload-target'] })
/** A bridge connect code waiting for sign-in. */
export const pendingBridgeConnectCodeKey = defineStorageKey({ key: 'printstream.bridgeConnect.pendingCode', storage: 'session', kind: 'flow', owner, legacyKeys: ['printstream.pendingBridgeConnectCode'] })
/** Where the native app returns to after a hand-off to the browser. */
export const nativeReturnPathKey = defineStorageKey({ key: 'printstream.native.returnPath', storage: 'session', kind: 'flow', owner })
