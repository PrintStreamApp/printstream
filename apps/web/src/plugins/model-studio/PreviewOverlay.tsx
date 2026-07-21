/**
 * Lazy host for the heavy Three.js {@link PreviewView}.
 *
 * Registered for the `library.overlays` slot instead of importing PreviewView
 * directly, so three.js (and the shared editor/preview Three helpers) stay out of
 * the main bundle and load only when a preview is actually opened. Mirrors how
 * EditorView is lazy-loaded from SlicingEditorAction/LibraryCreateAction.
 */
import { Suspense, lazy } from 'react'
import { LazyDialogFallback } from '../../components/LazyDialogFallback'

const PreviewView = lazy(() => import('./PreviewView').then((module) => ({ default: module.PreviewView })))

export function PreviewOverlay(props: Record<string, unknown>) {
  // Only mount (and thus fetch the chunk) once a preview has been requested.
  if (typeof props.previewFileId !== 'string' || !props.previewFileId) return null
  return (
    <Suspense fallback={<LazyDialogFallback variant="fullscreen" label="Opening the 3D preview…" />}>
      <PreviewView {...props} />
    </Suspense>
  )
}
