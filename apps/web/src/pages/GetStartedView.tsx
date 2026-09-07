import CelebrationRoundedIcon from '@mui/icons-material/CelebrationRounded'
import ChecklistRoundedIcon from '@mui/icons-material/ChecklistRounded'
import ExtensionRoundedIcon from '@mui/icons-material/ExtensionRounded'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import PaletteRoundedIcon from '@mui/icons-material/PaletteRounded'
import RouterRoundedIcon from '@mui/icons-material/RouterRounded'
import SupportAgentRoundedIcon from '@mui/icons-material/SupportAgentRounded'
import TipsAndUpdatesRoundedIcon from '@mui/icons-material/TipsAndUpdatesRounded'
import VisibilityOffRoundedIcon from '@mui/icons-material/VisibilityOffRounded'
import type { GeneralSettings, WorkspaceStatsResponse } from '@printstream/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, Stack, Typography } from '@mui/joy'
import { useLocation, useNavigate } from 'react-router-dom'
import { QuickStartCard } from '../components/QuickStartCard'
import { PluginSlot } from '../plugin/PluginSlot'
import { ConnectivityGuideButton } from '../components/ConnectivityGuideButton'
import { Printer3dRoundedIcon } from '../components/Printer3dRoundedIcon'
import { usePromptDialog } from '../components/PromptDialogProvider'
import { apiFetch } from '../lib/apiClient'
import { PRINTER_CONNECTIVITY_INTRO } from '../lib/printerConnectivityGuide'
import { useRuntimePolicy } from '../lib/runtimePolicy'
import { buildWorkspacePath, buildWorkspaceSelectionPath, parseWorkspacePathname } from '../lib/workspaceRoute'
import { ListSkeleton } from '../components/ListSkeleton'

/**
 * Workspace onboarding page. Shows the quick-start checklist for a fresh
 * workspace, plus a short "Good to know" tips list (the plugin catalogue, theme
 * customization and, on cloud installs, the support-access privacy toggle), and
 * serves as the default landing page until someone with settings access
 * dismisses it (a shared, workspace-wide choice).
 *
 * The "Good to know" cards are the only place a new workspace is pointed at the
 * plugin catalogue at all: most plugins ship disabled, so without this the
 * optional half of the product is invisible unless someone goes looking in
 * settings.
 */
