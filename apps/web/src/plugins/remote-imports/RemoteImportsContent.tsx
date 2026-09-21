/**
 * Rendering surface for remote imports. State, queries, and native orchestration
 * remain in RemoteImportsView's controller so this component owns layout only.
 */
import FolderOpenRoundedIcon from '@mui/icons-material/FolderOpenRounded'
import { Alert, Box, Button, Card, FormControl, FormHelperText, FormLabel, Option, Select, Stack, Typography } from '@mui/joy'
import { useState } from 'react'
import { LibraryDestinationDialog } from '../../components/LibraryDestinationDialog'
import { NestedViewHeader } from '../../components/NestedViewHeader'
import { NoConnectedBridgesEmptyState } from '../../components/NoConnectedBridgesEmptyState'
import { PrintModal } from '../../components/library/PrintModal'
import { FromUrlImportDialog } from './FromUrlImportDialog'
import { ImportSourceActions } from './ImportSourceActions'
import type { RemoteImportsController } from './RemoteImportsView'

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
    bridges,
    selectedBridgeId,
    setBridgeId,
    setPickedFolderId,
    foldersQuery,
    destinationLabel,
    setDestinationOpen,
    destination,
    libraryFolderName,
    displayedErrorMessage,
    importedFile,
    importedDestinationLabel,
    printWasRequested,
    importedPrintable,
    goToImportedFolder,
    destinationOpen,
    pickedFolderId,
    destinationFolders,
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
                  openPrintSetup: false
                })
              }}
              onFromUrl={() => setFromUrlOpen(true)}
            />

            <FormControl>
              <FormLabel>Save to</FormLabel>
              {bridges.length > 1 && (
                <Select
                  value={selectedBridgeId || null}
                  onChange={(_event, value) => {
                    if (!value) return
                    setBridgeId(value)
                    setPickedFolderId(null)
                  }}
                  sx={{ mb: 1 }}
                >
                  {bridges.map((bridge) => (
                    <Option key={bridge.id} value={bridge.id}>{bridge.name}</Option>
                  ))}
                </Select>
              )}
              <Button
                type="button"
                variant="outlined"
                color="neutral"
                startDecorator={<FolderOpenRoundedIcon />}
                disabled={!selectedBridgeId || foldersQuery.isPending}
                onClick={() => setDestinationOpen(true)}
                sx={{ justifyContent: 'flex-start', fontWeight: 'md' }}
              >
                <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {destinationLabel}
                </Box>
              </Button>
              <FormHelperText>
                {destination.folderId
                  ? 'The file lands in this library folder.'
                  : `${libraryFolderName} is created automatically the first time something is imported.`}
              </FormHelperText>
            </FormControl>

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
        open={fromUrlOpen && !showNoBridgesPlaceholder}
        onClose={() => setFromUrlOpen(false)}
      />

      {destinationOpen && (
        <LibraryDestinationDialog
          title="Choose where to save"
          description="Pick the library folder this import should land in."
          initialFolderId={pickedFolderId}
          folders={destinationFolders}
          bridgeId={destination.bridgeId || null}
          bridgeName={bridges.find((bridge) => bridge.id === destination.bridgeId)?.name ?? null}
          showRoot={false}
          submitting={false}
          error={null}
          confirmActionLabel={({ outputFolderId, rootDestinationLabel }) => outputFolderId ? 'Save here' : `Save to ${rootDestinationLabel}`}
          onClose={() => setDestinationOpen(false)}
          onSubmit={({ outputFolderId }) => {
            setPickedFolderId(outputFolderId)
            setDestinationOpen(false)
          }}
        />
      )}

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
