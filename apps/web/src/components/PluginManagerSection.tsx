import React, { useRef, useState, type ReactNode } from 'react'
import {
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  DialogActions,
  DialogContent,
  DialogTitle,
  ModalDialog,
  Stack,
  Switch,
  Typography
} from '@mui/joy'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded'
import KeyboardArrowRightRoundedIcon from '@mui/icons-material/KeyboardArrowRightRounded'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  extractErrorMessage,
  type PluginManagementEntry,
  type PluginManagementResponse,
  type PluginSurface,
  type UpdateTenantPluginAvailabilityInput
} from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'
import { buildApiUrl } from '../lib/apiUrl'
import { invalidatePluginRelatedQueries } from '../lib/pluginQueryInvalidation'
import { usePluginCatalogQuery } from '../lib/pluginCatalogQuery'
import {
  getPluginDisplayName,
  isAuthPlugin,
  isNotificationPlugin,
  isPluginAvailableInCurrentContext,
  isPluginEnabled,
  isPluginInstalled,
  mergePlugins,
  pluginHasManagerSurface,
  shouldRenderPluginSettingsPanel,
  type ApiPluginInfo,
  type MergedPluginEntry
} from '../lib/pluginSettings'
import { useRuntimePolicy } from '../lib/runtimePolicy'
import { toast } from '../lib/toast'
import { webPluginRegistry } from '../plugin/registry'
import { BackAwareModal as Modal } from './BackAwareModal'

type PluginManagerSectionProps = {
  surface: PluginSurface
}

/**
 * Split plugin manager used by both the platform workspace and tenant settings.
 *
 * Platform mode manages installation for platform-only plugins and tenant-use
 * policy for tenant plugins. Tenant mode shows only the allowed plugins and
 * lets each tenant enable or disable them locally.
 */