export function GetStartedView({
  canOpenSettings,
  canManageSettings
}: {
  canOpenSettings: boolean
  canManageSettings: boolean
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { confirm } = usePromptDialog()
  // Support access is a cloud-only concept; self-hosted installs have no
  // support users who could enter the workspace, so the tip is dropped there.
  const { selfHosted } = useRuntimePolicy()
  const workspaceSlug = parseWorkspacePathname(location.pathname).workspaceSlug
  const statsQuery = useQuery({
    queryKey: ['workspace-stats'],
    queryFn: ({ signal }) => apiFetch<WorkspaceStatsResponse>('/api/stats', { signal })
  })
  const workspacePath = (path: string) => workspaceSlug ? buildWorkspacePath(workspaceSlug, path) : buildWorkspaceSelectionPath()
  const dismissQuickStart = useMutation({
    mutationFn: () => apiFetch<GeneralSettings>('/api/settings', {
      method: 'PUT',
      body: { quickStartDismissed: true }
    }),
    onSuccess: (data) => {
      queryClient.setQueryData(['general-settings'], data)
      navigate(workspacePath('/printers'), { replace: true })
    }
  })

  const handleDismiss = async () => {
    const confirmed = await confirm({
      title: 'Hide Get started?',
      description: 'This hides the Get started page for everyone in this workspace and makes Printers the landing page.',
      confirmLabel: 'Hide page'
    })
    if (confirmed) {
      dismissQuickStart.mutate()
    }
  }

  const stats = statsQuery.data
  const allComplete = stats != null && !stats.setupRequired

  return (
    <Stack spacing={2}>
      <Stack spacing={0.75}>
        <Typography level="h3" startDecorator={<ChecklistRoundedIcon />}>Get started</Typography>
        <Typography level="body-sm" textColor="text.tertiary">
          Connect this workspace to your printers and send your first print.
        </Typography>
      </Stack>

      <Alert color="neutral" variant="soft" startDecorator={<InfoOutlinedIcon />}>
        <Stack
          direction="row"
          useFlexGap
          flexWrap="wrap"
          spacing={1.5}
          alignItems="center"
          sx={{ flex: 1 }}
        >
          <Typography level="body-sm" sx={{ flex: '1 1 260px' }}>{PRINTER_CONNECTIVITY_INTRO}</Typography>
          <ConnectivityGuideButton sx={{ ml: 'auto' }} />
        </Stack>
      </Alert>

      {statsQuery.isError ? (
        <Alert color="danger" variant="soft">
          Setup progress could not be loaded right now.
        </Alert>
      ) : stats == null ? (
        <ListSkeleton rows={2} />
      ) : (
        <Stack spacing={1.5}>
          {allComplete && (
            <Alert color="success" variant="soft" startDecorator={<CelebrationRoundedIcon />}>
              This workspace is set up and ready to go.
            </Alert>
          )}
          <Typography level="title-md" startDecorator={<ChecklistRoundedIcon />}>
            Quick start ({stats.quickStartCompletedCount}/{stats.quickStartItems.length})
          </Typography>
          {stats.quickStartItems.map((item) => (
            <QuickStartCard
              key={item.id}
              icon={item.id === 'connect-bridge' ? <RouterRoundedIcon /> : <Printer3dRoundedIcon />}
              title={item.complete ? `${item.title} complete` : item.title}
              description={item.description}
              actionTo={resolveQuickStartHref(item.id, canOpenSettings, item.complete, workspacePath)}
            />
          ))}
          <Typography level="title-md" startDecorator={<TipsAndUpdatesRoundedIcon />} sx={{ pt: 1 }}>
            Good to know
          </Typography>
          {/* Links only for someone who can MANAGE settings: the plugins subview
              redirects to the settings root without that permission, so a link
              here would silently land them somewhere else. */}
          <QuickStartCard
            icon={<ExtensionRoundedIcon />}
            title="Add more features"
            description="Plugins cover the optional extras: print notifications, 3D model editing, filament and spool tracking, calibration, a print queue, and maintenance reminders. Turn on the ones you want in Plugin settings."
            actionTo={canManageSettings ? workspacePath('/settings/plugins') : undefined}
          />
          <QuickStartCard
            icon={<PaletteRoundedIcon />}
            title="Make it yours"
            description="Choose from several themes to change how the app looks. Set a shared theme for the whole workspace, or override it just for this device, in General settings."
            actionTo={canOpenSettings ? workspacePath('/settings/general') : undefined}
          />
          {!selfHosted && (
            <QuickStartCard
              icon={<SupportAgentRoundedIcon />}
              title="Keep it private"
              description="Support staff can enter this workspace to help when something goes wrong. If you do not need that, turn off support access in Authentication settings."
              actionTo={canOpenSettings ? workspacePath('/settings/authentication') : undefined}
            />
          )}
          {/* Setup worth doing that only exists when a plugin provides it, so it cannot be a core
              item: linking a Bambu account to sync slicing presets is the first. Append-only, and
              renders nothing when no plugin contributes, so removing one never leaves a hole.
              Contributors reuse `QuickStartCard`, so a plugin's card cannot drift from these. */}
          <PluginSlot name="quickstart.tips" context={{ workspacePath, canOpenSettings }} />
          {canManageSettings && (
            <Stack direction="row" sx={{ pt: 1 }}>
              <Button
                variant="outlined"
                color="neutral"
                startDecorator={<VisibilityOffRoundedIcon />}
                loading={dismissQuickStart.isPending}
                onClick={() => { void handleDismiss() }}
              >
                Hide this page
              </Button>
            </Stack>
          )}
        </Stack>
      )}
    </Stack>
  )
}

function resolveQuickStartHref(id: WorkspaceStatsResponse['quickStartItems'][number]['id'], canOpenSettings: boolean, complete: boolean, workspacePath: (path: string) => string): string | undefined {
  if (complete) return undefined
  if (id === 'connect-bridge') return canOpenSettings ? workspacePath('/settings/bridges') : undefined
  if (id === 'add-printer') return workspacePath('/printers')
  return workspacePath('/library')
}
