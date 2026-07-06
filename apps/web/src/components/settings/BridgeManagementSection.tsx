import React from 'react'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import ArticleRoundedIcon from '@mui/icons-material/ArticleRounded'
import HubRoundedIcon from '@mui/icons-material/HubRounded'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import WarningRoundedIcon from '@mui/icons-material/WarningRounded'
import { Alert, Box, Button, Card, CardContent, Chip, DialogTitle, Divider, FormControl, FormLabel, Input, Sheet, Stack, Typography } from '@mui/joy'
import {
  type BridgeListResponse,
  type BridgeStandaloneDownloadsResponse,
  type BridgeResponse,
  type BridgeSummary,
  type BridgeDebugCaptureStatus,
  type BridgeSystemLogEntry,
  type BridgeSystemLogsResult,
  type BridgeTestResponse,
  type BridgeUpdateActionResponse,
  extractErrorMessage
} from '@printstream/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../lib/apiClient'
import { buildApiUrl } from '../../lib/apiUrl'
import { getBrowserEnv } from '../../lib/browserEnv'
import { detectBridgePlatformKey, placeholderBridgeDownloads } from '../../lib/bridgePlatform'
import { invalidateBridgeQueries } from '../../lib/bridgeQueryInvalidation'
import { consumePendingBridgeConnectCode } from '../../lib/pendingBridgeConnect'
import { formatDateTime } from '../../lib/time'
import { formatBridgeUpdateStatus } from '../../lib/bridgeUpdateStatus'
import { bridgeCrashChip } from '../../lib/bridgeCrashHealth'
import { BackAwareModal } from '../BackAwareModal'
import { BridgeInstallCard } from '../BridgeInstallCard'
import { ConnectivityGuideButton } from '../ConnectivityGuideButton'
import { ConfirmActionDialog } from '../ConfirmActionDialog'
import { ScrollableDialogBody, ScrollableModalDialog } from '../ScrollableDialog'

export function BridgeSettingsSection() {
  const [detectedPlatformKey, setDetectedPlatformKey] = React.useState<string | null>(null)
  const [connectOpen, setConnectOpen] = React.useState(false)
  const [initialConnectCode, setInitialConnectCode] = React.useState<string | null>(null)
  // A connect-bridge deep link lands here with the code stashed in session
  // storage; open the connect dialog with it pre-filled.
  React.useEffect(() => {
    const stashedCode = consumePendingBridgeConnectCode()
    if (!stashedCode) return
    setInitialConnectCode(stashedCode)
    setConnectOpen(true)
  }, [])
  const bridgesQuery = useQuery({
    queryKey: ['settings-bridges'],
    queryFn: ({ signal }) => apiFetch<BridgeListResponse>('/api/bridges', { signal })
  })
  const downloadsQuery = useQuery({
    queryKey: ['bridge-downloads'],
    queryFn: ({ signal }) => apiFetch<BridgeStandaloneDownloadsResponse>('/api/bridges/downloads', { signal }),
    staleTime: 5 * 60 * 1000
  })
  React.useEffect(() => {
    let cancelled = false
    void detectBridgePlatformKey().then((platformKey) => {
      if (!cancelled) setDetectedPlatformKey(platformKey)
    })
    return () => { cancelled = true }
  }, [])
  const realBridgeDownloads = downloadsQuery.data?.downloads ?? []
  // In dev, fall back to a placeholder set so the install UI is visible even
  // when no real bridge build is published.
  const bridgeDownloads = realBridgeDownloads.length > 0
    ? realBridgeDownloads
    : (getBrowserEnv().devMode ? placeholderBridgeDownloads() : [])
  const bridges = bridgesQuery.data?.bridges ?? []
  // The origin a bridge registers with is this PrintStream server's public URL,
  // i.e. the site the operator is viewing now — pre-fill the Docker snippet with it.
  const bridgeServerUrl = typeof window !== 'undefined' ? window.location.origin : 'https://your-server.example.com'
  const listError = bridgesQuery.error ? extractErrorMessage(bridgesQuery.error) : null

  const openConnectDialog = () => {
    setInitialConnectCode(null)
    setConnectOpen(true)
  }

  return (
    <Stack spacing={1.5}>
      <Alert color="neutral" variant="soft" startDecorator={<InfoOutlinedIcon />}>
        <Stack spacing={0.75} alignItems="flex-start">
          <Stack spacing={0.25}>
            <Typography level="title-sm">What a bridge does</Typography>
            <Typography level="body-sm">
              A bridge links the printers on your local network to PrintStream and stores your library
              files. Because it owns that connection and your files, it needs to stay running on an
              always-on machine near your printers — any computer that stays powered on works.
            </Typography>
          </Stack>
          <ConnectivityGuideButton />
        </Stack>
      </Alert>

      <Box>
        <Typography level="title-md">Install a bridge</Typography>
        <Typography level="body-sm" textColor="text.tertiary">
          Run the bridge on a computer near your printers — install a native build or run it with Docker.
          It shows a connect code once it starts.
        </Typography>
      </Box>
      <BridgeInstallCard
        downloads={bridgeDownloads}
        detectedPlatformKey={detectedPlatformKey}
        serverUrl={bridgeServerUrl}
      />

      <Stack direction="row" spacing={1} alignItems="flex-start" justifyContent="space-between">
        <Box sx={{ minWidth: 0 }}>
          <Typography level="title-md">Bridges</Typography>
          <Typography level="body-sm" textColor="text.tertiary">
            Review connected bridges and keep their names clear for library and printer routing.
          </Typography>
        </Box>
        <Button size="sm" startDecorator={<AddRoundedIcon />} onClick={openConnectDialog} sx={{ flexShrink: 0 }}>
          Connect a bridge
        </Button>
      </Stack>

      {listError && <Alert color="danger">{listError}</Alert>}
      {!listError && bridges.length === 0 ? (
        <Alert color="neutral">No bridges are connected yet. Use “Connect a bridge” with the code your bridge shows.</Alert>
      ) : (
        <Stack spacing={1}>
          {bridges.map((bridge) => (
            <BridgeSettingsRow key={bridge.id} bridge={bridge} />
          ))}
        </Stack>
      )}

      {connectOpen && (
        <ConnectBridgeDialog initialCode={initialConnectCode} onClose={() => setConnectOpen(false)} />
      )}
    </Stack>
  )
}

