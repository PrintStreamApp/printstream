/**
 * Home Assistant settings panel.
 *
 * Rendered inside the Plugin Manager accordion for the home-assistant plugin.
 * Shows bridge status, install instructions, and Lovelace card examples — no
 * standalone route is registered; everything lives in Settings > Plugins.
 */
import {
  Alert,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  List,
  ListItem,
  Sheet,
  Stack,
  Textarea,
  Typography
} from '@mui/joy'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import LinkRoundedIcon from '@mui/icons-material/LinkRounded'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  extractErrorMessage,
  type HomeAssistantAccessStatus,
  type HomeAssistantCreateAccessTokenResponse,
  type HomeAssistantSnapshot
} from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { getBrowserEnv } from '../../lib/browserEnv'
import { buildTenantWorkspacePath, parseWorkspacePathname } from '../../lib/workspaceRoute'

const CUSTOM_COMPONENT_PATH = 'integrations/home-assistant/custom_components/printstream'
const CUSTOM_COMPONENT_TARGET = 'custom_components/printstream'
const PRINTER_CARD_EXAMPLE = `type: custom:printstream-printer-card
entity: sensor.my_printer_status`

const AMS_CARD_EXAMPLE = `type: custom:printstream-ams-card
entity: sensor.my_printer_ams_1_status`

const COMBINED_CARD_EXAMPLE = `type: custom:printstream-printer-ams-card
entity: sensor.my_printer_status`

function CodeBlock({ code }: { code: string }) {
  return (
    <Sheet
      variant="soft"
      color="neutral"
      sx={{
        p: 1.25,
        borderRadius: 'md',
        fontFamily: 'monospace',
        fontSize: 'sm',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere'
      }}
    >
      {code}
    </Sheet>
  )
}

