/** Persistent menu owner; load the import UI only after a user chooses a source. */
import { lazy } from 'react'
import { LazyDialogBoundary } from '../../components/LazyDialogBoundary'
import { closeLibraryImport, useLibraryImportLaunch } from './importLaunchStore'

const LibraryImportSession = lazy(async () => {
  const module = await import('./LibraryImportSession')
  return { default: module.LibraryImportSession }
})

export function LibraryImportOverlayHost() {
  const launch = useLibraryImportLaunch()
  return launch ? (
    <LazyDialogBoundary label="model import" onClose={closeLibraryImport}>
      <LibraryImportSession launch={launch} />
    </LazyDialogBoundary>
  ) : null
}
