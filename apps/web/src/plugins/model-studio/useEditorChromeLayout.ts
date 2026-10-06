/**
 * Owns the editor's device layout preferences and measured plate-strip axis.
 * The chrome height itself is measured by EditorView for floating tool panels;
 * this hook owns the body measurement that decides whether plates run beside
 * or below the viewport.
 */
import { useEffect, useState } from 'react'
import { useMobileViewport } from '../../components/useMobileViewport'
import { useDialogPresentationState } from '../../hooks/useDialogPresentationState'
import { useLocalStorageState } from '../../hooks/useLocalStorageState'
import { useEffectiveSidebarSide } from '../../lib/editorViewportSettings'
import { choosePlateStripOrientation, EDITOR_GRID_GAP_PX } from './lib/editorChromeLayout'
import { useSidebarResize } from './lib/useSidebarResize'

interface EditorChromeLayoutOptions {
  hosting: 'dialog' | 'page' | undefined
}

/** Keep layout responsive to the measured body without re-rendering for subpixel drag noise. */
export function useEditorChromeLayout({ hosting }: EditorChromeLayoutOptions) {
  // The workspace default and this device's sidebar-side override are edited in settings.
  const sidebarSide = useEffectiveSidebarSide()
  const { sidebarWidth, resizeHandleProps } = useSidebarResize(sidebarSide)
  const isMobile = useMobileViewport()
  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorageState<boolean>(
    'bambu.editor.sidebarCollapsed',
    false,
    (raw) => (raw === 'true' ? true : raw === 'false' ? false : null),
    String
  )
  // The editor is maximized by nature. A page host also locks it to fullscreen.
  const { presentation, fullScreen, setFullScreen } = useDialogPresentationState({
    maximizedStorageKey: null,
    base: 'maximized',
    locked: hosting === 'page' ? 'fullscreen' : undefined
  })
  const showEditorChrome = !fullScreen
  const showSidebar = showEditorChrome && !sidebarCollapsed

  // The strip's best axis depends on real available space, including sidebar width.
  const [bodyNode, setBodyNode] = useState<HTMLDivElement | null>(null)
  const [bodySize, setBodySize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    if (!bodyNode) return
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect
      if (!box) return
      // Sidebar dragging fires on every frame; subpixel changes cannot flip the strip axis.
      setBodySize((current) => (
        Math.abs(current.width - box.width) < 1 && Math.abs(current.height - box.height) < 1
          ? current
          : { width: box.width, height: box.height }
      ))
    })
    observer.observe(bodyNode)
    return () => observer.disconnect()
  }, [bodyNode])
  const plateStripOrientation = choosePlateStripOrientation({
    bodyWidth: bodySize.width,
    bodyHeight: bodySize.height,
    sidebarWidth: showSidebar ? sidebarWidth : 0,
    gap: EDITOR_GRID_GAP_PX
  })

  // Phones swap between the same viewport and sidebar content used on desktop.
  const [mobileView, setMobileView] = useState<'view' | 'settings'>('view')
  return {
    sidebarSide,
    sidebarWidth,
    resizeHandleProps,
    isMobile,
    sidebarCollapsed,
    setSidebarCollapsed,
    presentation,
    fullScreen,
    setFullScreen,
    showEditorChrome,
    showSidebar,
    setBodyNode,
    plateStripOrientation,
    mobileView,
    setMobileView
  }
}