export function HomeAssistantSettingsPanel() {
  const navigate = useNavigate()
  const location = useLocation()
  const tenantSlug = parseWorkspacePathname(location.pathname).tenantSlug
  const queryClient = useQueryClient()
  const [copiedValue, setCopiedValue] = useState<'base' | 'token' | null>(null)
  const [revealedToken, setRevealedToken] = useState<HomeAssistantCreateAccessTokenResponse | null>(null)
  const query = useQuery<HomeAssistantSnapshot>({
    queryKey: ['home-assistant-snapshot'],
    queryFn: () => apiFetch<HomeAssistantSnapshot>('/api/plugins/home-assistant/snapshot')
  })
  const accessQuery = useQuery<HomeAssistantAccessStatus>({
    queryKey: ['home-assistant-access'],
    queryFn: () => apiFetch<HomeAssistantAccessStatus>('/api/plugins/home-assistant/access')
  })
  const createAccessTokenMutation = useMutation({
    mutationFn: () => apiFetch<HomeAssistantCreateAccessTokenResponse>('/api/plugins/home-assistant/access/token', {
      method: 'POST'
    }),
    onSuccess: async (data) => {
      setRevealedToken(data)
      setCopiedValue(null)
      await queryClient.invalidateQueries({ queryKey: ['home-assistant-access'] })
    }
  })
  const hubBaseUrl = (() => {
    const configuredApiBase = getBrowserEnv().apiBaseUrl.trim().replace(/\/$/, '')
    if (configuredApiBase) {
      return configuredApiBase
    }
    return window.location.origin
  })()
  const printerCount = query.data?.printers.length ?? 0
  const amsUnitCount = query.data?.printers.reduce((count, printer) => count + printer.ams.length, 0) ?? 0
  const accessStatus = accessQuery.data
  const accessError = accessQuery.error ? extractErrorMessage(accessQuery.error) : null
  const tokenActionLabel = accessStatus?.state === 'active'
    ? 'Create replacement token'
    : accessStatus?.state === 'missing'
      ? 'Create access token'
      : 'Create new access token'

  async function handleCopy(value: string, kind: 'base' | 'token') {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedValue(kind)
    } catch {
      setCopiedValue(null)
    }
  }

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} flexWrap="wrap">
        <Chip size="sm" variant="soft">
          {printerCount} printer{printerCount === 1 ? '' : 's'}
        </Chip>
        <Chip size="sm" variant="soft">
          {amsUnitCount} AMS unit{amsUnitCount === 1 ? '' : 's'}
        </Chip>
      </Stack>

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={1.25}>
            <Typography level="title-md">Connection details</Typography>
            <Stack spacing={0.75}>
              <Typography level="body-sm" textColor="text.tertiary">
                Use this PrintStream base URL in the Home Assistant integration.
              </Typography>
              <CodeBlock code={hubBaseUrl} />
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                <Button size="sm" variant="soft" color="neutral" onClick={() => void handleCopy(hubBaseUrl, 'base')}>
                  Copy base URL
                </Button>
              </Stack>
              {copiedValue && (
                <Alert color="success" variant="soft">
                  {copiedValue === 'base' ? 'Base URL copied.' : 'Token copied.'}
                </Alert>
              )}
            </Stack>
          </Stack>
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={1.25}>
            <Typography level="title-md">Setup checklist</Typography>
            <List marker="decimal">
              <ListItem>
                Copy {CUSTOM_COMPONENT_PATH} into your Home Assistant config directory as {CUSTOM_COMPONENT_TARGET}.
              </ListItem>
              <ListItem>
                Create the required access token in the section below, then keep it ready for the Home Assistant setup flow.
              </ListItem>
              <ListItem>
                Restart Home Assistant, add the <strong>PrintStream Bridge</strong> integration, and enter the base URL shown above plus that access token.
              </ListItem>
              <ListItem>
                The integration auto-registers the bundled custom-card resource, so the three
                custom:printstream-* cards are ready after setup.
              </ListItem>
              <ListItem>
                If that token is ever revoked, deleted, or replaced, come back here, create a new one, and use <strong>Configure</strong> on the existing Home Assistant entry to update it.
              </ListItem>
            </List>
          </Stack>
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={1.25}>
            <Typography level="title-md">Required access token</Typography>
            <Typography level="body-sm" textColor="text.tertiary">
              This plugin keeps a dedicated Home Assistant service account so it can warn you if access is deleted and generate a replacement token when needed.
            </Typography>
            {accessQuery.isLoading && (
              <Typography level="body-sm" textColor="text.tertiary">
                Loading access-token status...
              </Typography>
            )}
            {accessError && (
              <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
                {accessError}
              </Alert>
            )}
            {accessStatus && (
              <>
                {accessStatus.state === 'active' && accessStatus.serviceAccount && (
                  <Alert color="success" variant="soft">
                    Home Assistant is linked to the tracked access token <strong>{accessStatus.serviceAccount.tokenPrefix}</strong>.
                  </Alert>
                )}
                {accessStatus.state === 'missing' && (
                  <Alert color="warning" variant="soft" startDecorator={<InfoOutlinedIcon />}>
                    No Home Assistant access token has been created yet. Create it here before you connect Home Assistant.
                  </Alert>
                )}
                {accessStatus.state === 'deleted' && (
                  <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
                    The tracked Home Assistant access token was deleted. Create a replacement here, then update the Home Assistant integration.
                  </Alert>
                )}
                {accessStatus.state === 'revoked' && (
                  <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
                    The tracked Home Assistant access token was revoked. Create a replacement here, then update the Home Assistant integration.
                  </Alert>
                )}
                {accessStatus.state === 'misconfigured' && (
                  <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
                    The tracked Home Assistant service account is missing required access. Create a replacement token here to restore the plugin-managed setup.
                  </Alert>
                )}
              </>
            )}
            <Stack spacing={0.75}>
              <Typography level="title-sm">Access included</Typography>
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                {(accessStatus?.recommendedPermissions ?? []).map((permission) => (
                  <Chip key={permission} size="sm" variant="soft" color="primary">
                    {permission}
                  </Chip>
                ))}
              </Stack>
              <Typography level="body-xs" textColor="text.tertiary">
                This token includes the printer, AMS, camera, and library access the integration needs. `printers.manage` covers AMS actions in the current permission model.
              </Typography>
            </Stack>
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
              <Button
                size="sm"
                variant="solid"
                color="primary"
                loading={createAccessTokenMutation.isPending}
                onClick={() => void createAccessTokenMutation.mutateAsync()}
              >
                {tokenActionLabel}
              </Button>
              <Button
                size="sm"
                variant="soft"
                color="neutral"
                startDecorator={<LinkRoundedIcon />}
                onClick={() => {
                  if (tenantSlug) navigate(buildTenantWorkspacePath(tenantSlug, '/settings/authentication'))
                }}
              >
                Review in Authentication
              </Button>
            </Stack>
            {createAccessTokenMutation.error && (
              <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
                {extractErrorMessage(createAccessTokenMutation.error)}
              </Alert>
            )}
            {revealedToken && (
              <Card variant="soft" color="warning">
                <CardContent>
                  <Stack spacing={1.25}>
                    <Typography level="title-sm">New access token</Typography>
                    <Typography level="body-sm">
                      Save this token now. It is only shown once after creation.
                    </Typography>
                    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                      <Chip size="sm" variant="soft" color="primary">{revealedToken.serviceAccount.name}</Chip>
                      <Chip size="sm" variant="soft" color="neutral">{revealedToken.serviceAccount.tokenPrefix}</Chip>
                    </Stack>
                    <Textarea minRows={3} value={revealedToken.token} readOnly />
                    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                      <Button size="sm" onClick={() => void handleCopy(revealedToken.token, 'token')}>
                        Copy token
                      </Button>
                      <Button size="sm" variant="plain" color="neutral" onClick={() => setRevealedToken(null)}>
                        Dismiss
                      </Button>
                    </Stack>
                    {copiedValue === 'token' && (
                      <Alert color="success" variant="soft">
                        Token copied.
                      </Alert>
                    )}
                  </Stack>
                </CardContent>
              </Card>
            )}
          </Stack>
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={1.25}>
            <Typography level="title-md">Lovelace cards</Typography>
            <Typography level="body-sm" textColor="text.tertiary">
              Use the printer device&apos;s <strong>Status</strong> entity with the printer or combined
              card, and an AMS device&apos;s <strong>Status</strong> entity with the AMS card.
            </Typography>
            <Divider />
            <Stack spacing={0.75}>
              <Typography level="title-sm">Printer card</Typography>
              <CodeBlock code={PRINTER_CARD_EXAMPLE} />
            </Stack>
            <Stack spacing={0.75}>
              <Typography level="title-sm">AMS card</Typography>
              <CodeBlock code={AMS_CARD_EXAMPLE} />
            </Stack>
            <Stack spacing={0.75}>
              <Typography level="title-sm">Combined printer + AMS card</Typography>
              <CodeBlock code={COMBINED_CARD_EXAMPLE} />
            </Stack>
          </Stack>
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={1.25}>
            <Typography level="title-md">Bridge inventory</Typography>
            {query.isLoading && <Typography level="body-sm">Loading bridge snapshot...</Typography>}
            {query.error && (
              <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
                {(query.error as Error).message}
              </Alert>
            )}
            {!query.isLoading && !query.error && query.data?.printers.length === 0 && (
              <Typography level="body-sm" textColor="text.tertiary">
                No configured printers are currently exposed by the bridge.
              </Typography>
            )}
            {query.data?.printers.map((printer) => (
              <Sheet key={printer.id} variant="soft" sx={{ p: 1.25, borderRadius: 'md' }}>
                <Stack spacing={0.5}>
                  <Typography level="title-sm">
                    {printer.name} <span style={{ color: 'var(--joy-palette-text-tertiary)', fontSize: '0.75rem' }}>({printer.model})</span>
                  </Typography>
                  <Typography level="body-sm" textColor="text.tertiary">
                    {printer.online ? `Online - ${printer.stage}` : 'Offline'}{printer.jobName ? ` - ${printer.jobName}` : ''}
                  </Typography>
                  <Typography level="body-xs" textColor="text.tertiary">
                    Serial: {printer.serial} - AMS units: {printer.ams.length}
                  </Typography>
                  {printer.ams.length > 0 && (
                    <Typography level="body-xs" textColor="text.tertiary">
                      {printer.ams.map((unit) => `${unit.name}${unit.activeSlot != null ? ` (slot ${unit.activeSlot + 1} active)` : ''}`).join(' - ')}
                    </Typography>
                  )}
                </Stack>
              </Sheet>
            ))}
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  )
}