/** Modal form for pairing a bridge by its connect code. */
function ConnectBridgeDialog({ initialCode, onClose }: { initialCode: string | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [connectCode, setConnectCode] = React.useState(initialCode ?? '')
  const [bridgeName, setBridgeName] = React.useState('')
  const connectBridge = useMutation({
    mutationFn: () => apiFetch<BridgeResponse>('/api/bridges/connect', {
      method: 'POST',
      body: {
        connectCode: connectCode.trim(),
        ...(bridgeName.trim() ? { name: bridgeName.trim() } : {})
      }
    }),
    onSuccess: async () => {
      await invalidateBridgeQueries(queryClient)
      onClose()
    }
  })
  const connectError = connectBridge.error ? extractErrorMessage(connectBridge.error) : null

  return (
    <BackAwareModal open onClose={onClose}>
      <ScrollableModalDialog sx={{ width: { xs: '100%', sm: 460 } }}>
        <DialogTitle>Connect a bridge</DialogTitle>
        <ScrollableDialogBody sx={{ mt: 1, p: 0 }}>
          <Stack spacing={1.25}>
            <Typography level="body-sm" textColor="text.tertiary">
              Enter the connect code shown by the bridge, then give it a clear name.
            </Typography>
            {initialCode && (
              <Alert color="primary" variant="soft">
                We filled in the connect code from your bridge link. Add a name if you like, then connect.
              </Alert>
            )}
            <FormControl>
              <FormLabel>Connect code</FormLabel>
              <Input
                autoFocus={!initialCode}
                value={connectCode}
                onChange={(event) => setConnectCode(event.target.value)}
              />
            </FormControl>
            <FormControl>
              <FormLabel>Bridge name</FormLabel>
              <Input
                autoFocus={Boolean(initialCode)}
                value={bridgeName}
                onChange={(event) => setBridgeName(event.target.value)}
                placeholder="Optional label"
              />
            </FormControl>
            {connectError && <Alert color="danger">{connectError}</Alert>}
          </Stack>
        </ScrollableDialogBody>
        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1.5 }}>
          <Button variant="plain" color="neutral" onClick={onClose}>Cancel</Button>
          <Button
            loading={connectBridge.isPending}
            disabled={!connectCode.trim()}
            onClick={() => connectBridge.mutate()}
          >
            Connect bridge
          </Button>
        </Stack>
      </ScrollableModalDialog>
    </BackAwareModal>
  )
}

