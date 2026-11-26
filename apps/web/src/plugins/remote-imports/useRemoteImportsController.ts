/**
 * Owns URL resolution, native browsing, per-model destination confirmation, and
 * the saved-file handoff. Menu overlays and legacy routes share this controller;
 * native capture never receives a destination until the user confirms that model.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  IMPORTED_MODELS_FOLDER_NAME,
  canPrintRemoteImportCandidateDirectly,
  detectRemoteImportUrl,
  isDirectPrintableFileName,
  parseMakerWorldModelUrl,
  libraryFileSchema,
  remoteImportCandidateSchema,
  type LibraryBrowseResponse,
  type LibraryFolder,
  type Printer,
  type RemoteImportCapabilitiesResponse,
  type RemoteImportCandidate,
  type RemoteImportUploadResponse,
  type RemoteImportPreparedResponse
} from '@printstream/shared'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { apiFetch } from '../../lib/apiClient'
import { buildWorkspacePath } from '../../lib/workspaceRoute'
import {
  buildLibraryFolderRoute,
  buildLibraryModelStudioImportHandoffRoute,
  buildLibrarySliceHandoffRoute
} from '../../lib/libraryNavigation'
import { isUnslicedThreeMfFile } from '../../lib/libraryFileTags'
import { resolveImportReadiness } from './importReadiness'
import { selectPickerCandidates } from './candidateSelection'
import { probeRemoteImportHelper } from './extensionProbe'
import { getRemoteImportErrorGuidance } from './errorGuidance'
import { isDesktopMakerWorldChallengeTest } from '../../native/desktopBridge'
import { useImportDestination } from './useImportDestination'
import type { ImportLaunch } from './importLaunchStore'
import {
  downloadAndImportFromModelProvider,
  isNativeApp,
  nativeModelImportProviders,
  type NativeModelProvider
} from '../../native/bridge'

interface NativeModelImportResult {
  file: RemoteImportUploadResponse['file']
  canPrintDirectly: boolean
  printWasRequested: boolean
  openedInEditor: boolean
  destinationBridgeId: string | null
  destinationLabel: string
}

export function useRemoteImportsController(launch?: ImportLaunch) {
  const destinationPrompt = useImportDestination()
  const chooseModelDestination = destinationPrompt.choose
  const { workspaceSlug: routeWorkspaceSlug } = useParams<{ workspaceSlug: string }>()
  const workspaceSlug = launch?.workspaceSlug ?? routeWorkspaceSlug
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [url, setUrl] = useState(searchParams.get('url') ?? '')
  const [candidateUrl, setCandidateUrl] = useState(searchParams.get('candidate') ?? '')
  // Seeded from the library toolbar's current bridge (see `ImportMenuActions`) so the
  // user is not asked to re-pick one they had already chosen.
  const [bridgeId, setBridgeId] = useState<string>(launch?.bridgeId ?? searchParams.get('bridgeId') ?? '')
  const initialFolderId = launch?.folderId ?? searchParams.get('folderId') ?? null
  const [pickedFolderId, setPickedFolderId] = useState<string | null>(initialFolderId)
  const [printTarget, setPrintTarget] = useState<RemoteImportUploadResponse['file'] | null>(null)
  const [extensionDetected, setExtensionDetected] = useState<boolean | null>(null)
  const uploadedFileParam = searchParams.get('uploadedFile')
  const [dismissedHandoff, setDismissedHandoff] = useState<string | null>(null)
  const handoffFile = useMemo(
    () => uploadedFileParam && uploadedFileParam !== dismissedHandoff
      ? parseUploadedFile(uploadedFileParam)
      : null,
    [dismissedHandoff, uploadedFileParam]
  )
  const providerCandidates = useMemo(() => parseProviderCandidates(searchParams.get('candidates')), [searchParams])
  const resolution = useMemo(() => detectRemoteImportUrl(url), [url])
  const trimmedUrl = url.trim()
  const importUrl = (candidateUrl || url).trim()
  const importResolution = useMemo(() => detectRemoteImportUrl(importUrl), [importUrl])
  const searchError = searchParams.get('error')
  // The extension's candidates belong to the page it scraped; remember that page so a later
  // paste can tell "leftover files from the handoff" from "files for the URL in the field".
  const [handoffUrl] = useState(() => (searchParams.has('candidates') ? (searchParams.get('url') ?? '').trim() : ''))
  // With no extension handoff, a pasted direct file URL still resolves to one
  // candidate: show it in the same grid so that path keeps a confirmation surface.
  const { candidates: pickerCandidates, staleHandoff: staleProviderCandidates } = useMemo(
    () => selectPickerCandidates({
      handoffCandidates: providerCandidates,
      handoffUrl,
      url,
      pastedCandidates: resolution.candidates,
      importCandidates: importResolution.candidates
    }),
    [handoffUrl, importResolution.candidates, providerCandidates, resolution.candidates, url]
  )
  const showStaleCandidatesNotice = staleProviderCandidates && resolution.candidates.length === 0
  const selectedCandidate = useMemo(
    () => pickerCandidates.find((candidate) => candidate.sourceUrl === candidateUrl) ?? importResolution.candidates[0] ?? null,
    [candidateUrl, importResolution.candidates, pickerCandidates]
  )

  // Prefix-matched by `invalidateLibraryListQueries` (`['library-browse']`), so an
  // import from anywhere refreshes the bridge list here too.
  const browseQuery = useQuery({
    queryKey: ['library-browse', 'remote-import-bridges'],
    queryFn: ({ signal }) => apiFetch<LibraryBrowseResponse>('/api/library/browse', { signal })
  })

  const capabilitiesQuery = useQuery({
    queryKey: ['remote-import-capabilities'],
    queryFn: ({ signal }) => apiFetch<RemoteImportCapabilitiesResponse>('/api/plugins/remote-imports/capabilities', { signal })
  })

  const nativeProvidersQuery = useQuery({
    queryKey: ['native-model-import-providers'],
    queryFn: nativeModelImportProviders,
    enabled: isNativeApp(),
    staleTime: Infinity
  })

  const printersQuery = useQuery({
    queryKey: ['printers'],
    queryFn: ({ signal }) => apiFetch<{ printers: Printer[] }>('/api/printers', { signal }),
    enabled: printTarget != null
  })

  const bridges = useMemo(() => browseQuery.data?.bridgeEntries ?? [], [browseQuery.data])
  const selectedBridgeId = bridges.some((bridge) => bridge.id === bridgeId) ? bridgeId : ''

  // Folder ids do not expose their owning bridge. Keep the picker scoped to the
  // selected bridge so a folder can never be submitted with another bridge id.
  const foldersQuery = useQuery({
    queryKey: ['library-folders', selectedBridgeId || 'none'],
    queryFn: ({ signal }) => apiFetch<{ folders: LibraryFolder[] }>(
      `/api/library/folders?bridgeId=${encodeURIComponent(selectedBridgeId)}`,
      { signal }
    ),
    enabled: Boolean(selectedBridgeId)
  })
  const destinationFolders = useMemo<LibraryFolder[]>(
    () => foldersQuery.data?.folders ?? [],
    [foldersQuery.data?.folders]
  )

  const destination = useMemo(() => {
    return { folderId: pickedFolderId, bridgeId: selectedBridgeId }
  }, [pickedFolderId, selectedBridgeId])

  useEffect(() => {
    if (bridges.length > 0 && !selectedBridgeId) {
      setPickedFolderId(null)
      setBridgeId(browseQuery.data?.activeBridgeId ?? bridges[0]?.id ?? '')
    }
  }, [bridges, browseQuery.data?.activeBridgeId, selectedBridgeId])

  // Keep the selection inside the list on screen. The picker is a radio group, so "nothing
  // selected" is only a legitimate state while the list is leftovers from a previous page,
  // there, auto-selecting would quietly make a stale file the import target.
  useEffect(() => {
    if (pickerCandidates.length === 0) return
    if (candidateUrl && pickerCandidates.some((candidate) => candidate.sourceUrl === candidateUrl)) return
    if (showStaleCandidatesNotice) {
      if (candidateUrl) setCandidateUrl('')
      return
    }
    setCandidateUrl(pickerCandidates[0]?.sourceUrl ?? '')
  }, [candidateUrl, pickerCandidates, showStaleCandidatesNotice])

  useEffect(() => {
    if (handoffFile && searchParams.get('print') === '1') {
      setPrintTarget(handoffFile)
    }
  }, [handoffFile, searchParams])

  // Probe once on mount, not per URL: the answer never depends on what was pasted, and
  // the setup card is hidden on a detected helper before any URL exists.
  useEffect(() => {
    let cancelled = false
    void probeRemoteImportHelper(window).then((detected) => {
      if (!cancelled) setExtensionDetected(detected)
    })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const trimmed = url.trim()
    if (launch) return
    const next = new URLSearchParams(searchParams)
    if (trimmed) {
      next.set('url', trimmed)
      if (candidateUrl.trim()) next.set('candidate', candidateUrl.trim())
      else next.delete('candidate')
    } else {
      next.delete('url')
    }
    // Bail when nothing actually moved: `setSearchParams` navigates, and re-running this
    // effect off its own write is how a mirror-state effect becomes a render loop.
    if (next.toString() === searchParams.toString()) return
    setSearchParams(next, { replace: true })
  }, [candidateUrl, launch, searchParams, setSearchParams, url])

  const chooseDestination = useCallback((fileName: string) => {
    return chooseModelDestination(fileName)
  }, [chooseModelDestination])

  const libraryFolderName = capabilitiesQuery.data?.libraryFolderName ?? IMPORTED_MODELS_FOLDER_NAME
  const destinationFolderLabel = pickedFolderId
    ? destinationFolders.find((folder) => folder.id === pickedFolderId)?.name ?? libraryFolderName
    : 'Library root'
  const destinationBridgeName = bridges.find((bridge) => bridge.id === destination.bridgeId)?.name
  const destinationLabel = bridges.length > 1 && destinationBridgeName
    ? `${destinationBridgeName} / ${destinationFolderLabel}`
    : destinationFolderLabel

  const importMutation = useMutation({
    mutationFn: async ({ openPrintSetup }: { openPrintSetup: boolean }) => {
      const prepared = await apiFetch<RemoteImportPreparedResponse>('/api/plugins/remote-imports/prepare-url', {
        method: 'POST', body: { url: importUrl }
      })
      const chosen = await chooseDestination(prepared.fileName)
      if (!chosen) {
        await apiFetch(`/api/plugins/remote-imports/prepared/${encodeURIComponent(prepared.id)}`, { method: 'DELETE' })
        return null
      }
      setPickedFolderId(chosen.folderId)
      setBridgeId(chosen.bridgeId)
      const result = await apiFetch<RemoteImportUploadResponse>('/api/plugins/remote-imports/import-url', {
        method: 'POST',
        body: { url: importUrl, ...chosen, destinationSelected: true, preparedImportId: prepared.id }
      })
      if (openPrintSetup) {
        if (result.canPrintDirectly) {
          setPrintTarget(result.file)
        } else {
          // An unsliced project cannot go straight to a printer, and MakerWorld hands
          // back project files, so this is the COMMON case rather than an edge one.
          // Hand off to the library's prepare-print flow, the one surface that knows
          // how to slice-then-print, rather than importing and falling silent.
          navigate(buildLibrarySliceHandoffRoute({
            workspaceSlug: workspaceSlug ?? '',
            fileId: result.file.id,
            folderId: result.file.folderId,
            bridgeId: chosen.bridgeId || null,
            flow: 'print'
          }))
        }
      }
      return {
        ...result,
        destinationBridgeId: chosen.bridgeId || null,
        destinationLabel: 'your library'
      }
    }
  })

  const libraryPath = workspaceSlug ? buildWorkspacePath(workspaceSlug, '/library') : '/library'
  const goToLibrary = useCallback(() => navigate(libraryPath), [navigate, libraryPath])
  const closePrintModal = useCallback(() => setPrintTarget(null), [])

  // Arrived from the printers page's Print menu, so printing is the intent: lead with
  // it rather than making the user find it after a plain import.
  const printFirst = searchParams.get('print') === '1'
  const makerWorldRef = useMemo(() => (importUrl ? parseMakerWorldModelUrl(importUrl) : null), [importUrl])
  const makerWorld = capabilitiesQuery.data?.makerWorld
  /**
   * Native hosts keep MakerWorld in an isolated browser session. The user completes
   * any challenge and starts the download there; the host captures the resulting file.
   */
  const nativeImportMutation = useMutation({
    mutationFn: async ({
      provider,
      startUrl,
      resume,
      openPrintSetup
    }: {
      provider: NativeModelProvider
      startUrl: string
      resume?: boolean
      openPrintSetup: boolean
    }): Promise<NativeModelImportResult | null> => {
      if (!workspaceSlug) throw new Error('This model import is no longer available.')
      const nativeResult = await downloadAndImportFromModelProvider({
        provider,
        modelUrl: startUrl,
        resume,
        workspace: workspaceSlug,
        bridgeId: destination.bridgeId || null,
        folderId: destination.folderId,
        defaultFolderName: libraryFolderName,
        promptForDestination: true
      }, chooseDestination)
      if ('externalOpened' in nativeResult || 'cancelled' in nativeResult) return null
      let result
      if ('importUrl' in nativeResult) {
        const chosen = await chooseDestination('model')
        if (!chosen) return null
        const imported = await apiFetch<RemoteImportUploadResponse>('/api/plugins/remote-imports/import-url', {
          method: 'POST',
          body: { url: nativeResult.importUrl, ...chosen, destinationSelected: true }
        })
        result = { ...imported, destinationBridgeId: chosen.bridgeId }
      } else {
        result = nativeResult
      }
      const file = libraryFileSchema.parse(result.file)
      const savedBridgeId = 'destinationBridgeId' in result && typeof result.destinationBridgeId === 'string'
        ? result.destinationBridgeId
        : destination.bridgeId
      const canPrintDirectly = isDirectPrintableFileName(file.name)

      if ('openAfterImport' in result && result.openAfterImport === 'model-studio') {
        navigate(isUnslicedThreeMfFile(file)
          ? buildLibrarySliceHandoffRoute({
              workspaceSlug,
              fileId: file.id,
              folderId: file.folderId,
              bridgeId: savedBridgeId || null
            })
          : buildLibraryModelStudioImportHandoffRoute({
              workspaceSlug,
              fileId: file.id,
              folderId: file.folderId,
              bridgeId: savedBridgeId || null
            }))
      } else if (openPrintSetup) {
        if (canPrintDirectly) {
          setPrintTarget(file)
        } else {
          navigate(buildLibrarySliceHandoffRoute({
            workspaceSlug,
            fileId: file.id,
            folderId: file.folderId,
            bridgeId: savedBridgeId || null,
            flow: 'print'
          }))
        }
      }

      return {
        file,
        canPrintDirectly,
        printWasRequested: openPrintSetup,
        openedInEditor: 'openAfterImport' in result && result.openAfterImport === 'model-studio',
        destinationBridgeId: savedBridgeId || null,
        destinationLabel: 'your library'
      }
    }
  })
  const importedFile = importMutation.data?.file ?? nativeImportMutation.data?.file ?? handoffFile
  const importedBridgeId = importMutation.data?.destinationBridgeId
    ?? nativeImportMutation.data?.destinationBridgeId
    ?? (selectedBridgeId || null)
  // Whether the LAST submit asked for print setup, and whether the file that came back
  // could actually take it. The API decides printability (only it has seen the bytes),
  // so this pair is what turns a silent no-op into an explanation.
  const printWasRequested = nativeImportMutation.data?.printWasRequested
    ?? importMutation.variables?.openPrintSetup === true
  const importedPrintable = nativeImportMutation.data?.canPrintDirectly
    ?? importMutation.data?.canPrintDirectly === true
  // Land in the folder the file went to, not the library root, with slicing being the
  // next step for most imports, "somewhere in the library" is not a useful destination.
  const goToImportedFolder = useCallback(
    () => navigate(
      workspaceSlug
        ? buildLibraryFolderRoute(workspaceSlug, importedFile?.folderId ?? null, importedBridgeId)
        : libraryPath
    ),
    [navigate, workspaceSlug, importedFile?.folderId, importedBridgeId, libraryPath]
  )
  const importedDestinationLabel = importMutation.data?.destinationLabel
    ?? nativeImportMutation.data?.destinationLabel
    ?? destinationLabel
  const displayedErrorMessage = nativeImportMutation.isError
    ? nativeImportMutation.error.message
    : importMutation.isError
      ? ('message' in importMutation.error && typeof importMutation.error.message === 'string'
          ? importMutation.error.message
          : 'Import failed')
      : searchError
  const challengeGuidance = getRemoteImportErrorGuidance(
    importMutation.isError ? importMutation.error.message : searchError
  )
  const errorGuidance = challengeGuidance ?? getRemoteImportErrorGuidance(displayedErrorMessage)
  const requiresManualIntervention = errorGuidance?.requiresManualIntervention === true
  const challengeTestMode = isDesktopMakerWorldChallengeTest()
  const nativeProviders = nativeProvidersQuery.data ?? []
  const canBrowseNativeMakerWorld = Boolean(destination.bridgeId) && nativeProviders.includes('makerworld')
  const canBrowseNativePrintables = Boolean(destination.bridgeId) && nativeProviders.includes('printables')
  const nativePastedProvider: NativeModelProvider | null = resolution.provider === 'makerworld' && canBrowseNativeMakerWorld
    ? 'makerworld'
    : resolution.provider === 'printables' && canBrowseNativePrintables
      ? 'printables'
      : null
  const canUseNativeMakerWorldImport = (challengeGuidance?.requiresManualIntervention === true || challengeTestMode)
    && makerWorldRef != null
    && Boolean(destination.bridgeId)
    && canBrowseNativeMakerWorld
  const showUrlImportActions = (!isNativeApp() || Boolean(trimmedUrl))
    && nativePastedProvider !== 'printables'
  const readiness = resolveImportReadiness({
    hasUrl: Boolean(importUrl),
    hasBridge: Boolean(destination.bridgeId),
    strategy: importResolution.strategy,
    resolutionMessage: importResolution.message,
    hasSelectedCandidate: selectedCandidate != null,
    isDirectPrintable: selectedCandidate
      ? canPrintRemoteImportCandidateDirectly(selectedCandidate)
      : isDirectPrintableFileName(importUrl),
    makerWorld: makerWorldRef && makerWorld
      ? { enabled: makerWorld.enabled, accountConnected: makerWorld.accountConnected }
      : null,
    requiresManualIntervention
  })
  const showNoBridgesPlaceholder = !browseQuery.isPending && bridges.length === 0

  const clearPreviousImportState = () => {
    setDismissedHandoff(uploadedFileParam)
    if (launch) return
    const next = new URLSearchParams(searchParams)
    next.delete('error')
    next.delete('uploadedFile')
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true })
  }
  const startServerImport = (openPrintSetup: boolean) => {
    setPickedFolderId(initialFolderId)
    clearPreviousImportState()
    nativeImportMutation.reset()
    importMutation.mutate({ openPrintSetup })
  }
  const startNativeImport = (input: {
    provider: NativeModelProvider
    startUrl: string
    resume?: boolean
    openPrintSetup: boolean
  }) => {
    setPickedFolderId(initialFolderId)
    clearPreviousImportState()
    importMutation.reset()
    nativeImportMutation.mutate(input)
  }

  return {
    goToLibrary,
    showNoBridgesPlaceholder,
    browseError: browseQuery.isError ? 'Could not load library storage. Close this dialog and try again.' : null,
    nativeProvidersLoading: isNativeApp() && nativeProvidersQuery.isPending,
    canBrowseNativeMakerWorld,
    canBrowseNativePrintables,
    nativeImportMutation,
    startNativeImport,
    url,
    setUrl,
    trimmedUrl,
    resolution,
    nativePastedProvider,
    showStaleCandidatesNotice,
    providerCandidates,
    pickerCandidates,
    candidateUrl,
    setCandidateUrl,
    bridges,
    selectedBridgeId,
    setBridgeId,
    setPickedFolderId,
    foldersQuery,
    destinationLabel,
    destinationPrompt,
    destination,
    libraryFolderName,
    staleProviderCandidates,
    makerWorldRef,
    makerWorld,
    showUrlImportActions,
    printFirst,
    readiness,
    importMutation,
    startServerImport,
    displayedErrorMessage,
    errorGuidance,
    canUseNativeMakerWorldImport,
    importUrl,
    challengeTestMode,
    importedFile,
    importedDestinationLabel,
    printWasRequested,
    importedPrintable,
    goToImportedFolder,
    destinationOpen: destinationPrompt.fileName !== null,
    pickedFolderId,
    destinationFolders,
    printTarget,
    printersQuery,
    closePrintModal,
    extensionDetected
  }
}


export type RemoteImportsController = ReturnType<typeof useRemoteImportsController>

function parseProviderCandidates(raw: string | null): RemoteImportCandidate[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    const result = remoteImportCandidateSchema.array().safeParse(parsed)
    return result.success ? result.data : []
  } catch {
    return []
  }
}

function parseUploadedFile(raw: string | null): RemoteImportUploadResponse['file'] | null {
  if (!raw) return null
  try {
    const result = libraryFileSchema.safeParse(JSON.parse(raw))
    return result.success ? result.data : null
  } catch {
    return null
  }
}
