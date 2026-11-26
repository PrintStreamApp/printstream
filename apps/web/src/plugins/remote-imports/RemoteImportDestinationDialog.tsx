/** Per-model destination confirmation, shared by URL and native provider captures. */
import { useState } from 'react'
import { buildModelImportFileName } from '@printstream/shared'
import { FormControl, FormLabel, Option, Select } from '@mui/joy'
import { splitLibraryFileNameForRename } from '../../lib/libraryDisplay'
import { LibraryDestinationDialog } from '../../components/LibraryDestinationDialog'
import type { RemoteImportsController } from './useRemoteImportsController'

export function RemoteImportDestinationDialog({ controller }: { controller: RemoteImportsController }) {
  const [draftName, setDraftName] = useState<string | null>(null)
  const [nameError, setNameError] = useState<string | null>(null)
  const {
    destinationPrompt, pickedFolderId, destinationFolders, selectedBridgeId,
    bridges, setBridgeId, setPickedFolderId, foldersQuery
  } = controller
  if (destinationPrompt.fileName === null) return null
  const nameParts = splitLibraryFileNameForRename(destinationPrompt.fileName)

  return (
    <LibraryDestinationDialog
      key={selectedBridgeId}
      title="Choose where to save"
      description={`Choose a library folder for ${destinationPrompt.fileName}.`}
      showFiles
      fileNameField={{ label: 'File name', initialValue: draftName ?? nameParts.baseName, extension: nameParts.extension, onChange: setDraftName }}
      initialFolderId={pickedFolderId}
      folders={destinationFolders}
      bridgeId={selectedBridgeId || null}
      bridgeName={bridges.find((bridge) => bridge.id === selectedBridgeId)?.name ?? null}
      showRoot={false}
      submitting={!selectedBridgeId || foldersQuery.isPending || foldersQuery.isError}
      error={foldersQuery.isError ? 'Could not load library folders. Close this prompt and try again.' : nameError}
      details={bridges.length > 1 ? (
        <FormControl>
          <FormLabel>Library</FormLabel>
          <Select value={selectedBridgeId || null} onChange={(_event, value) => {
            if (!value) return
            setPickedFolderId(null)
            setBridgeId(value)
          }}>
            {bridges.map((bridge) => <Option key={bridge.id} value={bridge.id}>{bridge.name}</Option>)}
          </Select>
        </FormControl>
      ) : null}
      onClose={() => {
        setNameError(null)
        setDraftName(null)
        destinationPrompt.finish(null)
      }}
      onSubmit={({ outputFolderId, outputFileName }) => {
        try {
          buildModelImportFileName(destinationPrompt.fileName!, outputFileName)
          setNameError(null)
          setDraftName(null)
          setPickedFolderId(outputFolderId)
          destinationPrompt.finish({ bridgeId: selectedBridgeId, folderId: outputFolderId, outputFileName })
        } catch (error) {
          setNameError(error instanceof Error ? error.message : 'Choose a valid file name.')
        }
      }}
      confirmActionLabel={() => 'Save here'}
    />
  )
}
