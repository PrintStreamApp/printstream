/**
 * Top-level page shell.
 *
 * Mirrors the `game-is-up` dashboard aesthetic: ambient gradient
 * background, a bottom-docked mobile primary nav, a sticky desktop tab
 * row, and a max-width content column.
 */
import React, { type MouseEvent, type ReactNode } from 'react'
import { Box, Button, Stack, Tab, TabList, Tabs, Tooltip, Typography } from '@mui/joy'
import type { ShellIdentity } from '../lib/authUi'
import { HorizontalOverflowScroller } from './HorizontalOverflowScroller'
import { appShellDesktopSecondaryNavHostId } from './AppShell.constants'
import { navDensitySx, sectionTabSx } from '../theme/theme'
import { useShellTabBadges } from '../lib/shellBadges'
import { WORKSPACE_CHOOSER_LABEL } from '../lib/workspaceRoute'
import { tabTooltip } from './tabTooltip'
import { useFittedNavDensity } from '../hooks/useFittedNavDensity'

const ambientOverlayBase = [
  'var(--printstream-shell-ambient-overlay-base)',
  'var(--printstream-shell-ambient-overlay-glow)'
].join(',')

export interface ShellTab<TValue extends string = string> {
  value: TValue
  label: string
  ariaLabel?: string
  /**
   * What the tab is FOR, shown as its tooltip when the label is already on
   * screen. Omit it and a readable tab gets no tooltip at all, a tooltip that
   * repeats the word under the pointer is noise, so this has to earn its place
   * by saying something the label does not.
   */
  description?: string
  icon?: ReactNode
  mobileIcon?: ReactNode
  iconOnly?: boolean
}

interface AppShellProps<TValue extends string> {
  tabs: ReadonlyArray<ShellTab<TValue>>
  /** Tab owning the current route, or null when the route is outside every tab's subtree (no tab highlighted). */
  activeTab: TValue | null
  currentPath: string
  onTabChange: (tab: TValue) => void
  onOpenAccount?: () => void
  workspaceLabel?: string
  workspaceChooserLabel?: string
  /** Switcher affordance shown beside the active workspace name. */
  workspaceChooserIcon?: ReactNode
  showNavigationFrame?: boolean
  unconstrainedWidth?: boolean
  identity?: ShellIdentity | null
  identityIcon?: ReactNode
  workspaceChooserAvailable?: boolean
  onOpenWorkspaceChooser?: () => void
  workspaceChooserPending?: boolean
  onLogoClick?: () => void
  contentHeaderTrailing?: ReactNode
  /** Footer actions that stay together beside the user/workspace group. */
  footerActions?: ReactNode
  /** Secondary footer content rendered below the primary row. */
  footerTrailing?: ReactNode
  children: ReactNode
}

