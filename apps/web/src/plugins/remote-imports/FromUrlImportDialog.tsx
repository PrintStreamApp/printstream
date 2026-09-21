/** URL-only remote-import workflow opened from the import source chooser. */
import CloudDownloadRoundedIcon from '@mui/icons-material/CloudDownloadRounded'
import ExtensionRoundedIcon from '@mui/icons-material/ExtensionRounded'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import LaunchRoundedIcon from '@mui/icons-material/LaunchRounded'
import PrintRoundedIcon from '@mui/icons-material/PrintRounded'
import { Alert, Box, Button, FormControl, FormHelperText, FormLabel, Input, Stack, Typography } from '@mui/joy'
import { detectRemoteImportUrl } from '@printstream/shared'
import { FormDialog } from '../../components/FormDialog'
import { isNativeApp } from '../../native/bridge'
import { BrowserAssistPanel } from './BrowserAssistPanel'
import { CandidatePicker } from './CandidatePicker'
import type { RemoteImportErrorGuidance } from './errorGuidance'
import type { RemoteImportsController } from './RemoteImportsView'

export function FromUrlImportDialog({
  controller,
  open,
  onClose
}: {
  controller: RemoteImportsController
  open: boolean
  onClose: () => void
}) {
  const {
    url,
    setUrl,
    trimmedUrl,
    resolution,
    nativePastedProvider,
    nativeImportMutation,
    startNativeImport,
    showStaleCandidatesNotice,
    providerCandidates,
    pickerCandidates,
    candidateUrl,
    setCandidateUrl,
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
    extensionDetected
  } = controller
  const busy = importMutation.isPending || nativeImportMutation.isPending
  const primaryPrintAction = printFirst

  return (
    <FormDialog
      open={open}
      title="Import from URL"
      description="Paste a supported model page or direct printable-file URL."
      submitLabel={showUrlImportActions
        ? primaryPrintAction ? 'Import and print' : 'Import only'
        : null}
      submitDisabled={!readiness.canImport || (primaryPrintAction && !readiness.canPrint)}
      busy={busy}
      onClose={onClose}
      onSubmit={() => startServerImport(primaryPrintAction)}
      secondaryActions={showUrlImportActions ? (
        <Button
          variant="soft"
          disabled={!readiness.canImport || (!primaryPrintAction && !readiness.canPrint) || busy}
          startDecorator={primaryPrintAction ? <CloudDownloadRoundedIcon /> : <PrintRoundedIcon />}
          onClick={() => startServerImport(!primaryPrintAction)}
        >
          {primaryPrintAction ? 'Import only' : 'Import and print'}
        </Button>
      ) : null}
    >
      <FormControl>
        <FormLabel>Source URL</FormLabel>
        <Input
          autoFocus
          value={url}
          placeholder="https://…"
          onChange={(event) => setUrl(event.target.value)}
          endDecorator={resolution.strategy === 'browser-assist' && (
            nativePastedProvider ? (
              <Button
                size="sm"
                variant="soft"
                startDecorator={<LaunchRoundedIcon />}
                loading={nativeImportMutation.isPending}
                onClick={() => startNativeImport({
                  provider: nativePastedProvider,
                  startUrl: url.trim(),
                  openPrintSetup: false
                })}
              >
                Open in app
              </Button>
            ) : (
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
            )
          )}
        />
        <FormHelperText>
          {isNativeApp()
            ? 'A pasted MakerWorld model page uses the workspace Bambu account. The Browse buttons use their own website session instead.'
            : 'MakerWorld and Printables model pages, plus direct links to supported printable files.'}
        </FormHelperText>
      </FormControl>

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
      ) : makerWorldRef ? null : resolution.strategy === 'browser-assist' && !nativePastedProvider ? (
        <BrowserAssistPanel
          extensionDetected={extensionDetected}
          providerLabel={formatProviderName(resolution.provider)}
        />
      ) : trimmedUrl ? (
        <Alert
          variant="soft"
          color={resolution.strategy === 'server-download' ? 'success' : 'neutral'}
          startDecorator={<CloudDownloadRoundedIcon />}
        >
          <Stack spacing={0.5}>
            <Typography level="title-sm">{formatResolutionTitle(resolution)}</Typography>
            <Typography level="body-sm">{resolution.message}</Typography>
          </Stack>
        </Alert>
      ) : null}

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
                  : `Pasted MakerWorld links download as the connected Bambu Lab account${makerWorld.accountLabel ? ` (${makerWorld.accountLabel})` : ''}. The app's Browse MakerWorld window uses its own separate sign-in.`}
          </Typography>
        </Alert>
      )}

      {showUrlImportActions && readiness.reason && (
        <Typography level="body-sm" textColor="text.tertiary">{readiness.reason}</Typography>
      )}

      {displayedErrorMessage && (
        <RemoteImportErrorAlert
          message={displayedErrorMessage}
          guidance={errorGuidance}
          nativeImport={canUseNativeMakerWorldImport
            ? {
                pending: nativeImportMutation.isPending,
                onStart: () => startNativeImport({
                  provider: 'makerworld',
                  startUrl: importUrl,
                  openPrintSetup: importMutation.variables?.openPrintSetup === true
                })
              }
            : null}
        />
      )}

      {challengeTestMode && canUseNativeMakerWorldImport && !displayedErrorMessage && (
        <Alert color="warning" variant="soft">
          <Stack spacing={0.75}>
            <Typography level="title-sm">MakerWorld challenge test mode</Typography>
            <Typography level="body-sm">
              Run the forced interactive challenge, then download its test 3MF through the real desktop import path.
            </Typography>
            <Button
              size="sm"
              variant="solid"
              loading={nativeImportMutation.isPending}
              startDecorator={<LaunchRoundedIcon />}
              onClick={() => startNativeImport({
                provider: 'makerworld',
                startUrl: importUrl,
                openPrintSetup: false
              })}
              sx={{ alignSelf: 'flex-start' }}
            >
              Run challenge test
            </Button>
          </Stack>
        </Alert>
      )}
    </FormDialog>
  )
}

function RemoteImportErrorAlert({
  message,
  guidance,
  nativeImport
}: {
  message: string
  guidance: RemoteImportErrorGuidance | null
  nativeImport: { pending: boolean; onStart(): void } | null
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
                <li key={step}><Typography level="body-sm">{step}</Typography></li>
              ))}
            </Box>
            <Typography level="body-sm">{guidance.note}</Typography>
            {nativeImport && (
              <Box>
                <Button
                  size="sm"
                  variant="solid"
                  loading={nativeImport.pending}
                  startDecorator={<LaunchRoundedIcon />}
                  onClick={nativeImport.onStart}
                >
                  Open MakerWorld download
                </Button>
                <Typography level="body-xs" sx={{ mt: 0.75 }}>
                  Complete any security check and click Download. PrintStream will import the downloaded 3MF.
                </Typography>
              </Box>
            )}
          </>
        )}
      </Stack>
    </Alert>
  )
}

function formatResolutionTitle(resolution: ReturnType<typeof detectRemoteImportUrl>): string {
  if (resolution.strategy === 'server-download') return `${formatProviderName(resolution.provider)} direct file`
  if (resolution.strategy === 'browser-assist') return `${formatProviderName(resolution.provider)} model page`
  return 'Unsupported URL'
}

function formatProviderName(provider: ReturnType<typeof detectRemoteImportUrl>['provider']): string {
  if (provider === 'makerworld') return 'MakerWorld'
  if (provider === 'printables') return 'Printables'
  return 'Generic'
}
