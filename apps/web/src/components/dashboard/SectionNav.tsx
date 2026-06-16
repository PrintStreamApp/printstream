import { Portal } from '@mui/base/Portal'
import { Box } from '@mui/joy'
import React from 'react'
import { useEffect, useState } from 'react'
import { appShellDesktopSecondaryNavHostId } from '../AppShell.constants'
import { HorizontalOverflowScroller } from '../HorizontalOverflowScroller'
import { mobileSectionNavDockBottom } from './SectionNav.constants'

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

export type SectionNavEntry = {
  id: string
  label: string
  mobileLabel?: string
  desktopLabel?: string
  ariaLabel?: string
  count?: number
}

const sectionNavPalette = {
  border: 'var(--printstream-section-nav-border)',
  background: 'var(--printstream-section-nav-background)',
  shadowRing: 'var(--printstream-section-nav-shadow-ring)',
  text: 'var(--printstream-section-nav-text)',
  textHover: 'var(--printstream-section-nav-text-hover)',
  focusRing: 'var(--printstream-section-nav-focus-ring)',
  count: 'var(--printstream-section-nav-count)',
  separator: 'var(--printstream-section-nav-separator)'
} as const

export function SectionNav({
  sections,
  mb = 3,
  'aria-label': ariaLabel = 'Page sections'
}: {
  sections: SectionNavEntry[]
  mb?: number
  'aria-label'?: string
}) {
  const [desktopHost, setDesktopHost] = useState<HTMLElement | null>(null)

  useEffect(() => {
    setDesktopHost(document.getElementById(appShellDesktopSecondaryNavHostId))
  }, [])

  const desktopNav = (
    <Box
      component="nav"
      aria-label={ariaLabel}
      sx={{
        display: { xs: 'none', sm: 'flex' },
        mb,
        justifyContent: 'center'
      }}
    >
      <Box
        sx={{
          display: 'inline-flex',
          width: 'fit-content',
          maxWidth: 'calc(100% - 8px)',
          minWidth: 0,
          flexDirection: 'row',
          alignItems: 'center',
          flexWrap: 'nowrap',
          justifyContent: 'center',
          overflowX: 'auto',
          overflowY: 'hidden',
          scrollbarWidth: 'none',
          '&::-webkit-scrollbar': {
            display: 'none'
          },
          gap: 0,
          px: 2.5,
          py: 1,
          borderTop: 'none',
          borderLeft: `1px solid ${sectionNavPalette.border}`,
          borderRight: `1px solid ${sectionNavPalette.border}`,
          borderBottom: `1px solid ${sectionNavPalette.border}`,
          borderTopLeftRadius: 0,
          borderTopRightRadius: 0,
          borderBottomLeftRadius: 'var(--joy-radius-xl, 16px)',
          borderBottomRightRadius: 'var(--joy-radius-xl, 16px)',
          backgroundColor: sectionNavPalette.background,
          backdropFilter: 'blur(12px) saturate(1.06)',
          WebkitBackdropFilter: 'blur(12px) saturate(1.06)',
          boxShadow: [
            '0 14px 26px -18px rgba(0, 0, 0, 0.72)',
            'inset 0 -1px 0 rgba(255, 255, 255, 0.05)',
            `0 0 0 1px ${sectionNavPalette.shadowRing}`
          ].join(', ')
        }}
      >
        {sections.map(({ id, label, desktopLabel, ariaLabel, count }, i) => (
          <Box key={id} sx={{ display: 'flex', alignItems: 'center' }}>
            {i > 0 && (
              <Box
                component="span"
                aria-hidden
                sx={{ mx: 1.5, color: sectionNavPalette.separator, userSelect: 'none', fontSize: 'sm' }}
              >
                ·
              </Box>
            )}
            <Box
              component="button"
              aria-label={ariaLabel ?? label}
              onClick={() => scrollToSection(id)}
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 0.75,
                border: 'none',
                background: 'none',
                padding: 0,
                color: sectionNavPalette.text,
                fontSize: 'var(--joy-fontSize-md)',
                fontWeight: 'var(--joy-fontWeight-md)',
                fontFamily: 'var(--joy-fontFamily-body)',
                whiteSpace: 'nowrap',
                cursor: 'pointer',
                transition: 'color 150ms ease',
                '&:hover': { color: sectionNavPalette.textHover },
                '&:focus-visible': {
                  outline: `2px solid ${sectionNavPalette.focusRing}`,
                  outlineOffset: 3,
                  borderRadius: 2
                }
              }}
            >
              <Box component="span">{desktopLabel ?? label}</Box>
              {count != null && count > 0 && (
                <Box
                  component="span"
                  sx={{
                    color: sectionNavPalette.count,
                    fontSize: 'var(--joy-fontSize-sm)',
                    fontWeight: 'var(--joy-fontWeight-md)'
                  }}
                >
                    {count}
                </Box>
              )}
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  )

  return (
    <>
      <Box
        component="nav"
        aria-label={ariaLabel}
        sx={{
          display: { xs: 'flex', sm: 'none' },
          justifyContent: 'center',
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: mobileSectionNavDockBottom,
          zIndex: 19,
          pointerEvents: 'none'
        }}
      >
        <Box
          sx={{
            width: 'fit-content',
            maxWidth: 'calc(100% - 20px)',
            minWidth: 0,
            pointerEvents: 'auto'
          }}
        >
          <HorizontalOverflowScroller
            sx={{
              border: `1px solid ${sectionNavPalette.border}`,
              borderRadius: 'var(--joy-radius-xl, 16px)',
              backgroundColor: sectionNavPalette.background,
              backdropFilter: 'blur(12px) saturate(1.06)',
              WebkitBackdropFilter: 'blur(12px) saturate(1.06)',
              boxShadow: [
                '0 14px 26px -18px rgba(0, 0, 0, 0.72)',
                'inset 0 -1px 0 rgba(255, 255, 255, 0.05)',
                `0 0 0 1px ${sectionNavPalette.shadowRing}`
              ].join(', ')
            }}
            scrollerSx={{
              px: 1.5,
              py: 0.55
            }}
            fadeColor={sectionNavPalette.background}
          >
            <Box
              sx={{
                display: 'inline-flex',
                width: 'max-content',
                alignItems: 'center',
                justifyContent: 'flex-start',
                gap: 1.25
              }}
            >
              {sections.map(({ id, label, mobileLabel, ariaLabel, count }) => (
                <Box key={`mobile-${id}`} sx={{ minWidth: 0, flex: '0 0 auto' }}>
                  <Box
                    component="button"
                    aria-label={ariaLabel ?? label}
                    onClick={() => scrollToSection(id)}
                    sx={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 0.5,
                      border: 'none',
                      background: 'none',
                      padding: 0,
                      color: sectionNavPalette.text,
                      fontSize: 'var(--joy-fontSize-sm)',
                      fontWeight: 'var(--joy-fontWeight-md)',
                      fontFamily: 'var(--joy-fontFamily-body)',
                      whiteSpace: 'nowrap',
                      cursor: 'pointer',
                      transition: 'color 150ms ease',
                      '&:hover': { color: sectionNavPalette.textHover },
                      '&:focus-visible': {
                        outline: `2px solid ${sectionNavPalette.focusRing}`,
                        outlineOffset: 3,
                        borderRadius: 2
                      }
                    }}
                  >
                    <Box component="span">{mobileLabel ?? label}</Box>
                    {count != null && count > 0 && (
                      <Box
                        component="span"
                        sx={{
                          color: sectionNavPalette.count,
                          fontSize: 'var(--joy-fontSize-xs)',
                          fontWeight: 'var(--joy-fontWeight-md)'
                        }}
                      >
                        {count}
                      </Box>
                    )}
                  </Box>
                </Box>
              ))}
            </Box>
          </HorizontalOverflowScroller>
        </Box>
      </Box>
      {desktopHost && <Portal container={desktopHost}>{desktopNav}</Portal>}
    </>
  )
}
