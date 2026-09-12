/**
 * Light public/marketing layout frame: the centered, max-width content container + ambient
 * background that {@link AppShell} gives app pages, but WITHOUT the nav / header / account chrome.
 *
 * Used by `MarketingApp` so a cold-loaded marketing page keeps its whitespace and atmospheric
 * backdrop without pulling in the full AppShell. Mirrors AppShell's content wrapper: outer page
 * padding, two fixed ambient-gradient overlays (driven by the `--printstream-shell-ambient-*`
 * chrome vars), and an inner `maxWidth: 1200, mx: 'auto'` stack. The chrome CSS vars are supplied
 * by the caller (MarketingApp applies `buildChromeCssVars(defaultChrome)`).
 */
import type { ReactNode } from 'react'
import Box from '@mui/joy/Box'
import Stack from '@mui/joy/Stack'

const ambientOverlayBase = [
  'var(--printstream-shell-ambient-overlay-base)',
  'var(--printstream-shell-ambient-overlay-glow)'
].join(',')

export function PublicShell({
  children,
  footer,
  contentMaxWidth = 1200,
  fillViewport = false
}: {
  children: ReactNode
  footer?: ReactNode
  /** Maximum width of the main child stack. Public tools may use the full viewport. */
  contentMaxWidth?: number | string
  /** Keep children and footer inside one viewport, with the child stack taking remaining height. */
  fillViewport?: boolean
}) {
  // No BrandChromeContext provider: PublicShell has no header of its own, and the
  // context's default (false = "nothing brands the page above") is exactly right.
  return (
    <Box
      sx={{
        minHeight: fillViewport ? 0 : '100vh',
        height: fillViewport ? '100dvh' : undefined,
        overflow: fillViewport ? 'hidden' : undefined,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        px: { xs: 2, md: 4 },
        pt: {
          xs: 'calc(var(--app-top-inset, 0px) + 16px)',
          md: 'calc(var(--app-top-inset, 0px) + 10px)'
        },
        pb: { xs: 'calc(var(--app-safe-bottom, 0px) + 24px)', sm: 4, md: 5 }
      }}
    >
      <Box
        aria-hidden="true"
        sx={{ position: 'fixed', inset: 0, background: ambientOverlayBase, pointerEvents: 'none', zIndex: 0 }}
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
          maxWidth: contentMaxWidth,
          mx: 'auto',
          flex: fillViewport ? 1 : undefined,
          minHeight: fillViewport ? 0 : undefined
        }}
      >
        {children}
      </Stack>
      {/* Outside the content Stack so `mt: 'auto'` pins it to the viewport bottom on short pages
          (inside, the Stack's spacing margins would override the auto margin). */}
      {footer ? (
        <Box
          sx={{
            position: 'relative',
            zIndex: 1,
            width: '100%',
            maxWidth: 1200,
            mx: 'auto',
            mt: 'auto',
            pt: fillViewport ? 2 : 4,
            flexShrink: 0,
            display: 'flex',
            justifyContent: 'center'
          }}
        >
          {footer}
        </Box>
      ) : null}
    </Box>
  )
}
