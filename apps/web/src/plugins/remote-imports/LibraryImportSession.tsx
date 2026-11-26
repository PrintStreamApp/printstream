/** Persistent owner of imports launched from menus, which unmount as soon as clicked. */
import { useEffect, useRef } from 'react'
import { PrintModal } from '../../components/library/PrintModal'
import { FormDialog } from '../../components/FormDialog'
import { NoConnectedBridgesEmptyState } from '../../components/NoConnectedBridgesEmptyState'
import { FromUrlImportDialog } from './FromUrlImportDialog'
import { ModelProviderRequiredDialog } from './ModelProviderRequiredDialog'
import { RemoteImportDestinationDialog } from './RemoteImportDestinationDialog'
import { useRemoteImportsController } from './useRemoteImportsController'
import { closeLibraryImport, type ImportLaunch } from './importLaunchStore'

export function LibraryImportSession({ launch }: { launch: ImportLaunch }) {
  const controller = useRemoteImportsController(launch)
  const started = useRef(false)
  const { startNativeImport, nativeImportMutation, importMutation, goToImportedFolder } = controller
  const supported = launch.source === 'makerworld'
    ? controller.canBrowseNativeMakerWorld
    : controller.canBrowseNativePrintables

  useEffect(() => {
    if (launch.source === 'url' || !supported || started.current) return
    started.current = true
    startNativeImport({
      provider: launch.source,
      startUrl: launch.source === 'makerworld' ? 'https://makerworld.com/en/3d-models' : 'https://www.printables.com/model',
      resume: true,
      openPrintSetup: false
    })
  }, [launch.source, startNativeImport, supported])

  useEffect(() => {
    if (!nativeImportMutation.isSuccess && !importMutation.data) return
    if (controller.printTarget) return
    if (controller.importedFile && !controller.printWasRequested && !nativeImportMutation.data?.openedInEditor) {
      goToImportedFolder()
    }
    closeLibraryImport()
  }, [controller.importedFile, controller.printTarget, controller.printWasRequested, goToImportedFolder, importMutation.data, nativeImportMutation.data, nativeImportMutation.isSuccess])

  if (controller.showNoBridgesPlaceholder) {
    return (
      <FormDialog title="Connect a bridge to import files" description={null} submitLabel={null} onClose={closeLibraryImport} onSubmit={() => {}}>
        <NoConnectedBridgesEmptyState title="Connect a bridge" description="Imported files need library storage." />
      </FormDialog>
    )
  }
  if (launch.source !== 'url' && !supported && !controller.nativeProvidersLoading && controller.selectedBridgeId) {
    return <ModelProviderRequiredDialog provider={launch.source} onClose={closeLibraryImport} />
  }
  if (nativeImportMutation.isError || controller.browseError) {
    return (
      <FormDialog title="Could not import model" description={controller.browseError ?? nativeImportMutation.error?.message} submitLabel={null} onClose={closeLibraryImport} onSubmit={() => {}}>{null}</FormDialog>
    )
  }
  return (
    <>
      <FromUrlImportDialog controller={controller} open={launch.source === 'url' && !controller.destinationOpen} onClose={closeLibraryImport} />
      <RemoteImportDestinationDialog controller={controller} />
      {controller.printTarget && controller.printersQuery.data && (
        <PrintModal file={controller.printTarget} printers={controller.printersQuery.data.printers} onClose={controller.closePrintModal} />
      )}
    </>
  )
}