export function PluginManagerSection({ surface }: PluginManagerSectionProps) {
  const { demoMode } = useRuntimePolicy()
  const queryClient = useQueryClient()
  const isPlatformManager = surface === 'platform'
  const platformQuery = useQuery({
    queryKey: ['admin-plugins'],
    queryFn: () => apiFetch<PluginManagementResponse>('/api/admin/plugins'),
    enabled: isPlatformManager
  })
  const tenantQuery = usePluginCatalogQuery({
    enabled: !isPlatformManager,
    suppressGlobalErrorToast: true
  })

  const apiPlugins = isPlatformManager
    ? (platformQuery.data?.plugins ?? [])
    : (tenantQuery.data?.plugins ?? [])

  const setEnabled = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      apiFetch(`/api/admin/plugins/${name}/enabled`, {
        method: 'POST',
        body: { enabled }
      }),
    onSuccess: async (_data, variables) => {
      await invalidatePluginRelatedQueries(queryClient)
      toast.success(pluginToggleMessage(variables.name, variables.enabled))
    }
  })

  const install = useMutation({
    mutationFn: (name: string) => apiFetch(`/api/admin/plugins/${name}/install`, { method: 'POST' }),
    onSuccess: () => invalidatePluginRelatedQueries(queryClient)
  })

  const uninstall = useMutation({
    mutationFn: (name: string) => apiFetch(`/api/admin/plugins/${name}/uninstall`, { method: 'POST' }),
    onSuccess: () => invalidatePluginRelatedQueries(queryClient)
  })

  const setTenantAvailability = useMutation({
    mutationFn: ({ name, body }: { name: string; body: UpdateTenantPluginAvailabilityInput }) =>
      apiFetch(`/api/admin/plugins/${name}/tenant-availability`, {
        method: 'PUT',
        body
      }),
    onSuccess: () => invalidatePluginRelatedQueries(queryClient)
  })

  const setTenantEnabled = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      apiFetch(`/api/plugin-catalog/${name}/enabled`, {
        method: 'POST',
        body: { enabled }
      }),
    onSuccess: async (_data, variables) => {
      await invalidatePluginRelatedQueries(queryClient)
      toast.success(pluginToggleMessage(variables.name, variables.enabled))
    }
  })

  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const uploadInstall = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData()
      form.append('package', file)
      const response = await fetch(buildApiUrl('/api/admin/plugins/upload'), {
        method: 'POST',
        body: form
      })
      const contentType = response.headers.get('content-type') ?? ''
      const payload = contentType.includes('application/json')
        ? await response.json()
        : await response.text()
      if (!response.ok) {
        throw new Error(extractErrorMessage(payload, `Upload failed (${response.status})`))
      }
      return payload
    },
    onSuccess: () => {
      setUploadError(null)
      void invalidatePluginRelatedQueries(queryClient)
    },
    onError: (error: Error) => setUploadError(error.message)
  })

  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null)
  const pendingName =
    install.variables
    ?? uninstall.variables
    ?? setEnabled.variables?.name
    ?? setTenantAvailability.variables?.name
    ?? setTenantEnabled.variables?.name

  const webPlugins = webPluginRegistry.list()
  const hasPluginState = isPlatformManager
    ? platformQuery.data?.plugins != null
    : tenantQuery.data?.plugins != null
  const merged = hasPluginState
    ? mergePlugins(apiPlugins, webPlugins).filter((entry) => !isAuthPlugin(entry.name))
    : []
  const platformEntries = merged.filter((entry) => pluginHasManagerSurface(entry, 'platform') && !pluginHasManagerSurface(entry, 'tenant'))
  const tenantEntries = merged.filter((entry) => pluginHasManagerSurface(entry, 'tenant'))
  const visibleEntries = isPlatformManager
    ? []
    : tenantEntries.filter((entry) => isPluginAvailableInCurrentContext(entry))
  const installedCount = (isPlatformManager ? tenantEntries : visibleEntries)
    .filter((entry) => isPluginInstalled(entry))
    .length
  const activeQuery = isPlatformManager ? platformQuery : tenantQuery

  return (
    <Stack spacing={1.5}>
      {isPlatformManager && demoMode && (
        <Typography level="body-sm" textColor="text.tertiary">
          Plugin uploads are disabled in the public demo.
        </Typography>
      )}

      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        alignItems={{ xs: 'flex-start', sm: 'center' }}
        justifyContent="space-between"
      >
        <Typography level="body-sm" textColor="text.tertiary">
          {installedCount} of {(isPlatformManager ? tenantEntries : visibleEntries).length} installed
        </Typography>
        {isPlatformManager && (
          <Stack direction="row" spacing={1} alignItems="center">
            {!demoMode && (
              <>
                <input
                  ref={uploadInputRef}
                  type="file"
                  accept=".zip"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) uploadInstall.mutate(file)
                    event.target.value = ''
                  }}
                />
                <Button
                  size="sm"
                  variant="solid"
                  color="primary"
                  loading={uploadInstall.isPending}
                  onClick={() => uploadInputRef.current?.click()}
                >
                  Install plugin…
                </Button>
              </>
            )}
          </Stack>
        )}
      </Stack>

      {uploadError && (
        <Typography level="body-sm" color="danger">
          {uploadError}
        </Typography>
      )}

      {activeQuery.isLoading && <Typography level="body-sm">Loading…</Typography>}
      {activeQuery.error && (
        <Typography color="danger" level="body-sm">
          {(activeQuery.error as Error).message}
        </Typography>
      )}

      {isPlatformManager ? (
        <>
          <PluginSectionCard
            title="Platform plugins"
            summary="Installed once for the whole deployment. These stay in the platform workspace."
            entries={platformEntries}
            surface={surface}
            pendingName={pendingName}
            setEnabled={setEnabled.mutate}
            install={install.mutate}
            uninstall={setConfirmUninstall}
            installPending={install.isPending}
            uninstallPending={uninstall.isPending}
            setEnabledPending={setEnabled.isPending}
          />
          <PluginSectionCard
            title="Tenant plugins"
            summary="Installed centrally. The platform only decides whether tenants can use them and whether they start enabled for new workspaces."
            entries={tenantEntries}
            surface={surface}
            pendingName={pendingName}
            setEnabled={setEnabled.mutate}
            install={install.mutate}
            uninstall={setConfirmUninstall}
            installPending={install.isPending}
            uninstallPending={uninstall.isPending}
            setEnabledPending={setEnabled.isPending}
            renderExtra={(entry) => {
              const plugin = asManagementPlugin(entry.api)
              if (!plugin?.tenantAvailability) return null
              return (
                <TenantAvailabilityEditor
                  plugin={plugin}
                  busy={pendingName === entry.name && setTenantAvailability.isPending}
                  onChange={(next) => {
                    setTenantAvailability.mutate({
                      name: plugin.name,
                      body: next
                    })
                  }}
                />
              )
            }}
          />
        </>
      ) : (
        <PluginSectionCard
          title="Plugins"
          summary="Turn available plugins on or off as needed."
          entries={visibleEntries}
          surface={surface}
          showHeader={false}
          pendingName={pendingName}
          setEnabled={setTenantEnabled.mutate}
          install={install.mutate}
          uninstall={setConfirmUninstall}
          installPending={install.isPending}
          uninstallPending={uninstall.isPending}
          setEnabledPending={setTenantEnabled.isPending}
          emptyMessage="No plugins are currently available in this workspace."
        />
      )}

      <Modal open={confirmUninstall != null} onClose={() => setConfirmUninstall(null)}>
        <ModalDialog variant="outlined" role="alertdialog">
          <DialogTitle>Uninstall plugin?</DialogTitle>
          <DialogContent>
            <Typography level="body-sm">
              Uninstalling <strong>{confirmUninstall}</strong> will deactivate it and clear any
              settings it has stored. You can reinstall it again later, but its data will not be
              restored.
            </Typography>
          </DialogContent>
          <DialogActions>
            <Button variant="plain" color="neutral" onClick={() => setConfirmUninstall(null)}>
              Cancel
            </Button>
            <Button
              variant="solid"
              color="danger"
              loading={uninstall.isPending}
              startDecorator={<DeleteRoundedIcon />}
              onClick={() => {
                if (confirmUninstall) {
                  uninstall.mutate(confirmUninstall, {
                    onSettled: () => setConfirmUninstall(null)
                  })
                }
              }}
            >
              Uninstall
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>
    </Stack>
  )
}

