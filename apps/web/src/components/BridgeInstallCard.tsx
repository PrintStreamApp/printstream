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
import { Alert, Button, Card, CardContent, Chip, DialogTitle, Dropdown, ListDivider, ListItem, Menu, MenuButton, MenuItem, Stack, Typography } from '@mui/joy'
import React from 'react'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import ArrowDropDownRoundedIcon from '@mui/icons-material/ArrowDropDownRounded'
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded'
import type { BridgeStandaloneDownload } from '@printstream/shared'
import { bridgePlatformArchLabel, bridgePlatformLabel, detectMacPlatform, groupByBridgeOs } from '../lib/bridgePlatform'
import { BackAwareModal } from './BackAwareModal'
import { BridgeDockerDialog } from './BridgeDockerDialog'
import { CopyableCodeBlock } from './CopyableCodeBlock'
import { ScrollableDialogBody, ScrollableModalDialog } from './ScrollableDialog'

export function BridgeInstallCard({ downloads, detectedPlatformKey, serverUrl, serverUrlOverride, unavailableReason }: {
  downloads: BridgeStandaloneDownload[]
  detectedPlatformKey: string | null
  serverUrl: string
  /**
   * Passed to the installer when this server is NOT the origin baked into the
   * executable; null on the cloud, where the binary is already correct.
   */
  serverUrlOverride: string | null
  /** Why there is nothing to download, when the reason is not "no build here". */
  unavailableReason: string | null
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
        {/* Says WHY rather than leaving an install menu with only Docker in it.
            A server whose promoted bridge is not its own would otherwise look
            like a product that ships no native installers. */}
        {unavailableReason ? (
          <Alert
            variant="soft"
            color="warning"
            startDecorator={<WarningAmberRoundedIcon />}
            sx={{ mt: 1 }}
          >
            {unavailableReason}
          </Alert>
        ) : null}
      </CardContent>

      {selected ? (
        <BridgeInstallDialog
          download={selected}
          serverUrlOverride={serverUrlOverride}
          onClose={() => setSelected(null)}
        />
      ) : null}
      {dockerOpen ? (
        <BridgeDockerDialog serverUrl={serverUrl} onClose={() => setDockerOpen(false)} />
      ) : null}
    </Card>
  )
}

/** Per-platform install steps and the actual download button. */
function BridgeInstallDialog({ download, serverUrlOverride, onClose }: {
  download: BridgeStandaloneDownload
  serverUrlOverride: string | null
  onClose: () => void
}) {
  return (
    <BackAwareModal open onClose={onClose}>
      <ScrollableModalDialog sx={{ width: { xs: '100%', sm: 480 } }}>
        <DialogTitle>Install the bridge — {bridgePlatformLabel(download.platformKey)}</DialogTitle>
        <ScrollableDialogBody sx={{ mt: 1, p: 0 }}>
          <Stack spacing={1.25}>
            <Typography level="body-sm" textColor="text.tertiary">
              Build {downloadBuildLabel(download)} · {formatDownloadSize(download.sizeBytes)}
            </Typography>
            <BridgeInstallHint
              platformKey={download.platformKey}
              fileName={download.fileName}
              serverUrlOverride={serverUrlOverride}
            />
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

/**
 * Post-download install guidance for one platform.
 *
 * `serverUrlOverride` changes the SHAPE of the Windows instruction, not just its
 * text: the executable bakes in the cloud origin, so a download from anywhere
 * else has to pass `--server-url`, and a double-click cannot. Left to the
 * ordinary instruction it would install successfully and register with the
 * cloud — a wrong outcome that reports itself as a right one.
 */
function BridgeInstallHint({ platformKey, fileName, serverUrlOverride }: {
  platformKey: string
  fileName: string
  serverUrlOverride: string | null
}) {
  const os = platformKey.split('-')[0]
  const serverUrlFlag = serverUrlOverride ? ` --server-url ${serverUrlOverride}` : ''

  if (os === 'win32') {
    return (
      <Stack spacing={0.5}>
        <Typography level="body-sm">
          Double-click the downloaded file to install (approve the administrator prompt).
        </Typography>
        {/* Where the code comes from, which the native path never said. The
            Docker dialog has always answered this ("...prints a connect code in
            its logs"); leaving it out here made the installer look like the end
            of the process. */}
        <Typography level="body-sm" textColor="text.tertiary">
          Setup shows a connect code when it finishes, and the bridge&rsquo;s tray icon shows it any time after
          that. Use &ldquo;Connect a bridge&rdquo; to pair it.
        </Typography>
        {/* The download's filename carries the server, and the installer reads
            it — so the ordinary double-click joins THIS server with nothing to
            type. (Windows' Mark of the Web is only a backstop: setup strips it
            before elevating, since SmartScreen refuses to elevate a marked exe,
            so it is gone by the second attempt.) The fallback is spelled out
            because the NAME is not guaranteed either — a browser appends " (1)"
            to a duplicate download, and users rename things — and a silent fall
            back to the cloud is exactly the confusion this flow exists to
            prevent. */}
        {serverUrlOverride ? (
          <>
            <Typography level="body-sm" textColor="text.tertiary">
              It joins this server automatically, from its filename — keep the name as downloaded.
              If it reports a different server, install from a terminal instead:
            </Typography>
            <CopyableCodeBlock text={`.\\${fileName} setup${serverUrlFlag}`} copyAriaLabel="Copy command" />
          </>
        ) : null}
      </Stack>
    )
  }

  return (
    <Stack spacing={0.5}>
      {/* No filename caveat here, unlike Windows: this command passes
          --server-url outright when it matters, so the name is just the name.
          The flag is kept rather than leaning on the stamped filename because
          the user is copying a command either way, and an explicit argument
          survives a rename the filename mechanism would not. */}
      <Typography level="body-sm">
        In a terminal, in the folder you downloaded to, make it executable and run the installer:
      </Typography>
      <CopyableCodeBlock
        text={`chmod +x ${fileName}\nsudo ./${fileName} setup${serverUrlFlag}`}
        copyAriaLabel="Copy command"
      />
      {/* The headless case, and the reason this text exists: a server with no
          desktop has no tray icon and no setup window, so the installer's own
          output scrolling past is the only time the code is ever shown unless
          the operator is told the command that reprints it. */}
      <Typography level="body-sm" textColor="text.tertiary">
        The installer prints a connect code when it finishes. To see it again later, on the bridge machine run:
      </Typography>
      <CopyableCodeBlock text="printstream-bridge status" copyAriaLabel="Copy command" />
      <Typography level="body-sm" textColor="text.tertiary">
        Then use &ldquo;Connect a bridge&rdquo; to pair it.
      </Typography>
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
