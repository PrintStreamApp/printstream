/**
 * The shell for public tools — pages that need no account, workspace, or plugin graph.
 *
 * Sits alongside `MarketingApp` as a third `Root` branch. It supplies what those pages do need and
 * the marketing branch does not: full-height layout for a 3D viewport, and the app's Joy theme +
 * chrome variables (App's `CssVarsProvider` lives inside App, which this branch never mounts).
 *
 * It does NOT create a React Query client — `main.tsx` already provides one above `Root`, so both
 * shells inherit it. The editor loads through queries even when its data is local, so that matters.
 *
 * Core, not private: the tools are capability the open-source and self-hosted builds serve too. The
 * cloud site adds its own landing copy and SEO around them separately.
 */
import { Suspense, lazy, useEffect } from 'react'
import Box from '@mui/joy/Box'
import CircularProgress from '@mui/joy/CircularProgress'
import CssBaseline from '@mui/joy/CssBaseline'
import Stack from '@mui/joy/Stack'
import Typography from '@mui/joy/Typography'
import { CssVarsProvider } from '@mui/joy/styles'
import { Route, Routes } from 'react-router-dom'
import { ViewportSettingsScopeProvider } from './lib/editorViewportSettings'
import { dismissSplashScreenImmediately } from './lib/splashScreen'
import { buildChromeCssVars } from './theme/buildTheme'
import { defaultChrome, theme } from './theme/theme'

// Three.js and the 3MF parsers are the heaviest chunk in the app; only fetch them once someone is
// actually on the tool's route.
const LocalProjectEditor = lazy(async () => ({
  default: (await import('./plugins/model-studio/LocalProjectEditor')).LocalProjectEditor
}))

const chromeVars = buildChromeCssVars(defaultChrome)

export default function PublicToolApp() {
  useEffect(() => {
    // The app-boot splash belongs to the app branch; a public tool renders against the page
    // background instead of waiting behind it.
    dismissSplashScreenImmediately()
    if (typeof document === 'undefined') return
    for (const [key, value] of Object.entries(chromeVars)) {
      document.documentElement.style.setProperty(key, value)
    }
  }, [])

  return (
    <CssVarsProvider theme={theme} defaultMode="dark">
      <CssBaseline />
      {/* Full height, not a scrolling page: the editor owns its own layout and its viewport needs
          a bounded parent to size against. */}
      {/* No workspace behind these pages, so viewport preferences are device-only: a "workspace
          default vs this device" pair has no default to point at. */}
      <ViewportSettingsScopeProvider deviceOnly>
        <Box sx={{ ...chromeVars, height: '100dvh', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <Suspense fallback={<ToolLoading />}>
            <Routes>
              <Route path="/3mf-editor" element={<LocalProjectEditor />} />
              {/* Any other path is the one-render hand-off to the app branch — render nothing rather
                  than redirecting, exactly as the marketing shell does. */}
              <Route path="*" element={null} />
            </Routes>
          </Suspense>
        </Box>
      </ViewportSettingsScopeProvider>
    </CssVarsProvider>
  )
}

function ToolLoading() {
  return (
    <Stack sx={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 1.5 }}>
      <CircularProgress size="sm" />
      <Typography level="body-sm" textColor="text.tertiary">Loading the editor…</Typography>
    </Stack>
  )
}
