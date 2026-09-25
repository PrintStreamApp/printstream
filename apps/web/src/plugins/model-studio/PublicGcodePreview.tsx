/** Lazy host for previewing a public slice that remains entirely in the browser. */
import { lazy } from 'react'
import { LazyDialogBoundary } from '../../components/LazyDialogBoundary'
import type { InMemoryGcodePreviewSource } from './lib/inMemoryGcodePreview'

const PreviewView = lazy(() => import('./PreviewView').then((module) => ({ default: module.PreviewView })))

export function PublicGcodePreview({ source, plateIndex, onClose }: {
  source: InMemoryGcodePreviewSource
  plateIndex?: number
  onClose: () => void
}) {
  return (
    <LazyDialogBoundary variant="preview" label="the G-code preview" onClose={onClose}>
      <PreviewView inMemoryGcode={source} previewPlateIndex={plateIndex} onPreviewClose={onClose} />
    </LazyDialogBoundary>
  )
}
