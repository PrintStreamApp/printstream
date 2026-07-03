import CelebrationRoundedIcon from '@mui/icons-material/CelebrationRounded'
import ChecklistRoundedIcon from '@mui/icons-material/ChecklistRounded'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import KeyboardArrowRightRoundedIcon from '@mui/icons-material/KeyboardArrowRightRounded'
import RouterRoundedIcon from '@mui/icons-material/RouterRounded'
import VisibilityOffRoundedIcon from '@mui/icons-material/VisibilityOffRounded'
import type { GeneralSettings, TenantStatsResponse } from '@printstream/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Alert, Button, Card, CardContent, Stack, Typography } from '@mui/joy'
import { Link as RouterLink, useLocation, useNavigate } from 'react-router-dom'
import { ConnectivityGuideButton } from '../components/ConnectivityGuideButton'
import { Printer3dRoundedIcon } from '../components/Printer3dRoundedIcon'
import { usePromptDialog } from '../components/PromptDialogProvider'
import { apiFetch } from '../lib/apiClient'
import { PRINTER_CONNECTIVITY_INTRO } from '../lib/printerConnectivityGuide'
import { buildTenantWorkspacePath, buildWorkspaceSelectionPath, parseWorkspacePathname } from '../lib/workspaceRoute'

/**
 * Workspace onboarding page. Shows the quick-start checklist for a fresh
 * workspace and serves as its default landing page until someone with
 * settings access dismisses it (a shared, workspace-wide choice).
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
  const tenantSlug = parseWorkspacePathname(location.pathname).tenantSlug
  const statsQuery = useQuery({
    queryKey: ['tenant-stats'],
    queryFn: ({ signal }) => apiFetch<TenantStatsResponse>('/api/stats', { signal })
  })
  const workspacePath = (path: string) => tenantSlug ? buildTenantWorkspacePath(tenantSlug, path) : buildWorkspaceSelectionPath()
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
        <Stack spacing={0.75} alignItems="flex-start">
          <Typography level="body-sm">{PRINTER_CONNECTIVITY_INTRO}</Typography>
          <ConnectivityGuideButton />
        </Stack>
      </Alert>

      {statsQuery.isError ? (
        <Alert color="danger" variant="soft">
          Setup progress could not be loaded right now.
        </Alert>
      ) : stats == null ? (
        <Typography>Loading…</Typography>
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

function resolveQuickStartHref(id: TenantStatsResponse['quickStartItems'][number]['id'], canOpenSettings: boolean, complete: boolean, workspacePath: (path: string) => string): string | undefined {
  if (complete) return undefined
  if (id === 'connect-bridge') return canOpenSettings ? workspacePath('/settings/bridges') : undefined
  if (id === 'add-printer') return workspacePath('/printers')
  return workspacePath('/library')
}

function QuickStartCard({
  icon,
  title,
  description,
  actionTo
}: {
  icon: ReactNode
  title: string
  description: string
  actionTo?: string
}) {
  const content = (
    <CardContent>
      <Stack direction="row" spacing={1.5} justifyContent="space-between" alignItems="center">
        <Stack spacing={1.25} sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography level="title-lg" sx={{ display: 'inline-flex', alignItems: 'center' }}>
              {icon}
            </Typography>
            <Typography level="title-lg">{title}</Typography>
          </Stack>
          <Typography level="body-sm" textColor="text.tertiary">{description}</Typography>
        </Stack>
        {actionTo ? (
          <Typography
            aria-hidden="true"
            level="title-lg"
            textColor="text.tertiary"
            sx={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}
          >
            <KeyboardArrowRightRoundedIcon />
          </Typography>
        ) : null}
      </Stack>
    </CardContent>
  )

  const cardSx = {
    textAlign: 'left',
    ...(actionTo
      ? {
          cursor: 'pointer',
          textDecoration: 'none',
          color: 'inherit',
          transition: 'background-color 0.2s ease, border-color 0.2s ease, transform 0.2s ease',
          '&:hover': {
            backgroundColor: 'background.level1',
            borderColor: 'primary.softColor'
          },
          '&:focus-visible': {
            outline: '2px solid',
            outlineColor: 'focusVisible',
            outlineOffset: '2px'
          }
        }
      : {})
  } as const

  if (actionTo) {
    return (
      <Card component={RouterLink} to={actionTo} variant="outlined" sx={cardSx}>
        {content}
      </Card>
    )
  }

  return (
    <Card variant="outlined" sx={cardSx}>
      {content}
    </Card>
  )
}