function PluginSectionCard({
  title,
  summary,
  entries,
  surface,
  framed = true,
  showHeader = true,
  pendingName,
  setEnabled,
  install,
  uninstall,
  installPending,
  uninstallPending,
  setEnabledPending,
  renderExtra,
  emptyMessage
}: {
  title: string
  summary: string
  entries: MergedPluginEntry[]
  surface: PluginSurface
  framed?: boolean
  showHeader?: boolean
  pendingName: string | undefined
  setEnabled: (input: { name: string; enabled: boolean }) => void
  install: (name: string) => void
  uninstall: (name: string) => void
  installPending: boolean
  uninstallPending: boolean
  setEnabledPending: boolean
  renderExtra?: (entry: MergedPluginEntry) => ReactNode
  emptyMessage?: string
}) {
  const [expandedDetails, setExpandedDetails] = useState<Set<string>>(() => new Set())

  if (entries.length === 0) {
    if (!framed) {
      return (
        <Typography level="body-sm" textColor="text.tertiary">
          {emptyMessage ?? 'No plugins are available in this section.'}
        </Typography>
      )
    }

    return (
      <Card variant="outlined">
        <CardContent>
          <Stack spacing={0.5}>
            <Typography level="title-sm">{title}</Typography>
            <Typography level="body-sm" textColor="text.tertiary">
              {emptyMessage ?? 'No plugins are available in this section.'}
            </Typography>
          </Stack>
        </CardContent>
      </Card>
    )
  }

  const isPlatformManager = surface === 'platform'
  const content = (
    <Stack spacing={1.25}>
      {showHeader && (
        <Stack spacing={0.25}>
          <Typography level="title-sm">{title}</Typography>
          <Typography level="body-sm" textColor="text.tertiary">
            {summary}
          </Typography>
        </Stack>
      )}

      <Stack spacing={1.25}>
        {entries.map((entry) => {
          const installed = isPluginInstalled(entry)
          const enabled = isPluginEnabled(entry)
          const available = isPluginAvailableInCurrentContext(entry)
          const tenantManaged = entry.api?.tenantAccess === 'controlled'
          const togglable = entry.api != null && installed && (
            isPlatformManager
              ? !tenantManaged
              : available
          )
          const showToggle = entry.api != null && installed && (
            isPlatformManager
              ? !tenantManaged
              : available
          )
          const canInstall = isPlatformManager && entry.api != null
          const Panel = entry.web?.settingsPanel
          const showPanel = shouldRenderPluginSettingsPanel(entry, 'manager') && (!isPlatformManager || !tenantManaged)
          const isNotificationSettingsPlugin = isNotificationPlugin(entry.name)
          const busy = pendingName === entry.name && (installPending || uninstallPending || setEnabledPending)
          const detailKey = `${title}:${entry.name}`
          const detailsExpanded = expandedDetails.has(detailKey)
          const extraDetails = renderExtra?.(entry) ?? null
          const detailsContent = showPanel && Panel ? (
            <Panel />
          ) : !installed ? (
            <Typography level="body-sm" textColor="text.tertiary">
              Install this plugin to configure it.
            </Typography>
          ) : isPlatformManager && tenantManaged ? (
            <Typography level="body-sm" textColor="text.tertiary">
              Tenant workspaces decide whether to turn this plugin on. The platform only controls whether it is available and whether it starts enabled for them.
            </Typography>
          ) : !enabled ? (
            <Typography level="body-sm" textColor="text.tertiary">
              {entry.name === 'home-assistant'
                ? 'Enable this plugin, then create the required access token from its setup panel before connecting Home Assistant.'
                : 'Enable this plugin to configure it.'}
            </Typography>
          ) : isNotificationSettingsPlugin ? (
            <Typography level="body-sm" textColor="text.tertiary">
              Configure this notification channel in the Notifications section below.
            </Typography>
          ) : (
            <Typography level="body-sm" textColor="text.tertiary">
              This plugin has no settings.
            </Typography>
          )

          return (
            <Card key={`${title}:${entry.name}`} variant="outlined">
              <CardContent>
                <Stack spacing={1.5}>
                  <Stack
                    direction={{ xs: 'column', md: 'row' }}
                    spacing={1.25}
                    justifyContent="space-between"
                    alignItems={{ xs: 'flex-start', md: 'flex-start' }}
                  >
                    <Stack spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
                      <Typography level="title-sm">{entry.name}</Typography>
                      {entry.description && (
                        <Typography level="body-sm" textColor="text.tertiary">
                          {entry.description}
                        </Typography>
                      )}
                    </Stack>

                    <Stack spacing={1} alignItems={{ xs: 'stretch', md: 'flex-end' }} sx={{ width: { xs: '100%', md: 'auto' } }}>
                      <Stack direction="row" spacing={1} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap', justifyContent: { xs: 'flex-start', md: 'flex-end' } }}>
                        {entry.version && <Chip size="sm" variant="outlined">v{entry.version}</Chip>}
                        {entry.api && entry.web && <Chip size="sm" variant="soft">api+web</Chip>}
                        {entry.api && !entry.web && <Chip size="sm" variant="soft">api</Chip>}
                        {!entry.api && entry.web && <Chip size="sm" variant="soft">web</Chip>}
                        {entry.api && entry.api.source !== 'builtin' && (
                          <Chip size="sm" variant="soft" color="primary">{entry.api.source}</Chip>
                        )}
                        {!installed && <Chip size="sm" variant="soft" color="neutral">not installed</Chip>}
                        {!available && <Chip size="sm" variant="soft" color="warning">not available here</Chip>}
                      </Stack>

                      {showToggle && (
                        <Stack direction="row" spacing={1} alignItems="center" justifyContent={{ xs: 'space-between', md: 'flex-end' }} sx={{ width: { xs: '100%', md: 'auto' } }}>
                          <Typography level="body-sm" textColor="text.tertiary">
                            {installed && enabled ? 'Enabled' : 'Disabled'}
                          </Typography>
                          <Switch
                            checked={installed && enabled}
                            disabled={!togglable || busy}
                            onChange={(event) => {
                              if (entry.api && installed) {
                                setEnabled({ name: entry.name, enabled: event.target.checked })
                              }
                            }}
                          />
                        </Stack>
                      )}
                    </Stack>
                  </Stack>

                  <Stack spacing={1}>
                    <Button
                      size="sm"
                      variant="plain"
                      color="neutral"
                      aria-expanded={detailsExpanded}
                      aria-label={`${detailsExpanded ? 'Hide' : 'Show'} ${entry.name} plugin details`}
                      startDecorator={detailsExpanded ? <KeyboardArrowDownRoundedIcon /> : <KeyboardArrowRightRoundedIcon />}
                      onClick={() => setExpandedDetails((current) => toggleExpandedDetails(current, detailKey))}
                      sx={{ alignSelf: 'flex-start', px: 0 }}
                    >
                      Details
                    </Button>

                    {detailsExpanded && (
                      <Stack spacing={1.25}>
                        {detailsContent}
                        {extraDetails}
                      </Stack>
                    )}
                  </Stack>

                  {canInstall && (
                    <Stack direction="row" spacing={1} justifyContent="flex-end">
                      {installed ? (
                        <Button
                          size="sm"
                          variant="outlined"
                          color="danger"
                          loading={busy && uninstallPending}
                          disabled={busy}
                          startDecorator={<DeleteRoundedIcon />}
                          onClick={() => uninstall(entry.name)}
                        >
                          Uninstall
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="solid"
                          color="primary"
                          loading={busy && installPending}
                          disabled={busy}
                          onClick={() => install(entry.name)}
                        >
                          Install
                        </Button>
                      )}
                    </Stack>
                  )}
                </Stack>
              </CardContent>
            </Card>
          )
        })}
      </Stack>
    </Stack>
  )

  return content
}

