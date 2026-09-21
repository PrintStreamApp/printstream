/** Download picker shared by hosted and self-hosted browser clients. */
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded'
import { Alert, Button, Chip, DialogTitle, Divider, Stack, Typography } from '@mui/joy'
import {
  nativeAppDownloadsResponseSchema,
  type NativeAppDownload,
  type NativeAppDownloadsResponse
} from '@printstream/shared'
import { useQuery } from '@tanstack/react-query'
import React from 'react'
import { BackAwareModal } from './BackAwareModal'
import { ScrollableDialogBody, ScrollableModalDialog } from './ScrollableDialog'
import { detectClientPlatformKey, isRecommendedPlatform } from '../lib/bridgePlatform'

const HOSTED_CATALOGUE_URL = 'https://printstream.app/api/native-app/downloads'
const OS_LABELS: Record<string, string> = {
  android: 'Android',
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux'
}
const OS_ORDER = ['android', 'win32', 'darwin', 'linux']

interface NativeAppDownloadsDialogProps {
  open: boolean
  onClose: () => void
  /** Self-hosted clients read the public catalogue from the hosted service. */
  useHostedCatalogue: boolean
}

/** Shows every published app package while highlighting the closest device match. */
export function NativeAppDownloadsDialog({
  open,
  onClose,
  useHostedCatalogue
}: NativeAppDownloadsDialogProps) {
  const [detectedPlatform, setDetectedPlatform] = React.useState<string | null>(null)
  const catalogueUrl = useHostedCatalogue ? HOSTED_CATALOGUE_URL : '/api/native-app/downloads'
  const query = useQuery({
    queryKey: ['native-app-downloads', catalogueUrl],
    queryFn: ({ signal }) => fetchCatalogue(catalogueUrl, signal),
    enabled: open,
    staleTime: 60_000
  })

  React.useEffect(() => {
    if (!open) return
    let active = true
    void detectClientPlatformKey().then((value) => { if (active) setDetectedPlatform(value) })
    return () => { active = false }
  }, [open])

  if (!open) return null
  const groups = groupDownloads(query.data?.downloads ?? [], detectedPlatform)

  return (
    <BackAwareModal open onClose={onClose}>
      <ScrollableModalDialog sx={{ width: { xs: '100%', sm: 620 } }}>
        <DialogTitle>Download the PrintStream app</DialogTitle>
        <ScrollableDialogBody sx={{ mt: 1, p: 0 }}>
          <Stack spacing={2}>
            <Typography level="body-sm" textColor="text.tertiary">
              Keep PrintStream close at hand with an experience designed for your device and native print notifications. The app also browses MakerWorld and Printables, handles security checks, and captures models directly into your library.
            </Typography>
            {query.isError ? (
              <Alert color="danger" variant="soft">Could not load the app downloads. Try again shortly.</Alert>
            ) : null}
            {query.isPending ? <Typography level="body-sm">Loading downloads…</Typography> : null}
            {groups.map((group, groupIndex) => (
              <Stack key={group.os} spacing={1}>
                {groupIndex > 0 ? <Divider /> : null}
                <Typography level="title-sm">{OS_LABELS[group.os] ?? group.os}</Typography>
                {group.items.map((download) => {
                  const recommended = isPreferredDownload(download, detectedPlatform)
                  const helpText = downloadHelpText(download)
                  return (
                    <Stack
                      key={`${download.platformKey}:${download.format}`}
                      direction={{ xs: 'column', sm: 'row' }}
                      spacing={1}
                      alignItems={{ sm: 'center' }}
                      justifyContent="space-between"
                    >
                      <Stack spacing={0.25} sx={{ minWidth: 0 }}>
                        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                          <Typography level="body-sm">
                            {download.label} · {download.format}{download.sizeBytes == null ? '' : ` · ${formatSize(download.sizeBytes)}`}
                          </Typography>
                          {recommended ? <Chip size="sm" color="primary" variant="soft">Recommended</Chip> : null}
                        </Stack>
                        {helpText ? (
                          <Typography level="body-xs" textColor="text.tertiary">{helpText}</Typography>
                        ) : null}
                      </Stack>
                      <Button
                        component="a"
                        href={download.url}
                        target="_blank"
                        rel="noreferrer"
                        {...(download.fileName ? { download: download.fileName } : {})}
                        size="sm"
                        variant={recommended ? 'solid' : 'outlined'}
                        color={recommended ? 'primary' : 'neutral'}
                        startDecorator={<DownloadRoundedIcon />}
                        sx={{ flexShrink: 0 }}
                      >
                        {download.fileName ? 'Download' : 'Open store'}
                      </Button>
                    </Stack>
                  )
                })}
              </Stack>
            ))}
            {query.data?.downloads.some((download) => download.fileName != null) ? (
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                <Typography level="body-xs" textColor="text.tertiary">
                  Direct download links expire after a few minutes.
                </Typography>
                <Button size="sm" variant="plain" color="neutral" loading={query.isFetching} onClick={() => { void query.refetch() }}>
                  Refresh links
                </Button>
              </Stack>
            ) : null}
            {!query.isPending && !query.isError && groups.length === 0 ? (
              <Typography level="body-sm" textColor="text.tertiary">No app downloads are published yet.</Typography>
            ) : null}
          </Stack>
        </ScrollableDialogBody>
        <Stack direction="row" justifyContent="flex-end" sx={{ pt: 1.5 }}>
          <Button variant="plain" color="neutral" onClick={onClose}>Close</Button>
        </Stack>
      </ScrollableModalDialog>
    </BackAwareModal>
  )
}