export function AppShell<TValue extends string>({
  tabs,
  activeTab,
  currentPath,
  onTabChange,
  onOpenAccount,
  workspaceLabel,
  workspaceChooserLabel,
  workspaceChooserIcon,
  showNavigationFrame = false,
  unconstrainedWidth = false,
  identity = null,
  identityIcon,
  workspaceChooserAvailable = false,
  onOpenWorkspaceChooser,
  workspaceChooserPending = false,
  onLogoClick,
  contentHeaderTrailing,
  footerActions,
  footerTrailing,
  children
}: AppShellProps<TValue>) {
  const primaryTabSx = {
    ...sectionTabSx,
    minHeight: { xs: 42, sm: 52 },
    px: { xs: 0.25, sm: 2 },
    fontSize: { xs: 'xs', sm: 'md' }
  } as const

  const iconOnlyTabSx = {
    flex: { xs: '1 1 0', sm: '0 0 auto' },
    minWidth: { xs: 0, sm: 56 },
    px: { xs: 0.125, sm: 1.25 }
  } as const

  // Keyed on the tabs themselves, not just their count: a plugin swapping one
  // tab for a longer-worded one changes what has to fit without changing how
  // many there are.
  const { ref: desktopTabListRef, density: desktopNavDensity } = useFittedNavDensity<HTMLDivElement>(
    tabs.map((tab) => tab.value).join('|')
  )
  const desktopLabelsHidden = desktopNavDensity === 'icons'

  const hasTabs = tabs.length > 0
  const showsNavigationFrame = showNavigationFrame || hasTabs
  const canOpenWorkspaceChooser = workspaceChooserAvailable && typeof onOpenWorkspaceChooser === 'function'
  const badgedTabs = useShellTabBadges()
  const showsWorkspaceChooser = workspaceChooserAvailable
  const workspaceChooserButtonLabel = workspaceChooserLabel ?? WORKSPACE_CHOOSER_LABEL
  const workspaceChooserButtonAriaLabel = workspaceChooserLabel
    ? `${WORKSPACE_CHOOSER_LABEL}. Currently in: ${workspaceChooserLabel}`
    : WORKSPACE_CHOOSER_LABEL
  const shouldNavigateToTab = (tabValue: TValue) => {
    if (currentPath === tabValue) return false
    if (currentPath.startsWith(`${tabValue}/`)) return true
    return activeTab === tabValue
  }
  const handleTabListClickCapture = (event: MouseEvent<HTMLElement>) => {
    const tab = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-tab-value]')
    const tabValue = tab?.dataset.tabValue
    if (!tabValue) return
    if (shouldNavigateToTab(tabValue as TValue)) onTabChange(tabValue as TValue)
  }
  const handleLogoClick = (event: MouseEvent<HTMLElement>) => {
    event.stopPropagation()
    onLogoClick?.()
  }

  return (
    <Box
      sx={{
        minHeight: '100vh',
        position: 'relative',
        // Column + `mt: auto` on the footer keeps it at the bottom of the
        // viewport when the page does not fill it, rather than floating under
        // short content with dead space beneath.
        display: 'flex',
        flexDirection: 'column',
        px: { xs: 2, md: 4 },
        pt: {
          xs: 'calc(var(--app-top-inset, 0px) + 16px)',
          md: 'calc(var(--app-top-inset, 0px) + 10px)'
        },
        pb: {
          // The 78px clears the FIXED mobile nav bar below, so it is reserved
          // only when that bar is actually rendered. Reserving it unconditionally
          // pushed every tab-less page (the workspace chooser, sign-in) past the
          // viewport by exactly the height of a bar that was not there.
          xs: showsNavigationFrame
            ? 'calc(var(--app-safe-bottom, 0px) + 78px)'
            : 'calc(var(--app-safe-bottom, 0px) + 16px)',
          sm: 4,
          md: 5
        }
      }}
    >
      <Box
        aria-hidden="true"
        sx={{
          position: 'fixed',
          inset: 0,
          background: ambientOverlayBase,
          pointerEvents: 'none',
          zIndex: 0
        }}
      />
      <Box
        aria-hidden="true"
        sx={{
          position: 'fixed',
          inset: 0,
          backgroundImage: [
            'var(--printstream-shell-ambient-highlight)',
            'var(--printstream-shell-ambient-spectrum)'
          ].join(','),
          backgroundBlendMode: 'screen, normal',
          backgroundSize: 'auto, 100% 100%',
          backgroundPosition: 'center top, center',
          opacity: 0.05,
          pointerEvents: 'none',
          zIndex: 0
        }}
      />
      <Stack
        spacing={4}
        sx={{
          position: 'relative',
          zIndex: 1,
          width: '100%',
          maxWidth: unconstrainedWidth ? 'none' : 1200,
          mx: 'auto',
          // Grows to fill the root's `minHeight: 100vh`, which is what gives the
          // footer's `mt: auto` room to push against. Without it the column is
          // only as tall as its content and the footer floats mid-viewport.
          flexGrow: 1
        }}
      >
        <Tabs
          value={activeTab}
          onChange={(_event, value) => {
            if (typeof value === 'string') onTabChange(value as TValue)
          }}
          sx={{
            '--Tabs-gap': '1rem',
            '--Tab-indicatorThickness': '0px',
            backgroundColor: 'transparent'
          }}
        >
          {showsNavigationFrame && (
            <Box
              sx={{
                display: { xs: 'block', sm: 'none' },
                position: 'fixed',
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: 20,
                backgroundColor: 'var(--printstream-shell-nav-background)'
              }}
            >
              <HorizontalOverflowScroller
                sx={{
                  my: 0,
                  mx: 0,
                  borderRadius: 0,
                  backgroundColor: 'transparent',
                  border: 'none',
                  backdropFilter: 'blur(10px) saturate(1.04)',
                  WebkitBackdropFilter: 'blur(10px) saturate(1.04)',
                  boxShadow: '0 14px 26px -18px rgba(0, 0, 0, 0.92)',
                  '& .MuiTab-root': { transform: 'none' }
                }}
                scrollerSx={{
                  pt: 0.0625,
                  pb: 'calc(var(--app-safe-bottom, 0px) + 0.0625rem)',
                  px: 0.125
                }}
                fadeColor="var(--printstream-shell-nav-background)"
              >
                <TabList
                  disableUnderline
                  onClickCapture={handleTabListClickCapture}
                  sx={{
                    my: 0,
                    mx: 0,
                    width: '100%',
                    minWidth: '100%',
                    gap: { xs: 0, sm: 0.25 },
                    alignItems: 'center',
                    position: 'relative',
                    borderRadius: 0,
                    flexWrap: 'nowrap',
                    backgroundColor: 'transparent',
                    border: 'none',
                    boxShadow: 'none'
                  }}
                >
                  {/* No logo in this bar. It cost ~54px of a 375px-wide dock: enough to push a
                      tab off the end, and it duplicated the desktop header's home affordance
                      while the bar's whole job is reaching the tabs. */}
                  {tabs.map((tab) => (
                    // The app's tooltip rather than the browser's `title`, which
                    // renders unstyled after its own delay and cannot match the
                    // surrounding chrome.
                    <Tooltip
                      key={tab.value}
                      title={tabTooltip(tab, { labelHidden: Boolean(tab.mobileIcon) })}
                      variant="soft"
                      size="sm"
                    >
                    <Tab
                      value={tab.value}
                      data-tab-value={tab.value}
                      sx={[...(tab.iconOnly || tab.mobileIcon ? [primaryTabSx, iconOnlyTabSx] : [primaryTabSx]), { position: 'relative' }]}
                      aria-label={tab.ariaLabel ?? tab.label}
                    >
                      {badgedTabs.has(tab.value) && <TabBadgeDot />}
                      {tab.iconOnly ? (
                        <Box
                          component="span"
                          sx={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            '& svg': { fontSize: { xs: 32, sm: 24 } }
                          }}
                        >
                          {tab.icon ?? tab.label}
                        </Box>
                      ) : tab.mobileIcon ? (
                        <>
                          <Box
                            component="span"
                            sx={{
                              display: { xs: 'inline-flex', sm: 'none' },
                              alignItems: 'center',
                              justifyContent: 'center',
                              '& svg': { fontSize: 32 }
                            }}
                          >
                            {tab.mobileIcon}
                          </Box>
                          <Stack direction="row" spacing={0.75} alignItems="center" sx={{ display: { xs: 'none', sm: 'inline-flex' } }}>
                            {/* Falls back to the mobile icon so a tab only needs
                                to name one: every tab carries its icon on
                                desktop too, beside the label. */}
                            {(tab.icon ?? tab.mobileIcon) && (
                              <Box component="span" sx={{ display: 'inline-flex', '& svg': { fontSize: 20 } }}>
                                {tab.icon ?? tab.mobileIcon}
                              </Box>
                            )}
                            <span>{tab.label}</span>
                          </Stack>
                        </>
                      ) : (
                        <Stack direction="row" spacing={0.75} alignItems="center">
                          {tab.icon && (
                            <Box component="span" sx={{ display: 'inline-flex', '& svg': { fontSize: 20 } }}>
                              {tab.icon}
                            </Box>
                          )}
                          <span>{tab.label}</span>
                        </Stack>
                      )}
                    </Tab>
                    </Tooltip>
                  ))}
                </TabList>
              </HorizontalOverflowScroller>
            </Box>
          )}

          {showsNavigationFrame && (
            <Box
              sx={{
                display: { xs: 'none', sm: 'block' },
                position: 'sticky',
                top: {
                  sm: 'calc(var(--app-top-inset, 0px) + 8px)',
                  md: 'calc(var(--app-top-inset, 0px) + 10px)'
                },
                zIndex: 20
              }}
            >
              <TabList
                ref={desktopTabListRef}
                disableUnderline
                onClickCapture={handleTabListClickCapture}
                sx={{
                  ...navDensitySx,
                  mt: 0.5,
                  mb: 0,
                  mx: 0,
                  py: 1,
                  px: 1,
                  gap: 1,
                  position: 'relative',
                  borderRadius: 'md',
                  flexWrap: 'nowrap',
                  // The safety valve behind the tabs' `max-content` floor: once
                  // the labels genuinely cannot fit, the row scrolls (as it
                  // already does on mobile) instead of spilling outside the
                  // nav pill. The scrollbar itself stays hidden, below.
                  overflowX: 'auto',
                  scrollbarWidth: 'none',
                  '&::-webkit-scrollbar': { display: 'none' },
                  backgroundColor: 'color-mix(in srgb, var(--printstream-shell-nav-background) 88%, transparent)',
                  border: '1px solid var(--printstream-shell-nav-border)',
                  backdropFilter: 'blur(10px) saturate(1.04)',
                  WebkitBackdropFilter: 'blur(10px) saturate(1.04)',
                  boxShadow: [
                    '0 14px 26px -18px rgba(0, 0, 0, 0.92)',
                    '0 1px 0 var(--printstream-shell-nav-top-line)',
                    'inset 0 1px 0 var(--printstream-shell-nav-inset-highlight)',
                    '0 0 0 1px var(--printstream-shell-nav-shadow-ring)'
                  ].join(', ')
                }}
              >
                <Box
                  component="button"
                  type="button"
                  aria-label="PrintStream home"
                  onClick={handleLogoClick}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    flexShrink: 0,
                    background: 'transparent',
                    border: 0,
                    cursor: onLogoClick ? 'pointer' : 'default',
                    pl: 0.75,
                    pr: 1,
                    py: 0,
                    '&:focus-visible': {
                      outline: '2px solid var(--printstream-section-nav-focus-ring)',
                      outlineOffset: 2
                    }
                  }}
                >
                  <Box
                    data-nav-logo
                    sx={{
                      width: 48,
                      height: 48,
                      overflow: 'hidden',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                  >
                    <Box
                      component="img"
                      src="/icon-512.png"
                      alt=""
                      sx={{
                        display: 'block',
                        // A ratio, not 52px: the box is deliberately narrower
                        // than the art (it crops the icon's own padding), and
                        // the density rules shrink the box -- a fixed width
                        // would crop harder at every step down.
                        width: '108%',
                        flexShrink: 0,
                        height: 'auto',
                        objectFit: 'contain'
                      }}
                    />
                  </Box>
                </Box>
                {tabs.map((tab) => (
                  <Tooltip
                    key={`desktop-${tab.value}`}
                    title={tabTooltip(tab, { labelHidden: desktopLabelsHidden })}
                    variant="soft"
                    size="sm"
                  >
                  <Tab
                    value={tab.value}
                    data-tab-value={tab.value}
                    sx={[...(tab.iconOnly ? [sectionTabSx, iconOnlyTabSx] : [sectionTabSx]), { position: 'relative' }]}
                    aria-label={tab.ariaLabel ?? tab.label}
                  >
                    {badgedTabs.has(tab.value) && <TabBadgeDot />}
                    {tab.iconOnly ? (
                      <Box
                        component="span"
                        sx={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          '& svg': { fontSize: { xs: 22, sm: 24 } }
                        }}
                      >
                        {tab.icon ?? tab.label}
                      </Box>
                    ) : (
                      <Stack
                        direction="row"
                        spacing={0.75}
                        alignItems="center"
                        // The icon-to-label gap is slack too, and tightens with
                        // the tab's padding rather than waiting for the type to
                        // shrink. See `navDensitySx`.
                        data-nav-tab-gap
                        sx={{ minWidth: 0 }}
                      >
                        {/* `minWidth: 0` above is what lets the label ellipsis
                            rather than force the tab wide: a flex item defaults
                            to min-content, so without it the text refuses to
                            shrink and pushes the row into a scroll. The icon
                            keeps its size -- a half-drawn icon reads as
                            breakage, a truncated word reads as truncated. */}
                        {(tab.icon ?? tab.mobileIcon) && (
                          <Box component="span" sx={{ display: 'inline-flex', flexShrink: 0, '& svg': { fontSize: 20 } }}>
                            {tab.icon ?? tab.mobileIcon}
                          </Box>
                        )}
                        <Box
                          component="span"
                          data-nav-label
                          sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
                        >
                          {tab.label}
                        </Box>
                      </Stack>
                    )}
                  </Tab>
                  </Tooltip>
                ))}
              </TabList>
              <Box id={appShellDesktopSecondaryNavHostId} />
            </Box>
          )}

          <Box sx={{ pt: { xs: 0, sm: 3 } }}>
            {(workspaceLabel || contentHeaderTrailing) ? (
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={{ xs: 0.75, sm: 1.5 }}
                alignItems={{ xs: 'flex-start', sm: 'center' }}
                sx={{ mb: 1 }}
              >
                {workspaceLabel ? (
                  <Typography
                    level="body-xs"
                    textColor="text.tertiary"
                    sx={{
                      textTransform: 'uppercase',
                      letterSpacing: '0.16em',
                      fontFamily: 'var(--joy-fontFamily-display)',
                      fontWeight: 'lg'
                    }}
                  >
                    {workspaceLabel}
                  </Typography>
                ) : null}
                {contentHeaderTrailing ? (
                  <Box sx={{ ml: { sm: 'auto' } }}>
                    {contentHeaderTrailing}
                  </Box>
                ) : null}
              </Stack>
            ) : null}
            {children}
          </Box>
        </Tabs>

        <Box component="footer" sx={{ textAlign: 'center', pb: 1, mt: 'auto', pt: 3 }}>
          {(identity || showsWorkspaceChooser || footerActions) ? (
            <Stack
              direction="row"
              spacing={{ xs: 1.25, sm: 2.5 }}
              alignItems="center"
              justifyContent="center"
              useFlexGap
              sx={{ flexWrap: 'wrap' }}
            >
              <Stack
                direction="row"
                spacing={{ xs: 1.25, sm: 2.5 }}
                alignItems="center"
                useFlexGap
                data-footer-group="workspace-identity"
                sx={{ flexWrap: 'nowrap', flexShrink: 0 }}
              >
                {showsWorkspaceChooser && (
                  <Button
                    variant="plain"
                    color="neutral"
                    size="sm"
                    startDecorator={workspaceChooserIcon}
                    aria-label={workspaceChooserButtonAriaLabel}
                    onClick={canOpenWorkspaceChooser ? () => onOpenWorkspaceChooser() : undefined}
                    loading={workspaceChooserPending}
                    disabled={workspaceChooserPending || !canOpenWorkspaceChooser}
                    sx={{ width: 'fit-content', maxWidth: '100%' }}
                  >
                    {workspaceChooserButtonLabel}
                  </Button>
                )}
                {identity && (onOpenAccount ? (
                  <Button
                    variant="plain"
                    color="neutral"
                    size="sm"
                    startDecorator={identityIcon}
                    onClick={onOpenAccount}
                    sx={{ width: 'fit-content', maxWidth: '100%' }}
                  >
                    {identity.primary}
                  </Button>
                ) : (
                  <Typography level="title-sm" startDecorator={identityIcon} sx={{ color: 'common.white' }}>
                    {identity.primary}
                  </Typography>
                ))}
              </Stack>
              {footerActions ? (
              <Stack
                direction="row"
                spacing={1}
                alignItems="center"
                justifyContent="center"
                useFlexGap
                data-footer-group="actions"
                sx={{ flexWrap: 'nowrap', flexShrink: 0 }}
              >
                {footerActions}
              </Stack>
              ) : null}
            </Stack>
          ) : null}
          {footerTrailing ? (
            <Box sx={{ mt: 1, display: 'flex', justifyContent: 'center' }}>
              {footerTrailing}
            </Box>
          ) : null}
        </Box>
      </Stack>
    </Box>
  )
}

/** Notification dot rendered on a shell tab whose value is badged (see `lib/shellBadges.ts`). */
function TabBadgeDot() {
  return (
    <Box
      component="span"
      aria-hidden="true"
      sx={{
        position: 'absolute',
        top: 6,
        right: 6,
        width: 8,
        height: 8,
        borderRadius: '50%',
        backgroundColor: 'primary.solidBg',
        pointerEvents: 'none'
      }}
    />
  )
}
