/**
 * Owns the library destination copy and suggested filename for editor exports.
 * The export hook builds STL and generic 3MF files; project 3MF submits to the
 * editor's save pipeline so its Bambu metadata survives.
 */
import type { LibraryFolder } from '@printstream/shared'
import { LibraryDestinationDialog } from '../../components/LibraryDestinationDialog'
import { addedPartHostId, effectiveAddedParts, type EditorPlate, type EditorState } from './lib/editorModel'
import { exportBaseName, partsExportName } from './lib/objectExport'
import type { EditorExportRequest } from './useEditorObjectExport'

interface EditorExportDestinationDialogProps {
  request: EditorExportRequest
  activePlate: EditorPlate | null
  state: EditorState | null
  initialFolderId: string | null
  folders: LibraryFolder[]
  bridgeId: string | null
  onClose: () => void
  onSubmitProject: (key: string, fileName: string | undefined, folderId: string | null) => void
  onSubmitOther: (fileName: string | null, folderId: string | null) => void
}

/** The selected part's own name is used when one part is exported. */
function suggestedExportName(
  request: EditorExportRequest,
  activePlate: EditorPlate | null,
  state: EditorState | null
): string | null {
  if (request.kind === 'separate') return null
  if (request.kind === 'parts') {
    const instance = activePlate?.instances.find((entry) => addedPartHostId(entry) === request.ownerId)
    return instance
      ? partsExportName(instance, request.members, effectiveAddedParts(state, instance))
      : ''
  }
  const key = request.kind === 'object' || request.kind === 'project'
    ? request.key
    : request.keys[0]
  return activePlate?.instances.find((entry) => entry.key === key)?.name ?? ''
}

/** Keep each format's loss-of-project-data warning beside its own destination title. */
function exportDestinationCopy(request: EditorExportRequest): { title: string; description: string } {
  switch (request.kind) {
    case 'project':
      return {
        title: 'Export object as 3MF',
        description: "Choose where to save the new project, then confirm the file name. The object keeps its parts, materials, and paint. Saving with an existing file's name replaces it."
      }
    case 'generic3mf':
      return {
        title: 'Export as generic 3MF',
        description: "Choose where to save the exported 3MF, then confirm the file name. It holds geometry only, for opening in other slicers: materials, painting, and per-object settings are not included. Saving with an existing file's name replaces it."
      }
    case 'separate':
      return {
        title: 'Export objects as STLs',
        description: 'Choose where to save the exported STLs, each selected object becomes its own file, named after the object. Existing files with the same names are replaced.'
      }
    case 'merged':
      return {
        title: 'Export objects as one STL',
        description: "Choose where to save the exported STL, then confirm the file name. Saving with an existing file's name replaces it."
      }
    case 'parts':
      return {
        title: 'Export parts as STL',
        description: "Choose where to save the exported STL, then confirm the file name. Saving with an existing file's name replaces it."
      }
    case 'object':
      return {
        title: 'Export object as STL',
        description: "Choose where to save the exported STL, then confirm the file name. Saving with an existing file's name replaces it."
      }
  }
}

/** Render the same destination picker for all export kinds. */
export function EditorExportDestinationDialog(props: EditorExportDestinationDialogProps) {
  const {
    request, activePlate, state, initialFolderId, folders, bridgeId,
    onClose, onSubmitProject, onSubmitOther
  } = props
  const suggestedName = suggestedExportName(request, activePlate, state)
  const extension = request.kind === 'project' || request.kind === 'generic3mf' ? '.3mf' : '.stl'
  const copy = exportDestinationCopy(request)

  return (
    <LibraryDestinationDialog
      title={copy.title}
      description={copy.description}
      showFiles
      fileNameField={suggestedName === null ? undefined : {
        label: 'File name',
        initialValue: exportBaseName(suggestedName, extension),
        extension
      }}
      initialFolderId={initialFolderId}
      folders={folders}
      bridgeId={bridgeId}
      bridgeName={null}
      showRoot
      dialogWidth={720}
      submitting={false}
      error={null}
      confirmActionLabel={({ outputFolderId, rootDestinationLabel }) => outputFolderId ? 'Export here' : `Export to ${rootDestinationLabel}`}
      onClose={onClose}
      onSubmit={({ outputFileName, outputFolderId }) => {
        if (request.kind === 'project') {
          onSubmitProject(request.key, outputFileName, outputFolderId)
          return
        }
        onSubmitOther(outputFileName ?? null, outputFolderId)
      }}
    />
  )
}
