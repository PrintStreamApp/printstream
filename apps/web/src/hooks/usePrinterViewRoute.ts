/**
 * Owns the printer dashboard's saved-view address and default resolution.
 *
 * A pinned address survives catalogue loading, then a missing view redirects to the bare
 * dashboard address. A missing device override falls back to the workspace default. Switching
 * views clears a staged toolbar draft before navigation so it cannot flash under the next view.
 */
import { useCallback, useEffect, useMemo } from 'react'
import type { PrinterView } from '@printstream/shared'
import { resolveEffectiveDefaultPrinterViewId } from '../lib/printerViewDefaults'
import {
  OVERVIEW_VIEW_ROUTE_ID,
  printerViewPath,
  resolveActivePrinterViewId
} from '../lib/printerViewRoutes'
import { OVERVIEW_VIEW_OPTION_VALUE } from '../lib/printerViewConstants'

interface PrinterViewRouteOptions {
  views: ReadonlyArray<PrinterView>
  viewsLoaded: boolean
  routeViewId: string | undefined
  defaultViewOverride: string | null
  setDefaultViewOverride: (value: string | null) => void
  sharedDefaultViewId: string | null
  workspacePath: (path: string) => string
  navigate: (path: string, options?: { replace?: boolean }) => void
}

/** Resolve the active view and return a draft-safe navigation action. */
export function usePrinterViewRoute({
  views,
  viewsLoaded,
  routeViewId,
  defaultViewOverride,
  setDefaultViewOverride,
  sharedDefaultViewId,
  workspacePath,
  navigate
}: PrinterViewRouteOptions) {
  const effectiveDefaultViewId = resolveEffectiveDefaultPrinterViewId({
    override: defaultViewOverride,
    sharedDefaultViewId,
    views
  })
  const activeViewId = resolveActivePrinterViewId({
    routeViewId,
    storedDefaultViewId: effectiveDefaultViewId,
    views
  })
  const activeView = useMemo(
    () => views.find((view) => view.id === activeViewId) ?? null,
    [activeViewId, views]
  )

  useEffect(() => {
    if (!viewsLoaded) return
    // A device override naming a deleted view returns to the workspace default. The reserved
    // Overview sentinel is a valid choice even though it has no row in the saved-view list.
    if (defaultViewOverride
      && defaultViewOverride !== OVERVIEW_VIEW_ROUTE_ID
      && !views.some((view) => view.id === defaultViewOverride)) {
      setDefaultViewOverride(null)
    }
    // A pinned, deleted view is replaced with the bare address, which resolves the default.
    if (routeViewId
      && routeViewId !== OVERVIEW_VIEW_ROUTE_ID
      && !views.some((view) => view.id === routeViewId)) {
      navigate(workspacePath('/printers'), { replace: true })
    }
  }, [defaultViewOverride, navigate, routeViewId, setDefaultViewOverride,
    views, viewsLoaded, workspacePath])

  /** Ignore Joy Select's transient null while an active view option has not mounted yet. */
  const navigateToSelectedView = useCallback((value: string | null, clearDraft: () => void) => {
    if (value == null) return
    clearDraft()
    const id = value === OVERVIEW_VIEW_OPTION_VALUE ? OVERVIEW_VIEW_ROUTE_ID : value
    navigate(workspacePath(printerViewPath(id)))
  }, [navigate, workspacePath])

  return { effectiveDefaultViewId, activeViewId, activeView, navigateToSelectedView }
}
