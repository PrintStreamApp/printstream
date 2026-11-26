/**
 * Rendering surface for remote imports. State, queries, and native orchestration
 * remain in RemoteImportsView's controller so this component owns layout only.
 */
import { Alert, Button, Card, Stack, Typography } from '@mui/joy'
import { useState } from 'react'
import { RemoteImportDestinationDialog } from './RemoteImportDestinationDialog'
import { NestedViewHeader } from '../../components/NestedViewHeader'
import { NoConnectedBridgesEmptyState } from '../../components/NoConnectedBridgesEmptyState'
import { PrintModal } from '../../components/library/PrintModal'
import { FromUrlImportDialog } from './FromUrlImportDialog'
import { ImportSourceActions } from './ImportSourceActions'
import type { RemoteImportsController } from './useRemoteImportsController'

const MAKERWORLD_BROWSE_URL = 'https://makerworld.com/en/3d-models'
const PRINTABLES_BROWSE_URL = 'https://www.printables.com/model'

export function RemoteImportsContent({ controller }: { controller: RemoteImportsController }) {
  const {
    goToLibrary,
    showNoBridgesPlaceholder,
    canBrowseNativeMakerWorld,
    canBrowseNativePrintables,
    nativeImportMutation,
    startNativeImport,
    trimmedUrl,
    displayedErrorMessage,
    importedFile,
    importedDestinationLabel,
    printWasRequested,
    importedPrintable,
    goToImportedFolder,
    destinationOpen,
    printTarget,
    printersQuery,
    closePrintModal
  } = controller
  const [fromUrlOpen, setFromUrlOpen] = useState(() => Boolean(trimmedUrl))

  return (
    <Stack spacing={2.5}>
      <NestedViewHeader
        crumbs={[{ label: 'Library', onClick: goToLibrary }, { label: 'Import from web' }]}
        description="Choose a model site, or paste a supported model or file URL."
      />

      {showNoBridgesPlaceholder ? (
        <NoConnectedBridgesEmptyState
          title="Connect a bridge to import files"
          description="Imported files are stored on a bridge, so connect one in Settings before importing from a URL."
          managedTitle="Your library is starting up"
          managedDescription="Importing will be available once PrintStream's services are running."
        />
      ) : (
        <Card variant="outlined">
          <Stack spacing={2}>
            <ImportSourceActions
              canBrowseMakerWorld={canBrowseNativeMakerWorld}
              canBrowsePrintables={canBrowseNativePrintables}
              pendingProvider={nativeImportMutation.isPending
                ? nativeImportMutation.variables?.provider ?? null
                : null}
              disabled={nativeImportMutation.isPending}
              fromUrlSelected={fromUrlOpen}
              onBrowse={(provider) => {
                setFromUrlOpen(false)
                startNativeImport({
                  provider,
                  startUrl: provider === 'makerworld' ? MAKERWORLD_BROWSE_URL : PRINTABLES_BROWSE_URL,
                  resume: true,
                  openPrintSetup: false
                })
              }}
              onFromUrl={() => setFromUrlOpen(true)}
            />

            {!fromUrlOpen && displayedErrorMessage && (
              <Alert color="danger" variant="soft">
                <Typography level="body-sm">{displayedErrorMessage}</Typography>
              </Alert>
            )}

            {importedFile && (
              <Alert color="success" variant="soft">
                <Stack spacing={0.75}>
                  <Typography level="title-sm">Imported {importedFile.name}</Typography>
                  <Typography level="body-sm">{`The file is now in ${importedDestinationLabel}.`}</Typography>
                  {printWasRequested && !importedPrintable && (
                    <Typography level="body-sm">
                      It is not sliced yet, so it cannot go straight to a printer. Open it in the library to slice it first.
                    </Typography>
                  )}
                  <Button size="sm" onClick={goToImportedFolder} sx={{ alignSelf: 'flex-start' }}>
                    {printWasRequested && !importedPrintable ? 'Open in library to slice' : 'Open Library'}
                  </Button>
                </Stack>
              </Alert>
            )}
          </Stack>
        </Card>
      )}

      <FromUrlImportDialog
        controller={controller}
        open={fromUrlOpen && !showNoBridgesPlaceholder && !destinationOpen}
        onClose={() => setFromUrlOpen(false)}
      />

      <RemoteImportDestinationDialog controller={controller} />

      {printTarget && printersQuery.data && (
        <PrintModal
          file={printTarget}
          printers={printersQuery.data.printers}
          onClose={closePrintModal}
        />
      )}
    </Stack>
  )
}