const BRIDGE_UPDATE_ATTENTION_STATUSES = new Set<string>([
  'updateAvailable',
  'updateRequired',
  'updateHeldBack',
  'imageUpdateRequired',
  'runnerUpdateRequired'
])

/** Compact bridge summary; the full details and actions live in a Manage dialog. */
function BridgeSettingsRow({ bridge }: { bridge: BridgeSummary }) {
  const [detailsOpen, setDetailsOpen] = React.useState(false)
  const online = bridge.connectionStats.connected
  const needsUpdate = BRIDGE_UPDATE_ATTENTION_STATUSES.has(bridge.update.status)
  const crashChip = bridgeCrashChip(bridge.crash)
  const printerLabel = bridge.printerCount === 1 ? '1 printer' : `${bridge.printerCount} printers`
  return (
    <>
      <Card variant="outlined">
        <CardContent>
          <Stack direction="row" spacing={1.5} alignItems="center" justifyContent="space-between">
            <Stack direction="row" spacing={1.5} alignItems="center" sx={{ minWidth: 0 }}>
              <HubRoundedIcon />
              <Stack sx={{ minWidth: 0 }}>
                <Typography level="title-sm" noWrap>{bridge.name}</Typography>
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.25 }}>
                  <Chip size="sm" variant="soft" color={online ? 'success' : 'neutral'}>
                    {online ? 'Online' : 'Offline'}
                  </Chip>
                  <Chip size="sm" variant="soft" color="neutral">{printerLabel}</Chip>
                  {needsUpdate && <Chip size="sm" variant="soft" color="primary">Update available</Chip>}
                  {crashChip && <Chip size="sm" variant="soft" color={crashChip.color}>{crashChip.label}</Chip>}
                </Stack>
              </Stack>
            </Stack>
            <Button size="sm" variant="outlined" onClick={() => setDetailsOpen(true)} sx={{ flexShrink: 0 }}>
              Manage
            </Button>
          </Stack>
        </CardContent>
      </Card>
      {detailsOpen && <BridgeDetailsDialog bridge={bridge} onClose={() => setDetailsOpen(false)} />}
    </>
  )
}

/** Compact label/value pair used in the bridge details grid. */
function BridgeDetail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography level="body-xs" textColor="text.tertiary">{label}</Typography>
      <Typography level="body-sm" sx={{ wordBreak: 'break-word' }}>{value}</Typography>
    </Box>
  )
}

