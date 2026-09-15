/**
 * Lazy host for the heavy Three.js {@link PreviewView}.
 *
 * Registered for the `library.overlays` slot instead of importing PreviewView
 * directly, so three.js (and the shared editor/preview Three helpers) stay out of
 * the main bundle and load only when a preview is actually opened. Mirrors how
 * EditorView is lazy-loaded from SlicingEditorAction/LibraryCreateAction.
 */
import { lazy } from 'react'
import { LazyDialogBoundary } from '../../components/LazyDialogBoundary'

const PreviewView = lazy(() => import('./PreviewView').then((module) => ({ default: module.PreviewView })))

export function PreviewOverlay(props: Record<string, unknown>) {
  // Only mount (and thus fetch the chunk) once a preview has been requested.
  if (typeof props.previewFileId !== 'string' || !props.previewFileId) return null
  // The same handler the preview itself closes through, so a failed chunk clears the host's
  // `previewFileId` and the thumbnail can be clicked again after a reload.
  const onClose = typeof props.onPreviewClose === 'function' ? props.onPreviewClose as () => void : () => undefined
  return (
    <LazyDialogBoundary variant="preview" label="the 3D preview" onClose={onClose}>
      <PreviewView {...props} />
    </LazyDialogBoundary>
  )
}
