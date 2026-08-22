/**
 * The remote-import surface (`/library/import`).
 *
 * A library SUB-VIEW, not a top-level page: it resolves a pasted URL, shows what the
 * Chrome helper handed over, and imports the chosen file into the bridge-backed
 * library. Its counterparts are the API plugin (`apps/api/src/plugins/remote-imports`)
 * and the out-of-repo helper extension, which deep-links here with `candidates` /
 * `uploadedFile` / `error` query params.
 *
 * URL state is part of that contract, so the Source URL and the selected candidate are
 * mirrored into the query string rather than held only in component state — a handoff
 * link has to reconstruct the same screen.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Stack,
  Typography
} from '@mui/joy'
import CloudDownloadRoundedIcon from '@mui/icons-material/CloudDownloadRounded'
import ExtensionRoundedIcon from '@mui/icons-material/ExtensionRounded'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import FolderOpenRoundedIcon from '@mui/icons-material/FolderOpenRounded'
import LaunchRoundedIcon from '@mui/icons-material/LaunchRounded'
import PrintRoundedIcon from '@mui/icons-material/PrintRounded'
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
  type RemoteImportUploadResponse
} from '@printstream/shared'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { apiFetch } from '../../lib/apiClient'
import { buildWorkspacePath } from '../../lib/workspaceRoute'
import { buildLibraryFolderRoute, buildLibrarySliceHandoffRoute, fromBridgeFolderId, isBridgeFolderId, toBridgeFolderId } from '../../lib/libraryNavigation'
import { LibraryDestinationDialog } from '../../components/LibraryDestinationDialog'
import { resolveImportReadiness } from './importReadiness'
import { NestedViewHeader } from '../../components/NestedViewHeader'
import { NoConnectedBridgesEmptyState } from '../../components/NoConnectedBridgesEmptyState'
import { PrintModal } from '../../components/library/PrintModal'
import { BrowserAssistPanel } from './BrowserAssistPanel'
import { CandidatePicker } from './CandidatePicker'
import { selectPickerCandidates } from './candidateSelection'
import { probeRemoteImportHelper } from './extensionProbe'
import { getRemoteImportErrorGuidance, type RemoteImportErrorGuidance } from './errorGuidance'

export function RemoteImportsView() {
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [url, setUrl] = useState(searchParams.get('url') ?? '')
  const [candidateUrl, setCandidateUrl] = useState(searchParams.get('candidate') ?? '')
  // Seeded from the library toolbar's current bridge (see `ImportMenuActions`) so the
  // user is not asked to re-pick one they had already chosen.
  const [bridgeId, setBridgeId] = useState<string>(searchParams.get('bridgeId') ?? '')
  /**
   * Chosen destination, in the SAME shape the library's own pickers use: `null` means
   * "the default landing folder", a `bridge:<id>` pseudo-id means that bridge's root,
   * and anything else is a real folder id (which already implies its bridge).
   */
  const [pickedFolderId, setPickedFolderId] = useState<string | null>(null)
  const [destinationOpen, setDestinationOpen] = useState(false)
  const [printTarget, setPrintTarget] = useState<RemoteImportUploadResponse['file'] | null>(null)
  const [extensionDetected, setExtensionDetected] = useState<boolean | null>(null)
  const handoffFile = useMemo(() => parseUploadedFile(searchParams.get('uploadedFile')), [searchParams])
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
  // candidate — show it in the same grid so that path keeps a confirmation surface.
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

  const printersQuery = useQuery({
    queryKey: ['printers'],
    queryFn: ({ signal }) => apiFetch<{ printers: Printer[] }>('/api/printers', { signal }),
    enabled: printTarget != null
  })

  const bridges = useMemo(() => browseQuery.data?.bridgeEntries ?? [], [browseQuery.data])

  // ALL folders, not one bridge's: with several bridges the destination picker shows each
  // bridge as a root folder, which is the library's own convention (`LibraryView` builds
  // the same `bridge:<id>` pseudo-folders). Same query key shape, so creating a folder
  // anywhere refreshes this list.
  const foldersQuery = useQuery({
    queryKey: ['library-folders', 'all'],
    queryFn: ({ signal }) => apiFetch<{ folders: LibraryFolder[] }>('/api/library/folders', { signal })
  })
  // One bridge is assumed rather than chosen; more than one and the picker shows a root
  // per bridge. Mirrors `showGlobalRootBreadcrumb` in `LibraryView`.
  const showBridgeRoots = bridges.length !== 1
  const destinationFolders = useMemo<LibraryFolder[]>(() => {
    const real = foldersQuery.data?.folders ?? []
    if (!showBridgeRoots) return real
    return [
      ...bridges.map((bridge) => ({ id: toBridgeFolderId(bridge.id), name: bridge.name, parentId: null })),
      ...real
    ]
  }, [bridges, foldersQuery.data?.folders, showBridgeRoots])

  /**
   * The picked destination resolved into what the API takes: a real folder id already
   * implies its bridge, a `bridge:<id>` root means that bridge with no folder, and null
   * means the default landing folder on the assumed bridge.
   */
  const destination = useMemo(() => {
    if (pickedFolderId && isBridgeFolderId(pickedFolderId)) {
      return { folderId: null as string | null, bridgeId: fromBridgeFolderId(pickedFolderId) }
    }
    return { folderId: pickedFolderId, bridgeId }
  }, [pickedFolderId, bridgeId])

  useEffect(() => {
    if (bridges.length > 0 && !bridgeId) {
      setBridgeId(browseQuery.data?.activeBridgeId ?? bridges[0]?.id ?? '')
    }
  }, [bridgeId, bridges, browseQuery.data?.activeBridgeId])

  // Keep the selection inside the list on screen. The picker is a radio group, so "nothing
  // selected" is only a legitimate state while the list is leftovers from a previous page —
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
  }, [candidateUrl, searchParams, setSearchParams, url])

  const importMutation = useMutation({
    mutationFn: async ({ openPrintSetup }: { openPrintSetup: boolean }) => {
      const result = await apiFetch<RemoteImportUploadResponse>('/api/plugins/remote-imports/import-url', {
        method: 'POST',
        body: { url: importUrl, bridgeId: destination.bridgeId, folderId: destination.folderId }
      })
      if (openPrintSetup) {
        if (result.canPrintDirectly) {
          setPrintTarget(result.file)
        } else {
          // An unsliced project cannot go straight to a printer, and MakerWorld hands
          // back project files, so this is the COMMON case rather than an edge one.
          // Hand off to the library's prepare-print flow — the one surface that knows
          // how to slice-then-print — rather than importing and falling silent.
          navigate(buildLibrarySliceHandoffRoute({
            workspaceSlug: workspaceSlug ?? '',
            fileId: result.file.id,
            folderId: result.file.folderId,
            bridgeId: bridgeId || null,
            flow: 'print'
          }))
        }
      }
      return result
    }
  })

  const libraryPath = workspaceSlug ? buildWorkspacePath(workspaceSlug, '/library') : '/library'
  const goToLibrary = useCallback(() => navigate(libraryPath), [navigate, libraryPath])
  const closePrintModal = useCallback(() => setPrintTarget(null), [])

  // Arrived from the printers page's Print menu, so printing is the intent — lead with
  // it rather than making the user find it after a plain import.
  const printFirst = searchParams.get('print') === '1'
  const makerWorldRef = useMemo(() => (importUrl ? parseMakerWorldModelUrl(importUrl) : null), [importUrl])
  const makerWorld = capabilitiesQuery.data?.makerWorld
  const importedFile = importMutation.data?.file ?? handoffFile
  // Whether the LAST submit asked for print setup, and whether the file that came back
  // could actually take it. The API decides printability (only it has seen the bytes),
  // so this pair is what turns a silent no-op into an explanation.
  const printWasRequested = importMutation.variables?.openPrintSetup === true
  const importedPrintable = importMutation.data?.canPrintDirectly === true
  // Land in the folder the file went to, not the library root — with slicing being the
  // next step for most imports, "somewhere in the library" is not a useful destination.
  const goToImportedFolder = useCallback(
    () => navigate(
      workspaceSlug
        ? buildLibraryFolderRoute(workspaceSlug, importedFile?.folderId ?? null, bridgeId || null)
        : libraryPath
    ),
    [navigate, workspaceSlug, importedFile?.folderId, bridgeId, libraryPath]
  )
  const libraryFolderName = capabilitiesQuery.data?.libraryFolderName ?? IMPORTED_MODELS_FOLDER_NAME
  // Named for what the user picked, falling back to the folder that will be created.
  const destinationLabel = pickedFolderId
    ? destinationFolders.find((folder) => folder.id === pickedFolderId)?.name ?? libraryFolderName
    : libraryFolderName
  const displayedErrorMessage = importMutation.isError
    ? ('message' in importMutation.error && typeof importMutation.error.message === 'string'
        ? importMutation.error.message
        : 'Import failed')
    : searchError
  const errorGuidance = getRemoteImportErrorGuidance(displayedErrorMessage)
  const requiresManualIntervention = errorGuidance?.requiresManualIntervention === true
  const readiness = resolveImportReadiness({
    hasUrl: Boolean(importUrl),
    hasBridge: Boolean(bridgeId),
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

  return (
    <Stack spacing={2.5}>
      <NestedViewHeader
        crumbs={[{ label: 'Library', onClick: goToLibrary }, { label: 'Import from URL' }]}
        description="Paste a MakerWorld model link or a direct file URL. Both import straight into the library."
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
            <FormControl>
              <FormLabel>Source URL</FormLabel>
              <Input
                value={url}
                placeholder="https://…"
                onChange={(event) => setUrl(event.target.value)}
                // Browser-assist URLs cannot be imported from here at all — opening the page is
                // the actual next step, so it sits on the field rather than further down the card.
                endDecorator={resolution.strategy === 'browser-assist' && (
                  <Button
                    component="a"
                    href={url.trim()}
                    target="_blank"
                    rel="noreferrer"
                    size="sm"
                    variant="soft"
                    startDecorator={<LaunchRoundedIcon />}
                  >
                    Open page
                  </Button>
                )}
              />
              <FormHelperText>
                MakerWorld model pages and direct links to .3mf, .gcode, .stl, or .step files.
              </FormHelperText>
            </FormControl>

            {/* Nothing this page can fetch itself, so the extension's files stay listed below —
                say so, otherwise the picker looks like it answered the URL that was just typed. */}
            {showStaleCandidatesNotice && (
              <Alert size="sm" variant="soft" color="neutral" startDecorator={<ExtensionRoundedIcon />}>
                <Typography level="body-sm">
                  {resolution.strategy === 'browser-assist'
                    ? `The files below are still from the previous page. This ${formatProviderName(resolution.provider)} page has no file PrintStream can fetch on its own.`
                    : 'The files below are still from the previous page. This URL has no file PrintStream can fetch on its own.'}
                </Typography>
              </Alert>
            )}

            {pickerCandidates.length > 0 && (
              <FormControl>
                {/* No Clear action: one file is always the import target while the list matches
                    the URL in the field, so deselecting has nothing to fall back to. */}
                <FormLabel>Provider file</FormLabel>
                <CandidatePicker
                  candidates={pickerCandidates}
                  selectedUrl={candidateUrl}
                  onSelect={(candidate) => setCandidateUrl(candidate.sourceUrl)}
                />
                <FormHelperText>
                  {pickerCandidates.length > 1
                    ? 'Pick the file to import from the provider page.'
                    : 'This is the file that will be imported.'}
                </FormHelperText>
              </FormControl>
            )}

            <FormControl>
              <FormLabel>Save to</FormLabel>
              {/* The button IS the value, matching "Choose printer" in `SliceSettingsPanel`:
                  a chosen destination rendered as prose beside a Change button reads as a
                  fact about the page rather than a setting the user owns. */}
              <Button
                type="button"
                variant="outlined"
                color="neutral"
                startDecorator={<FolderOpenRoundedIcon />}
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

            {providerCandidates.length > 0 && !staleProviderCandidates ? (
              <Alert variant="soft" color="success" startDecorator={<ExtensionRoundedIcon />}>
                <Stack spacing={0.5}>
                  <Typography level="title-sm">
                    Extension provided {providerCandidates.length} file{providerCandidates.length > 1 ? 's' : ''}
                  </Typography>
                  <Typography level="body-sm">
                    Files were handed over from {formatProviderName(resolution.provider)}. Pick one above, then import.
                  </Typography>
                </Stack>
              </Alert>
            ) : makerWorldRef ? (
              // MakerWorld resolves server-side through the connected account, so it must
              // NOT get the browser-helper panel — `detectRemoteImportUrl` still calls it
              // `browser-assist` (that classification predates the account path and is what
              // an extension-only client still needs). Saying "install a helper" beside
              // "downloads as your Bambu account" is two answers to one question.
              null
            ) : resolution.strategy === 'browser-assist' ? (
              // The panel carries the explanation, the probe result, and the setup steps,
              // so skip the generic alert here rather than stacking two notices.
              <BrowserAssistPanel
                extensionDetected={extensionDetected}
                providerLabel={formatProviderName(resolution.provider)}
              />
            ) : !trimmedUrl ? (
              // Nothing typed yet is not a problem to report. `detectRemoteImportUrl('')`
              // resolves to "Unsupported URL / Paste a full URL.", which on a freshly
              // opened form reads as a complaint about something the user has not done.
              null
            ) : (
              <Alert
                variant="soft"
                color={resolution.strategy === 'server-download' ? 'success' : 'neutral'}
                startDecorator={<CloudDownloadRoundedIcon />}
              >
                <Stack spacing={0.5}>
                  <Typography level="title-sm">
                    {formatResolutionTitle(resolution)}
                  </Typography>
                  <Typography level="body-sm">{resolution.message}</Typography>
                </Stack>
              </Alert>
            )}

            {/* Which Bambu account a MakerWorld download runs as, and why it might not
                run at all. A workspace shares ONE connection, so this is regularly not
                the person clicking — say so before the import, not after. */}
            {makerWorldRef && makerWorld && (
              <Alert
                size="sm"
                variant="soft"
                color={makerWorld.enabled && makerWorld.accountConnected ? 'neutral' : 'warning'}
                startDecorator={<InfoOutlinedIcon />}
              >
                <Typography level="body-sm">
                  {!makerWorld.enabled
                    ? 'MakerWorld imports are turned off for this workspace. Turn them on in the remote imports plugin settings, or use the browser helper extension.'
                    : !makerWorld.accountConnected
                        ? 'Connect a Bambu Lab account for this workspace to import MakerWorld models.'
                        : `Downloads as the connected Bambu Lab account${makerWorld.accountLabel ? ` (${makerWorld.accountLabel})` : ''}.`}
                </Typography>
              </Alert>
            )}

            {/* Order follows intent: arriving from a Print control puts printing first. */}
            <Stack direction={printFirst ? 'row-reverse' : 'row'} spacing={1} sx={{ flexWrap: 'wrap', justifyContent: 'flex-start' }}>
              <Button
                size="sm"
                variant={printFirst ? 'soft' : 'solid'}
                disabled={!readiness.canImport || importMutation.isPending}
                loading={importMutation.isPending}
                startDecorator={<CloudDownloadRoundedIcon />}
                onClick={() => void importMutation.mutateAsync({ openPrintSetup: false })}
              >
                Import only
              </Button>
              {/* Only one of the pair is solid: both import, so two primaries would make
                  the card argue with itself about which is the default. */}
              <Button
                size="sm"
                variant={printFirst ? 'solid' : 'soft'}
                disabled={!readiness.canImport || !readiness.canPrint || importMutation.isPending}
                loading={importMutation.isPending}
                startDecorator={<PrintRoundedIcon />}
                onClick={() => void importMutation.mutateAsync({ openPrintSetup: true })}
              >
                Import and print
              </Button>
            </Stack>

            {/* A disabled button with no explanation is the whole reason `readiness`
                returns a reason at all — render it whenever there is one. */}
            {readiness.reason && (
              <Typography level="body-sm" textColor="text.tertiary">
                {readiness.reason}
              </Typography>
            )}

            {displayedErrorMessage && (
              <RemoteImportErrorAlert message={displayedErrorMessage} guidance={errorGuidance} />
            )}

            {importedFile && (
              <Alert color="success" variant="soft">
                <Stack spacing={0.75}>
                  <Typography level="title-sm">Imported {importedFile.name}</Typography>
                  <Typography level="body-sm">
                    {`The file is now in ${destinationLabel}.`}
                  </Typography>
                  {/* "Import and print" on a file that is not already sliced would otherwise
                      just import and fall silent — the print step it promised never opens,
                      with nothing on screen saying why. Say it, and point at where slicing
                      happens. */}
                  {printWasRequested && !importedPrintable && (
                    <Typography level="body-sm">
                      It is not sliced yet, so it cannot go straight to a printer. Open it in the
                      library to slice it first.
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

      {/* The library's own destination picker, so choosing where an import lands works
          exactly like choosing where a save or move lands — including showing each
          bridge as a root folder once there is more than one. */}
      {destinationOpen && (
        <LibraryDestinationDialog
          title="Choose where to save"
          description="Pick the library folder this import should land in."
          initialFolderId={pickedFolderId}
          folders={destinationFolders}
          bridgeId={bridgeId || null}
          bridgeName={bridges.find((bridge) => bridge.id === bridgeId)?.name ?? null}
          showRoot={showBridgeRoots}
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

/**
 * The failure notice, with provider-specific recovery steps when there are any.
 *
 * One component because a failed import and the extension's `?error=` handoff are the
 * same thing to the user — rendering them from two copied blocks is exactly how the
 * wording drifted apart before.
 */
function RemoteImportErrorAlert({
  message,
  guidance
}: {
  message: string
  guidance: RemoteImportErrorGuidance | null
}) {
  return (
    <Alert color="danger" variant="soft">
      <Stack spacing={0.75}>
        <Typography level="body-sm">{message}</Typography>
        {guidance && (
          <>
            <Typography level="title-sm">{guidance.title}</Typography>
            <Box component="ol" sx={{ pl: 2.5, m: 0 }}>
              {guidance.steps.map((step) => (
                <li key={step}>
                  <Typography level="body-sm">{step}</Typography>
                </li>
              ))}
            </Box>
            <Typography level="body-sm">{guidance.note}</Typography>
          </>
        )}
      </Stack>
    </Alert>
  )
}

function formatResolutionTitle(resolution: ReturnType<typeof detectRemoteImportUrl>): string {
  if (resolution.strategy === 'server-download') {
    return `${formatProviderName(resolution.provider)} direct file`
  }
  if (resolution.strategy === 'browser-assist') {
    return `${formatProviderName(resolution.provider)} model page`
  }
  return 'Unsupported URL'
}

function formatProviderName(provider: ReturnType<typeof detectRemoteImportUrl>['provider']): string {
  if (provider === 'makerworld') return 'MakerWorld'
  if (provider === 'printables') return 'Printables'
  return 'Generic'
}

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
