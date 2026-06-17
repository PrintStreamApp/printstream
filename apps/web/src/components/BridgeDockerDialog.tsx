/**
 * Docker quick-start modal for the bridge, for users who would rather run the
 * published container image than a native build. Shows a copy-paste compose
 * file (with BRIDGE_SERVER_URL pre-filled to this PrintStream server's origin)
 * and the command to start it. The full, commented example lives at the repo
 * root in compose.bridge.example.yml; this is the condensed get-running form.
 */
import { Button, DialogTitle, Stack, Typography } from '@mui/joy'
import React from 'react'
import { BackAwareModal } from './BackAwareModal'
import { CopyableCodeBlock } from './CopyableCodeBlock'
import { ScrollableDialogBody, ScrollableModalDialog } from './ScrollableDialog'

const BRIDGE_IMAGE = 'ghcr.io/printstreamapp/printstream-bridge:latest'

/** Build the quick-start compose.yml with the given server origin filled in. */
function bridgeComposeSnippet(serverUrl: string): string {
  return [
    'services:',
    '  bridge:',
    `    image: ${BRIDGE_IMAGE}`,
    '    restart: unless-stopped',
    '    network_mode: host  # optional — see note below',
    '    environment:',
    `      BRIDGE_SERVER_URL: ${serverUrl}`,
    '      BRIDGE_NAME: PrintStream Bridge',
    '    volumes:',
    '      - printstream-bridge-data:/data',
    '',
    'volumes:',
    '  printstream-bridge-data:',
    ''
  ].join('\n')
}

export function BridgeDockerDialog({ serverUrl, onClose }: { serverUrl: string; onClose: () => void }) {
  return (
    <BackAwareModal open onClose={onClose}>
      <ScrollableModalDialog sx={{ width: { xs: '100%', sm: 640 } }}>
        <DialogTitle>Run the bridge with Docker</DialogTitle>
        <ScrollableDialogBody sx={{ mt: 1, p: 0 }}>
          <Stack spacing={1.25}>
            <Typography level="body-sm" textColor="text.tertiary">
              Run the published image with Docker Compose. Save this as
              {' '}<Typography component="code" level="body-sm">compose.yml</Typography> on a machine near your printers:
            </Typography>
            <CopyableCodeBlock text={bridgeComposeSnippet(serverUrl)} copyAriaLabel="Copy compose file" />
            <Typography level="body-sm" textColor="text.tertiary">
              <Typography component="code" level="body-sm">network_mode: host</Typography> is optional. It lets the
              bridge auto-discover printers on your LAN (SSDP) without extra Docker multicast setup — the bridge is
              outbound-only and publishes no ports of its own. Without it the bridge still works; you just add
              printers by IP address instead.
            </Typography>
            <Typography level="body-sm">Then start it from that folder:</Typography>
            <CopyableCodeBlock text="docker compose up -d" copyAriaLabel="Copy command" />
            <Typography level="body-sm" textColor="text.tertiary">
              On first start the bridge prints a connect code in its logs
              {' '}(<Typography component="code" level="body-sm">docker compose logs bridge</Typography>). Use
              {' '}&ldquo;Connect a bridge&rdquo; to pair it.
            </Typography>
            <Typography level="body-sm">To update the bridge later, pull the latest image and restart:</Typography>
            <CopyableCodeBlock text="docker compose pull && docker compose up -d" copyAriaLabel="Copy command" />
          </Stack>
        </ScrollableDialogBody>
        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1.5 }}>
          <Button variant="plain" color="neutral" onClick={onClose}>Close</Button>
        </Stack>
      </ScrollableModalDialog>
    </BackAwareModal>
  )
}