function toggleExpandedDetails(current: Set<string>, key: string): Set<string> {
  const next = new Set(current)
  if (next.has(key)) {
    next.delete(key)
  } else {
    next.add(key)
  }
  return next
}

function pluginToggleMessage(name: string, enabled: boolean): string {
  return `${getPluginDisplayName(name)} ${enabled ? 'enabled' : 'disabled'}`
}

function TenantAvailabilityEditor({
  plugin,
  busy,
  onChange
}: {
  plugin: PluginManagementEntry
  busy: boolean
  onChange: (next: UpdateTenantPluginAvailabilityInput) => void
}) {
  const allowed = plugin.tenantAvailability?.allowed ?? false
  const enabledByDefault = plugin.tenantAvailability?.enabledByDefault ?? false

  return (
    <Card variant="soft">
      <CardContent>
        <Stack spacing={1.25}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
            <Box>
              <Typography level="title-sm">Allow for tenants</Typography>
              <Typography level="body-xs" textColor="text.tertiary">
                Hide this plugin from tenant workspaces entirely when disabled.
              </Typography>
            </Box>
            <Switch
              checked={allowed}
              disabled={busy}
              onChange={(event) => onChange({
                allowed: event.target.checked,
                enabledByDefault
              })}
            />
          </Stack>

          <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
            <Box>
              <Typography level="title-sm">Enabled by default</Typography>
              <Typography level="body-xs" textColor="text.tertiary">
                Controls the starting state when a tenant workspace first sees this plugin. Tenants can still change it later.
              </Typography>
            </Box>
            <Switch
              checked={enabledByDefault}
              disabled={busy || !allowed}
              onChange={(event) => onChange({
                allowed,
                enabledByDefault: event.target.checked
              })}
            />
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  )
}

function asManagementPlugin(plugin: ApiPluginInfo | null): PluginManagementEntry | null {
  if (!plugin || !('tenantAvailability' in plugin)) {
    return null
  }
  return plugin
}
