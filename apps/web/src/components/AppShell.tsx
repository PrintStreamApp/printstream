/**
 * Top-level page shell.
 *
 * Mirrors the `game-is-up` dashboard aesthetic: ambient gradient
 * background, a bottom-docked mobile primary nav, a sticky desktop tab
 * row, and a max-width content column.
 */
import React, { type MouseEvent, type ReactNode } from 'react'
import { Box, Button, Stack, Tab, TabList, Tabs, Typography } from '@mui/joy'
import type { ShellIdentity } from '../lib/authUi'
import { HorizontalOverflowScroller } from './HorizontalOverflowScroller'
import { appShellDesktopSecondaryNavHostId } from './AppShell.constants'
import { sectionTabSx } from '../theme/theme'

const ambientOverlayBase = [
  'var(--printstream-shell-ambient-overlay-base)',
  'var(--printstream-shell-ambient-overlay-glow)'
].join(',')

export interface ShellTab<TValue extends string = string> {
  value: TValue
  label: string
  ariaLabel?: string
  icon?: ReactNode
  mobileIcon?: ReactNode
  iconOnly?: boolean
}

interface AppShellProps<TValue extends string> {
  tabs: ReadonlyArray<ShellTab<TValue>>
  activeTab: TValue
  currentPath: string
  onTabChange: (tab: TValue) => void
  onOpenAccount?: () => void
  workspaceLabel?: string
  workspaceChooserLabel?: string
  showNavigationFrame?: boolean
  unconstrainedWidth?: boolean
  identity?: ShellIdentity | null
  workspaceChooserAvailable?: boolean
  onOpenWorkspaceChooser?: () => void
  workspaceChooserPending?: boolean
  showMobileNavLogo?: boolean
  onLogoClick?: () => void
  contentHeaderTrailing?: ReactNode
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
  showNavigationFrame = false,
  unconstrainedWidth = false,
  identity = null,
  workspaceChooserAvailable = false,
  onOpenWorkspaceChooser,
  workspaceChooserPending = false,
  showMobileNavLogo = true,
  onLogoClick,
  contentHeaderTrailing,
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

  const hasTabs = tabs.length > 0
  const showsNavigationFrame = showNavigationFrame || hasTabs
  const canOpenWorkspaceChooser = workspaceChooserAvailable && typeof onOpenWorkspaceChooser === 'function'
  const showsWorkspaceChooser = workspaceChooserAvailable
  const workspaceChooserButtonLabel = workspaceChooserLabel ?? 'Choose workspace'
  const workspaceChooserButtonAriaLabel = workspaceChooserLabel
    ? `Choose workspace. Current workspace: ${workspaceChooserLabel}`
    : 'Choose workspace'
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
        px: { xs: 2, md: 4 },
        pt: {
          xs: 'calc(var(--app-top-inset, 0px) + 16px)',
          md: 'calc(var(--app-top-inset, 0px) + 10px)'
        },
        pb: {
          xs: 'calc(var(--app-safe-bottom, 0px) + 78px)',
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
        sx={{ position: 'relative', zIndex: 1, width: '100%', maxWidth: unconstrainedWidth ? 'none' : 1200, mx: 'auto' }}
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
                  {showMobileNavLogo ? (
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
                        pl: 0.25,
                        pr: 0.375,
                        py: 0,
                        '&:focus-visible': {
                          outline: '2px solid var(--printstream-section-nav-focus-ring)',
                          outlineOffset: 2
                        }
                      }}
                    >
                      <Box
                        component="img"
                        src="/icon-512.png"
                        alt=""
                        sx={{
                          display: 'block',
                          width: 48,
                          height: 'auto',
                          objectFit: 'contain'
                        }}
                      />
                    </Box>
                  ) : null}
                  {tabs.map((tab) => (
                    <Tab
                      key={tab.value}
                      value={tab.value}
                      data-tab-value={tab.value}
                      sx={tab.iconOnly || tab.mobileIcon ? [primaryTabSx, iconOnlyTabSx] : primaryTabSx}
                      aria-label={tab.ariaLabel ?? tab.label}
                      title={tab.ariaLabel ?? tab.label}
                    >
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
                            {tab.icon && (
                              <Box component="span" sx={{ display: 'inline-flex', '& svg': { fontSize: 20 } }}>
                                {tab.icon}
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
                disableUnderline
                onClickCapture={handleTabListClickCapture}
                sx={{
                  mt: 0.5,
                  mb: 0,
                  mx: 0,
                  py: 1,
                  px: 1,
                  gap: 1,
                  position: 'relative',
                  borderRadius: 'md',
                  flexWrap: 'nowrap',
                  overflowX: 'visible',
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
                        width: 52,
                        height: 'auto',
                        objectFit: 'contain'
                      }}
                    />
                  </Box>
                </Box>
                {tabs.map((tab) => (
                  <Tab
                    key={`desktop-${tab.value}`}
                    value={tab.value}
                    data-tab-value={tab.value}
                    sx={tab.iconOnly ? [sectionTabSx, iconOnlyTabSx] : sectionTabSx}
                    aria-label={tab.ariaLabel ?? tab.label}
                    title={tab.ariaLabel ?? tab.label}
                  >
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

        <Box component="footer" sx={{ textAlign: 'center', pb: 1 }}>
          <Stack
            direction="row"
            spacing={{ xs: 1.25, sm: 2.5 }}
            alignItems="center"
            justifyContent="center"
            useFlexGap
            sx={{ flexWrap: 'wrap' }}
          >
            {identity && (
              <Stack
                direction="row"
                spacing={{ xs: 0.5, sm: 0.75 }}
                alignItems="center"
                sx={{ px: { xs: 0.25, sm: 0.5 } }}
              >
                <Typography level="body-xs" sx={{ color: 'neutral.500', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  Signed in as
                </Typography>
                {onOpenAccount ? (
                  <Button
                    variant="plain"
                    color="neutral"
                    size="sm"
                    onClick={onOpenAccount}
                    sx={{ width: 'fit-content', maxWidth: '100%', px: 0.5 }}
                  >
                    {identity.primary}
                  </Button>
                ) : (
                  <Typography level="title-sm" sx={{ color: 'common.white' }}>
                    {identity.primary}
                  </Typography>
                )}
              </Stack>
            )}
            {showsWorkspaceChooser && (
              <Stack
                direction="row"
                spacing={{ xs: 0.5, sm: 1 }}
                alignItems="center"
                sx={{ width: 'fit-content', maxWidth: '100%' }}
              >
                <Typography level="body-xs" sx={{ color: 'neutral.500', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  Workspace
                </Typography>
                <Button
                  variant="plain"
                  color="neutral"
                  size="sm"
                  aria-label={workspaceChooserButtonAriaLabel}
                  onClick={canOpenWorkspaceChooser ? () => onOpenWorkspaceChooser() : undefined}
                  loading={workspaceChooserPending}
                  disabled={workspaceChooserPending || !canOpenWorkspaceChooser}
                  sx={{ width: 'fit-content', maxWidth: '100%' }}
                >
                  {workspaceChooserButtonLabel}
                </Button>
              </Stack>
            )}
          </Stack>
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