/** Manage dialog: rename, full status/build details, and maintenance actions. */
function BridgeDetailsDialog({ bridge, onClose }: { bridge: BridgeSummary; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = React.useState(bridge.name)
  const [removeOpen, setRemoveOpen] = React.useState(false)
  const [logsOpen, setLogsOpen] = React.useState(false)
  const [lastTestResult, setLastTestResult] = React.useState<BridgeTestResponse | null>(null)
  const [lastUpdateResult, setLastUpdateResult] = React.useState<BridgeUpdateActionResponse | null>(null)
  const renameBridge = useMutation({
    mutationFn: () => apiFetch<BridgeResponse>(`/api/bridges/${encodeURIComponent(bridge.id)}`, {
      method: 'PATCH',
      body: { name: name.trim() }
    }),
    onSuccess: async () => {
      await invalidateBridgeQueries(queryClient)
    }
  })
  const removeBridge = useMutation({
    mutationFn: () => apiFetch<void>(`/api/bridges/${encodeURIComponent(bridge.id)}`, {
      method: 'DELETE'
    }),
    onSuccess: async () => {
      setRemoveOpen(false)
      await invalidateBridgeQueries(queryClient)
      onClose()
    }
  })
  const testBridge = useMutation({
    mutationFn: () => apiFetch<BridgeTestResponse>(`/api/bridges/${encodeURIComponent(bridge.id)}/test`, {
      method: 'POST'
    }),
    onSuccess: async (result) => {
      setLastTestResult(result)
      await invalidateBridgeQueries(queryClient)
    }
  })
  const checkBridgeUpdate = useMutation({
    mutationFn: () => apiFetch<BridgeUpdateActionResponse>(`/api/bridges/${encodeURIComponent(bridge.id)}/update/check`, {
      method: 'POST'
    }),
    onSuccess: async (result) => {
      setLastUpdateResult(result)
      await invalidateBridgeQueries(queryClient)
    }
  })
  const startBridgeUpdate = useMutation({
    mutationFn: () => apiFetch<BridgeUpdateActionResponse>(`/api/bridges/${encodeURIComponent(bridge.id)}/update/start`, {
      method: 'POST'
    }),
    onSuccess: async (result) => {
      setLastUpdateResult(result)
      await invalidateBridgeQueries(queryClient)
    }
  })
  const startCapture = useMutation({
    mutationFn: () => apiFetch<BridgeDebugCaptureStatus>(`/api/bridges/${encodeURIComponent(bridge.id)}/debug-capture/start`, {
      method: 'POST',
      body: {}
    }),
    onSuccess: async () => {
      await invalidateBridgeQueries(queryClient)
    }
  })
  const stopCapture = useMutation({
    mutationFn: () => apiFetch<BridgeDebugCaptureStatus>(`/api/bridges/${encodeURIComponent(bridge.id)}/debug-capture/stop`, {
      method: 'POST'
    }),
    onSuccess: async () => {
      await invalidateBridgeQueries(queryClient)
    }
  })
  const renameError = renameBridge.error ? extractErrorMessage(renameBridge.error) : null
  const testError = testBridge.error ? extractErrorMessage(testBridge.error) : null
  const captureError = startCapture.error
    ? extractErrorMessage(startCapture.error)
    : stopCapture.error
      ? extractErrorMessage(stopCapture.error)
      : null
  const capture = bridge.debugCapture
  const updateError = checkBridgeUpdate.error
    ? extractErrorMessage(checkBridgeUpdate.error)
    : startBridgeUpdate.error
      ? extractErrorMessage(startBridgeUpdate.error)
      : null
  const removeError = removeBridge.error ? extractErrorMessage(removeBridge.error) : null
  const online = bridge.connectionStats.connected
  const crashChip = bridgeCrashChip(bridge.crash)
  const lastCrashLabel = bridge.crash.lastCrashAt ? new Date(bridge.crash.lastCrashAt).toLocaleString() : null
  const lastSeenLabel = bridge.lastSeenAt ? new Date(bridge.lastSeenAt).toLocaleString() : 'Not seen yet'
  const connectedAtLabel = bridge.connectionStats.connectedAt ? new Date(bridge.connectionStats.connectedAt).toLocaleString() : null
  const updateStatusLabel = formatBridgeUpdateStatus(bridge.update.status)
  const needsUpdate = BRIDGE_UPDATE_ATTENTION_STATUSES.has(bridge.update.status)
  const currentBuildName = bridge.update.currentBuildRevision ?? bridge.update.currentReleaseFingerprint?.slice(0, 12) ?? null
  const latestBuildName = bridge.update.latestBuildRevision ?? bridge.update.latestReleaseFingerprint?.slice(0, 12) ?? null
  const showsLatestBuild = Boolean(latestBuildName) && bridge.update.latestReleaseFingerprint !== bridge.update.currentReleaseFingerprint
  const latestBuildValue = latestBuildName
    ? `${latestBuildName.slice(0, 12)}${bridge.update.latestReleasedAt ? ` (${new Date(bridge.update.latestReleasedAt).toLocaleDateString()})` : ''}`
    : null
  const lastTestLabel = lastTestResult
    ? `Bridge responded in ${lastTestResult.responseTimeMs} ms at ${new Date(lastTestResult.respondedAt).toLocaleString()}.`
    : null
  const lastUpdateLabel = lastUpdateResult?.message ?? null
  const updateActionPending = checkBridgeUpdate.isPending || startBridgeUpdate.isPending
  const bridgeActionPending = renameBridge.isPending || removeBridge.isPending || testBridge.isPending || updateActionPending
  const canStartBridgeUpdate = bridge.update.status !== 'current' &&
    bridge.update.status !== 'imageUpdateRequired' &&
    bridge.update.status !== 'runnerUpdateRequired'
  const printerLabel = bridge.printerCount === 1 ? '1 printer' : `${bridge.printerCount} printers`
  const attachedPrinterLabel = bridge.printerCount === 1 ? '1 attached printer will be unassigned.' : `${bridge.printerCount} attached printers will be unassigned.`

  return (
    <>
      <BackAwareModal open onClose={onClose}>
        <ScrollableModalDialog sx={{ width: { xs: '100%', sm: 520 } }}>
          <DialogTitle>{bridge.name}</DialogTitle>
          <ScrollableDialogBody sx={{ mt: 1, p: 0 }}>
            <Stack spacing={1.5}>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                <Chip size="sm" variant="soft" color={online ? 'success' : 'neutral'}>{online ? 'Online' : 'Offline'}</Chip>
                <Chip size="sm" variant="soft" color="neutral">{printerLabel}</Chip>
                <Chip size="sm" variant="soft" color={needsUpdate ? 'primary' : 'neutral'}>{updateStatusLabel}</Chip>
                {crashChip && <Chip size="sm" variant="soft" color={crashChip.color}>{crashChip.label}</Chip>}
              </Stack>

              {crashChip && (
                <Alert color={crashChip.color} variant="soft" startDecorator={<WarningRoundedIcon />}>
                  <Stack sx={{ minWidth: 0 }}>
                    <Typography level="title-sm">
                      {crashChip.label === 'Crash-looping' ? 'This bridge is crash-looping' : 'This bridge recently crashed'}
                    </Typography>
                    <Typography level="body-sm">
                      {bridge.crash.recentCrashCount} crash{bridge.crash.recentCrashCount === 1 ? '' : 'es'} in the last hour
                      {lastCrashLabel ? `, most recently ${lastCrashLabel}` : ''}. Check the bridge machine and its logs.
                    </Typography>
                    {bridge.crash.lastReason && (
                      <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5, wordBreak: 'break-word' }}>
                        {bridge.crash.lastReason}
                      </Typography>
                    )}
                  </Stack>
                </Alert>
              )}

              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'stretch', sm: 'flex-end' }}>
                <FormControl sx={{ flex: 1 }}>
                  <FormLabel>Bridge name</FormLabel>
                  <Input value={name} onChange={(event) => setName(event.target.value)} disabled={removeBridge.isPending} />
                </FormControl>
                <Button
                  variant="outlined"
                  loading={renameBridge.isPending}
                  disabled={removeBridge.isPending || !name.trim() || name.trim() === bridge.name}
                  onClick={() => renameBridge.mutate()}
                >
                  Save name
                </Button>
              </Stack>

              <Divider />

              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, columnGap: 2, rowGap: 1 }}>
                <BridgeDetail label="Printers attached" value={bridge.printerCount} />
                <BridgeDetail label="Last seen" value={lastSeenLabel} />
                <BridgeDetail label="Build" value={currentBuildName ?? 'Unknown'} />
                {showsLatestBuild && latestBuildValue && <BridgeDetail label="Latest build" value={latestBuildValue} />}
                <BridgeDetail label="Runner" value={bridge.update.runnerAbiVersion ?? 'Unknown'} />
                <BridgeDetail label="Protocol" value={bridge.update.protocolVersion ?? 'Unknown'} />
                {connectedAtLabel && <BridgeDetail label="Connected since" value={connectedAtLabel} />}
                <BridgeDetail label="Pending RPCs" value={bridge.connectionStats.pendingRpcCount} />
                <BridgeDetail label="Camera watches" value={bridge.connectionStats.activeCameraWatchCount} />
                <BridgeDetail label="Active transfers" value={bridge.connectionStats.activePrinterFtpCount} />
                {lastCrashLabel && <BridgeDetail label="Last crash" value={lastCrashLabel} />}
                {bridge.crash.recentCrashCount > 0 && <BridgeDetail label="Recent crashes (1h)" value={bridge.crash.recentCrashCount} />}
              </Box>

              <Divider />

              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} flexWrap="wrap" useFlexGap>
                <Button
                  variant="outlined"
                  loading={testBridge.isPending}
                  disabled={renameBridge.isPending || removeBridge.isPending}
                  onClick={() => {
                    testBridge.reset()
                    testBridge.mutate()
                  }}
                >
                  Test bridge
                </Button>
                <Button
                  variant="outlined"
                  startDecorator={<ArticleRoundedIcon />}
                  disabled={!online || bridgeActionPending}
                  onClick={() => setLogsOpen(true)}
                >
                  View logs
                </Button>
                {/* One button: check for updates until one is found, then update.
                    There's nothing to update until a check confirms one, so the
                    action flips to "Update bridge" only once an applicable update
                    is known. */}
                {canStartBridgeUpdate ? (
                  <Button
                    variant="outlined"
                    loading={startBridgeUpdate.isPending}
                    disabled={bridgeActionPending}
                    onClick={() => {
                      startBridgeUpdate.reset()
                      checkBridgeUpdate.reset()
                      startBridgeUpdate.mutate()
                    }}
                  >
                    Update bridge
                  </Button>
                ) : (
                  <Button
                    variant="outlined"
                    loading={checkBridgeUpdate.isPending}
                    disabled={bridgeActionPending}
                    onClick={() => {
                      checkBridgeUpdate.reset()
                      startBridgeUpdate.reset()
                      checkBridgeUpdate.mutate()
                    }}
                  >
                    Check for updates
                  </Button>
                )}
              </Stack>

              <Divider />

              <Stack spacing={1}>
                <Box>
                  <Typography level="title-sm">Debug traffic capture</Typography>
                  <Typography level="body-xs" textColor="text.tertiary">
                    Record this bridge’s MQTT, FTPS, and camera traffic to a downloadable log for troubleshooting. A reminder appears across the app while a capture runs.
                  </Typography>
                </Box>
                {capture.active && (
                  <Typography level="body-xs">
                    Recording… {capture.frameCount.toLocaleString()} frame{capture.frameCount === 1 ? '' : 's'} captured
                    {capture.droppedFrames > 0 ? ` (${capture.droppedFrames.toLocaleString()} dropped)` : ''}
                    {capture.truncated ? ' — size limit reached' : ''}.
                  </Typography>
                )}
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} flexWrap="wrap" useFlexGap>
                  {capture.active ? (
                    <Button
                      variant="outlined"
                      color="primary"
                      loading={stopCapture.isPending}
                      disabled={bridgeActionPending}
                      onClick={() => {
                        stopCapture.reset()
                        stopCapture.mutate()
                      }}
                    >
                      Stop capture
                    </Button>
                  ) : (
                    <Button
                      variant="outlined"
                      loading={startCapture.isPending}
                      disabled={!online || bridgeActionPending}
                      onClick={() => {
                        startCapture.reset()
                        startCapture.mutate()
                      }}
                    >
                      Start capture
                    </Button>
                  )}
                  <Button
                    variant="outlined"
                    color="neutral"
                    component="a"
                    href={buildApiUrl(`/api/bridges/${encodeURIComponent(bridge.id)}/debug-capture/download`)}
                    download={`traffic-${bridge.name}.jsonl`}
                    disabled={!online || !capture.hasCapture}
                  >
                    Download capture
                  </Button>
                </Stack>
              </Stack>

              {captureError && <Alert color="danger">{captureError}</Alert>}
              {renameError && <Alert color="danger">{renameError}</Alert>}
              {testError && <Alert color="danger">{testError}</Alert>}
              {updateError && <Alert color="danger">{updateError}</Alert>}
              {bridge.update.lastError && <Alert color="warning">{bridge.update.lastError}</Alert>}
              {bridge.update.manualUpdateCommand && <Alert color="warning">Manual bridge update required: {bridge.update.manualUpdateCommand}</Alert>}
              {lastTestLabel && <Alert color="success">{lastTestLabel}</Alert>}
              {lastUpdateLabel && <Alert color="neutral">{lastUpdateLabel}</Alert>}
            </Stack>
          </ScrollableDialogBody>
          <Stack direction="row" spacing={1} justifyContent="space-between" alignItems="center" sx={{ pt: 1.5 }}>
            <Button
              variant="outlined"
              color="danger"
              disabled={bridgeActionPending}
              onClick={() => {
                removeBridge.reset()
                setRemoveOpen(true)
              }}
            >
              Remove bridge
            </Button>
            <Button variant="plain" color="neutral" onClick={onClose}>Close</Button>
          </Stack>
        </ScrollableModalDialog>
      </BackAwareModal>

      <ConfirmActionDialog
        open={removeOpen}
        title={`Remove ${bridge.name}?`}
        description={(
          <Stack spacing={1}>
            <Typography level="body-sm">
              Remove this bridge from the workspace. You can reconnect it later with its connect code.
            </Typography>
            {bridge.printerCount > 0 && (
              <Typography level="body-sm" textColor="text.tertiary">
                {attachedPrinterLabel}
              </Typography>
            )}
          </Stack>
        )}
        confirmLabel="Remove bridge"
        pending={removeBridge.isPending}
        error={removeError}
        onClose={() => {
          removeBridge.reset()
          setRemoveOpen(false)
        }}
        onConfirm={() => removeBridge.mutate()}
      />

      {logsOpen && <BridgeLogsDialog bridge={bridge} onClose={() => setLogsOpen(false)} />}
    </>
  )
}

