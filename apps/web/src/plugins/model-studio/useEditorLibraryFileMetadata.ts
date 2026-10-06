/**
 * Owns library metadata the editor needs for Save As and settings repair notices.
 * An archived open reads repair reasons from the opened index, never the file head;
 * local repair pins suppress their reason immediately without waiting for a save.
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type {
  LibraryFile,
  LibraryFolder,
  ThreeMfIndex,
  ThreeMfSettingsRepairReason
} from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { splitLibraryFileNameForRename } from '../../lib/libraryDisplay'
import type { EditorState } from './lib/editorModel'

const NO_REPAIR_REASONS: readonly ThreeMfSettingsRepairReason[] = []

interface LibraryFileMetadataOptions {
  baseFileId: string | null
  baseVersionId: string | null | undefined
  isNewProject: boolean
  bridgeId: string | null
  folderId: string | null
  sourceIndex: ThreeMfIndex | undefined
  repairReasons: readonly ThreeMfSettingsRepairReason[] | undefined
  unrepairableRepairReasons: readonly ThreeMfSettingsRepairReason[] | undefined
  state: EditorState | null
}

/** Return Save As metadata and repair notices for the version this editor actually opened. */
export function useEditorLibraryFileMetadata(options: LibraryFileMetadataOptions) {
  const {
    baseFileId,
    baseVersionId,
    isNewProject,
    bridgeId,
    folderId,
    sourceIndex,
    repairReasons,
    unrepairableRepairReasons,
    state
  } = options
  const baseFileQuery = useQuery({
    queryKey: ['library-file', baseFileId],
    enabled: baseFileId !== null,
    queryFn: ({ signal }) => apiFetch<{ file: LibraryFile }>(`/api/library/${baseFileId}`, { signal }),
    staleTime: 60_000
  })
  const saveAsBridgeId = bridgeId
  const saveAsInitialFolderId = bridgeId ? folderId : null
  const saveAsSuggestedName = baseFileQuery.data
    ? splitLibraryFileNameForRename(baseFileQuery.data.file.name).baseName
    : ''
  const projectName = baseFileQuery.data?.file.name ?? 'project.3mf'

  const needsSettingsRepairFileId = baseFileId !== null
    && !isNewProject
    && baseVersionId == null
    && baseFileQuery.data?.file.needsSettingsRepair === true
    ? baseFileId
    : null
  const openedArchivedVersion = baseFileId !== null && !isNewProject && baseVersionId != null
  const rawReasons: readonly ThreeMfSettingsRepairReason[] = (
    needsSettingsRepairFileId
      ? baseFileQuery.data?.file.settingsRepairReasons
      : openedArchivedVersion
        ? sourceIndex?.settingsRepairReasons
        : repairReasons
  ) ?? NO_REPAIR_REASONS
  const unrepairableRepairReasonsResolved: readonly ThreeMfSettingsRepairReason[] = (
    needsSettingsRepairFileId
      ? baseFileQuery.data?.file.unrepairableSettingsRepairReasons
      : openedArchivedVersion
        ? sourceIndex?.unrepairableSettingsRepairReasons
        : unrepairableRepairReasons
  ) ?? NO_REPAIR_REASONS
  // This array rides a settings-panel controller; keep its identity stable across unrelated edits.
  const settingsRepairReasons = useMemo(
    () => rawReasons.filter((reason) => reason === 'filamentPhysics'
      ? !state?.repairedFilamentConfigs
      : !state?.settingsRepairStaged),
    [rawReasons, state?.repairedFilamentConfigs, state?.settingsRepairStaged]
  )

  const editorFoldersQuery = useQuery({
    queryKey: ['library-folders', saveAsBridgeId ?? 'none'],
    enabled: saveAsBridgeId !== null,
    queryFn: ({ signal }) => apiFetch<{ folders: LibraryFolder[] }>(
      `/api/library/folders?bridgeId=${encodeURIComponent(saveAsBridgeId!)}`,
      { signal }
    ),
    staleTime: 60_000
  })

  return {
    baseFileQuery,
    saveAsBridgeId,
    saveAsInitialFolderId,
    saveAsSuggestedName,
    projectName,
    openedArchivedVersion,
    settingsRepairReasons,
    unrepairableRepairReasonsResolved,
    editorFoldersQuery
  }
}