/** Prefer the portable AppImage when Linux distro details are unavailable. */
function isPreferredDownload(download: NativeAppDownload, detectedPlatform: string | null): boolean {
  if (!isRecommendedPlatform(download.platformKey, detectedPlatform)) return false
  if (!download.platformKey.startsWith('linux-')) return true
  return download.format === 'AppImage'
}

function downloadHelpText(download: NativeAppDownload): string | null {
  if (download.format === 'AppImage') {
    return 'Works on most desktop Linux distributions. In file Properties, allow executing as a program, then double-click it.'
  }
  if (download.format === 'Debian package') {
    return 'Best for Ubuntu, Debian, and Linux Mint. Double-click it to open your graphical software installer.'
  }
  return null
}

async function fetchCatalogue(url: string, signal: AbortSignal): Promise<NativeAppDownloadsResponse> {
  const response = await fetch(url, { signal, credentials: 'omit' })
  if (!response.ok) throw new Error(`App download catalogue failed: ${response.status}`)
  return nativeAppDownloadsResponseSchema.parse(await response.json())
}

function groupDownloads(downloads: NativeAppDownload[], detectedPlatform: string | null) {
  const sorted = [...downloads].sort((a, b) => {
    const recommended = Number(isRecommendedPlatform(b.platformKey, detectedPlatform))
      - Number(isRecommendedPlatform(a.platformKey, detectedPlatform))
    if (recommended !== 0) return recommended
    const osA = a.platformKey.split('-')[0] ?? ''
    const osB = b.platformKey.split('-')[0] ?? ''
    return OS_ORDER.indexOf(osA) - OS_ORDER.indexOf(osB)
      || a.platformKey.localeCompare(b.platformKey)
      || a.format.localeCompare(b.format)
  })
  const groups: Array<{ os: string; items: NativeAppDownload[] }> = []
  for (const download of sorted) {
    const os = download.platformKey.split('-')[0] ?? 'other'
    let group = groups.find((candidate) => candidate.os === os)
    if (!group) {
      group = { os, items: [] }
      groups.push(group)
    }
    group.items.push(download)
  }
  return groups
}

function formatSize(bytes: number): string {
  const mib = bytes / (1024 * 1024)
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)} GB` : `${Math.round(mib)} MB`
}