/** Bridge log level chip color, matching the Logs view conventions. */
function bridgeLogLevelColor(level: BridgeSystemLogEntry['level']): 'neutral' | 'warning' | 'danger' | 'primary' {
  switch (level) {
    case 'error': return 'danger'
    case 'warn': return 'warning'
    case 'debug': return 'neutral'
    default: return 'primary'
  }
}

/**
 * Live tail of the bridge's recent console output, fetched over the bridge RPC.
 * This is the only way to see bridge diagnostics on native builds, where the
 * console stream is otherwise hidden in an on-disk service log file.
 */
function BridgeLogsDialog({ bridge, onClose }: { bridge: BridgeSummary; onClose: () => void }) {
  const logsQuery = useQuery({
    queryKey: ['bridge-logs', bridge.id],
    queryFn: ({ signal }) => apiFetch<BridgeSystemLogsResult>(`/api/bridges/${encodeURIComponent(bridge.id)}/logs`, { signal }),
    refetchInterval: 5_000
  })
  // Newest-first for display; the RPC returns oldest-first.
  const ordered = React.useMemo(() => [...(logsQuery.data?.entries ?? [])].reverse(), [logsQuery.data])
  const loadError = logsQuery.error ? extractErrorMessage(logsQuery.error) : null

  return (
    <BackAwareModal open onClose={onClose}>
      <ScrollableModalDialog sx={{ width: { xs: '100%', sm: 640 } }}>
        <DialogTitle>{bridge.name} logs</DialogTitle>
        <ScrollableDialogBody sx={{ mt: 1, p: 0 }}>
          <Stack spacing={1.25}>
            <Stack direction="row" spacing={1} justifyContent="space-between" alignItems="center">
              <Typography level="body-sm" textColor="text.tertiary">
                Most recent {ordered.length} bridge log {ordered.length === 1 ? 'line' : 'lines'}. Refreshes every 5s.
              </Typography>
              <Button size="sm" variant="plain" loading={logsQuery.isFetching} onClick={() => logsQuery.refetch()}>
                Refresh
              </Button>
            </Stack>
            {loadError && <Alert color="danger">{loadError}</Alert>}
            {!loadError && ordered.length === 0 && (
              <Alert color="neutral">{logsQuery.isLoading ? 'Loading bridge logs…' : 'No bridge log entries yet.'}</Alert>
            )}
            {ordered.length > 0 && (
              <Sheet
                variant="outlined"
                sx={{ borderRadius: 'md', overflow: 'hidden', fontFamily: 'monospace', fontSize: 'xs' }}
              >
                <Stack divider={<Box sx={{ borderTop: '1px solid var(--joy-palette-neutral-800)' }} />}>
                  {ordered.map((entry, index) => (
                    <Stack key={`${entry.timestamp}-${index}`} spacing={0.5} sx={{ p: 1 }}>
                      <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                        <Typography level="body-xs" textColor="text.tertiary">{formatDateTime(entry.timestamp)}</Typography>
                        <Chip size="sm" variant="soft" color={bridgeLogLevelColor(entry.level)}>{entry.level}</Chip>
                      </Stack>
                      <Typography level="body-xs" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {entry.message}
                      </Typography>
                    </Stack>
                  ))}
                </Stack>
              </Sheet>
            )}
          </Stack>
        </ScrollableDialogBody>
        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1.5 }}>
          <Button variant="plain" color="neutral" onClick={onClose}>Close</Button>
        </Stack>
      </ScrollableModalDialog>
    </BackAwareModal>
  )
}
