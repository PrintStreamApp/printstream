/**
 * Download card for the standalone bridge packages. A single Download button
 * opens a menu of every package grouped by OS, with the one matching the
 * visitor's detected machine highlighted and flagged "Compatible with this
 * machine". Choosing a package opens an install dialog that carries the per-OS
 * instructions and the actual download button. Renders nothing when no packages
 * are published (e.g. self-hosted installs); a dev placeholder set can be passed
 * in to preview it.
 */
import { Box, Button, Card, CardContent, Chip, DialogTitle, Dropdown, IconButton, ListDivider, ListItem, Menu, MenuButton, MenuItem, Sheet, Stack, Typography } from '@mui/joy'
import React from 'react'
import ArrowDropDownRoundedIcon from '@mui/icons-material/ArrowDropDownRounded'
import CheckRoundedIcon from '@mui/icons-material/CheckRounded'
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded'
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded'
import type { BridgeStandaloneDownload } from '@printstream/shared'
import { bridgePlatformArchLabel, bridgePlatformLabel, groupByBridgeOs } from '../lib/bridgePlatform'
import { BackAwareModal } from './BackAwareModal'
import { ScrollableDialogBody, ScrollableModalDialog } from './ScrollableDialog'

export function BridgeDownloadsCard({ downloads, detectedPlatformKey }: {
  downloads: BridgeStandaloneDownload[]
  detectedPlatformKey: string | null
}) {
  const [selected, setSelected] = React.useState<BridgeStandaloneDownload | null>(null)
  if (downloads.length === 0) return null

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
          <Dropdown>
            <MenuButton
              variant="solid"
              color="primary"
              startDecorator={<DownloadRoundedIcon />}
              endDecorator={<ArrowDropDownRoundedIcon />}
            >
              Download
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
            </Menu>
          </Dropdown>
          <Typography level="body-sm" textColor="text.tertiary">Build {downloadBuildLabel(downloads[0]!)}</Typography>
        </Stack>
      </CardContent>

      {selected ? (
        <BridgeInstallDialog download={selected} onClose={() => setSelected(null)} />
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
  if (os === 'darwin') {
    return (
      <Stack spacing={0.5}>
        <Typography level="body-sm">
          Double-click the downloaded file to install. If macOS blocks it (unidentified developer),
          right-click the file and choose Open — or run:
        </Typography>
        <CommandBlock text={`xattr -d com.apple.quarantine ${fileName}`} />
      </Stack>
    )
  }
  return (
    <Stack spacing={0.5}>
      <Typography level="body-sm">
        In a terminal, in the folder you downloaded to, make it executable and run the installer:
      </Typography>
      <CommandBlock text={`chmod +x ${fileName}\nsudo ./${fileName} setup`} />
    </Stack>
  )
}

/** Monospace command block with a copy button. */
function CommandBlock({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false)
  const copy = () => {
    void navigator.clipboard?.writeText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }
  return (
    <Sheet variant="soft" sx={{ borderRadius: 'sm', p: 1, display: 'flex', gap: 1, alignItems: 'flex-start' }}>
      <Box
        component="pre"
        sx={{ m: 0, flex: 1, minWidth: 0, fontFamily: 'code', fontSize: 'sm', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
      >
        {text}
      </Box>
      <IconButton size="sm" variant="plain" color="neutral" onClick={copy} aria-label="Copy command">
        {copied ? <CheckRoundedIcon /> : <ContentCopyRoundedIcon />}
      </IconButton>
    </Sheet>
  )
}

function formatDownloadSize(sizeBytes: number): string {
  return `${Math.round(sizeBytes / (1024 * 1024))} MB`
}

function downloadBuildLabel(download: BridgeStandaloneDownload): string {
  const name = download.buildRevision ?? 'unknown'
  return `${name.slice(0, 12)} (${new Date(download.releasedAt).toLocaleDateString()})`
}
