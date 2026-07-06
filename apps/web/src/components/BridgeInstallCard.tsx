/**
 * Install card for the bridge. A single Install button opens a menu of every
 * native package grouped by OS — with the one matching the visitor's detected
 * machine highlighted and flagged "Compatible with this machine" — plus a "Run
 * with Docker" entry for users who prefer the published container image.
 * Choosing a native package opens a dialog with per-OS instructions and the
 * download button; choosing Docker opens the compose quick-start. Always renders
 * (Docker is available even with no published native packages, e.g. self-hosted
 * installs); a dev placeholder download set can be passed in to preview the
 * native packages.
 */
import { Button, Card, CardContent, Chip, DialogTitle, Dropdown, ListDivider, ListItem, Menu, MenuButton, MenuItem, Stack, Typography } from '@mui/joy'
import React from 'react'
import ArrowDropDownRoundedIcon from '@mui/icons-material/ArrowDropDownRounded'
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded'
import type { BridgeStandaloneDownload } from '@printstream/shared'
import { bridgePlatformArchLabel, bridgePlatformLabel, detectMacPlatform, groupByBridgeOs } from '../lib/bridgePlatform'
import { BackAwareModal } from './BackAwareModal'
import { BridgeDockerDialog } from './BridgeDockerDialog'
import { CopyableCodeBlock } from './CopyableCodeBlock'
import { ScrollableDialogBody, ScrollableModalDialog } from './ScrollableDialog'

export function BridgeInstallCard({ downloads, detectedPlatformKey, serverUrl }: {
  downloads: BridgeStandaloneDownload[]
  detectedPlatformKey: string | null
  serverUrl: string
}) {
  const [selected, setSelected] = React.useState<BridgeStandaloneDownload | null>(null)
  const [dockerOpen, setDockerOpen] = React.useState(false)
  const hasDownloads = downloads.length > 0
  const isMac = React.useMemo(() => typeof navigator !== 'undefined' && detectMacPlatform(navigator), [])

  return (
    <Card variant="outlined">
      <CardContent>
        {isMac ? (
          <Typography level="body-sm" textColor="text.tertiary" sx={{ mb: 1 }}>
            There is no native macOS build — run the bridge with Docker, or install it on an
            always-on Windows or Linux machine.
          </Typography>
        ) : null}
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
          <Dropdown>
            <MenuButton
              variant="solid"
              color="primary"
              startDecorator={<DownloadRoundedIcon />}
              endDecorator={<ArrowDropDownRoundedIcon />}
            >
              Install
            </MenuButton>
            <Menu placement="bottom-start">
              {groupByBridgeOs(downloads, (download) => download.platformKey).map((group, groupIndex) => (
                <React.Fragment key={group.os}>
                  {groupIndex > 0 ? <ListDivider /> : null}
                  <ListItem sticky>
                    <Typography level="body-xs" textColor="text.tertiary">{group.osLabel}</Typography>
                  </ListItem>
                  {group.items.map((download) => {
                    const isRecommended = download.platformKey === detectedPlatformKey
                    return (
                      <MenuItem
                        key={download.platformKey}
                        onClick={() => setSelected(download)}
                        aria-label={bridgePlatformLabel(download.platformKey)}
                        {...(isRecommended ? { color: 'primary' as const, variant: 'soft' as const } : {})}
                      >
                        {bridgePlatformArchLabel(download.platformKey)}
                        {isRecommended ? (
                          <Chip size="sm" variant="solid" color="primary" sx={{ ml: 1.5 }}>
                            Compatible with this machine
                          </Chip>
                        ) : null}
                      </MenuItem>
                    )
                  })}
                </React.Fragment>
              ))}
              {hasDownloads ? <ListDivider /> : null}
              <MenuItem onClick={() => setDockerOpen(true)}>Run with Docker</MenuItem>
            </Menu>
          </Dropdown>
          {hasDownloads ? (
            <Typography level="body-sm" textColor="text.tertiary">Build {downloadBuildLabel(downloads[0]!)}</Typography>
          ) : null}
        </Stack>
      </CardContent>

      {selected ? (
        <BridgeInstallDialog download={selected} onClose={() => setSelected(null)} />
      ) : null}
      {dockerOpen ? (
        <BridgeDockerDialog serverUrl={serverUrl} onClose={() => setDockerOpen(false)} />
      ) : null}
    </Card>
  )
}

/** Per-platform install steps and the actual download button. */
function BridgeInstallDialog({ download, onClose }: { download: BridgeStandaloneDownload; onClose: () => void }) {
  return (
    <BackAwareModal open onClose={onClose}>
      <ScrollableModalDialog sx={{ width: { xs: '100%', sm: 480 } }}>
        <DialogTitle>Install the bridge — {bridgePlatformLabel(download.platformKey)}</DialogTitle>
        <ScrollableDialogBody sx={{ mt: 1, p: 0 }}>
          <Stack spacing={1.25}>
            <Typography level="body-sm" textColor="text.tertiary">
              Build {downloadBuildLabel(download)} · {formatDownloadSize(download.sizeBytes)}
            </Typography>
            <BridgeInstallHint platformKey={download.platformKey} fileName={download.fileName} />
          </Stack>
        </ScrollableDialogBody>
        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1.5 }}>
          <Button variant="plain" color="neutral" onClick={onClose}>Close</Button>
          <Button
            component="a"
            href={download.url}
            download={download.fileName}
            startDecorator={<DownloadRoundedIcon />}
          >
            Download
          </Button>
        </Stack>
      </ScrollableModalDialog>
    </BackAwareModal>
  )
}

/** Post-download install guidance for one platform. */
function BridgeInstallHint({ platformKey, fileName }: { platformKey: string; fileName: string }) {
  const os = platformKey.split('-')[0]
  if (os === 'win32') {
    return (
      <Typography level="body-sm">
        Double-click the downloaded file to install (approve the administrator prompt).
      </Typography>
    )
  }
  return (
    <Stack spacing={0.5}>
      <Typography level="body-sm">
        In a terminal, in the folder you downloaded to, make it executable and run the installer:
      </Typography>
      <CopyableCodeBlock text={`chmod +x ${fileName}\nsudo ./${fileName} setup`} copyAriaLabel="Copy command" />
    </Stack>
  )
}

function formatDownloadSize(sizeBytes: number): string {
  return `${Math.round(sizeBytes / (1024 * 1024))} MB`
}

function downloadBuildLabel(download: BridgeStandaloneDownload): string {
  const name = download.buildRevision ?? 'unknown'
  return `${name.slice(0, 12)} (${new Date(download.releasedAt).toLocaleDateString()})`
}
