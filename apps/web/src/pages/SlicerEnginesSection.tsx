/**
 * Slicer engines: which Bambu Studio versions this deployment can slice with.
 *
 * Self-hosted only, and that is a tenancy rule rather than a product one — the
 * slicer is shared by every workspace, so on the cloud one admin's removal would
 * break slicing for everyone else. The API refuses there too; this just avoids
 * offering a control that would 404.
 *
 * The list is polled while anything is installing, because an engine is a
 * several-hundred-megabyte download the server performs in the background: the
 * request that starts it returns immediately, and progress arrives here.
 *
 * Counterpart: `apps/api/src/routes/slicing.ts` (`/api/slicing/engines`), which
 * proxies the slicer's own manager.
 */
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded'
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded'
import { Alert, Box, Button, Card, CardContent, Chip, Stack, Typography } from '@mui/joy'
import { extractErrorMessage, slicerEngineListResponseSchema, type SlicerEngine } from '@printstream/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../lib/apiClient'
import { ProgressBar } from '../components/ProgressBar'

/** "1.7 GB" — a byte count tells an operator nothing about whether it fits. */
function formatSize(bytes: number): string {
  const gb = bytes / 1_000_000_000
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1_000_000)} MB`
}

export function SlicerEnginesSection({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ['slicer-engines'],
    queryFn: async ({ signal }) =>
      slicerEngineListResponseSchema.parse(await apiFetch('/api/slicing/engines', { signal })),
    // Poll only while something is in flight. A manager nobody is watching
    // should not wake the slicer every few seconds forever.
    refetchInterval: (result) =>
      result.state.data?.engines.some((engine) => engine.status?.state === 'installing') ? 3000 : false
  })

  const change = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: 'install' | 'remove' }) => {
      await apiFetch(
        action === 'install' ? `/api/slicing/engines/${encodeURIComponent(id)}/install` : `/api/slicing/engines/${encodeURIComponent(id)}`,
        { method: action === 'install' ? 'POST' : 'DELETE' }
      )
    },
    // Refetch rather than patching the cache: the server decides what counts as
    // installed (every instance must have it), and guessing here would show a
    // state the deployment does not agree with.
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['slicer-engines'] })
  })

  const data = query.data

  if (query.isError) {
    return (
      <Alert color="danger" variant="soft">
        {extractErrorMessage(query.error, 'Could not load slicer engines.')}
      </Alert>
    )
  }

  if (data && !data.platformSupported) {
    return (
      <Alert color="warning" variant="soft">
        Bambu Studio publishes x86-64 builds only, and this machine cannot run them. Point
        SLICER_SERVICE_URL at a separate x86-64 slicer to slice here.
      </Alert>
    )
  }

  if (data && !data.available) {
    // "Cannot tell", never "nothing installed" — see the response contract.
    return (
      <Alert color="neutral" variant="soft">
        The slicer is not reachable right now, so its engines cannot be listed.
      </Alert>
    )
  }

  return (
    <Stack spacing={1.5}>
      <Typography level="body-sm" textColor="text.tertiary">
        Projects are sliced by Bambu Studio. Keeping an older version lets you slice a project a
        newer desktop build saved, which the current engine would refuse.
      </Typography>

      {(data?.engines ?? []).map((engine) => (
        <EngineCard
          key={engine.id}
          engine={engine}
          isDefault={engine.id === data?.defaultTargetId}
          canManage={canManage}
          busy={change.isPending && change.variables?.id === engine.id}
          onChange={(action) => change.mutate({ id: engine.id, action })}
        />
      ))}

      {change.isError ? (
        <Alert color="danger" variant="soft">
          {extractErrorMessage(change.error, 'That did not work.')}
        </Alert>
      ) : null}
    </Stack>
  )
}

function EngineCard({ engine, isDefault, canManage, busy, onChange }: {
  engine: SlicerEngine
  isDefault: boolean
  canManage: boolean
  busy: boolean
  onChange: (action: 'install' | 'remove') => void
}) {
  const installing = engine.status?.state === 'installing'
  const failed = engine.status?.state === 'failed'

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
          <Stack spacing={0.25} sx={{ flex: 1, minWidth: 0 }}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography level="title-sm">{engine.label}</Typography>
              {isDefault ? <Chip size="sm" variant="soft" color="primary">Default</Chip> : null}
              {/* Installable, never chosen automatically — Bambu ships these as
                  pre-releases and their own file-version refusal tells users a
                  project should come from a stable build. */}
              {engine.prerelease ? <Chip size="sm" variant="soft" color="warning">Beta</Chip> : null}
            </Stack>
            <Typography level="body-xs" textColor="text.tertiary">
              {engine.installed
                ? `Installed — about ${formatSize(engine.installBytes)} on disk`
                : `${formatSize(engine.downloadBytes)} download, about ${formatSize(engine.installBytes)} on disk`}
            </Typography>
          </Stack>

          {canManage ? (
            <Box sx={{ flexShrink: 0 }}>
              {engine.installed ? (
                <Button
                  size="sm"
                  variant="outlined"
                  color="danger"
                  startDecorator={<DeleteOutlineRoundedIcon />}
                  loading={busy}
                  disabled={installing}
                  onClick={() => onChange('remove')}
                >
                  Remove
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outlined"
                  startDecorator={<DownloadRoundedIcon />}
                  loading={busy || installing}
                  disabled={installing}
                  onClick={() => onChange('install')}
                >
                  {installing ? 'Installing' : 'Install'}
                </Button>
              )}
            </Box>
          ) : null}
        </Stack>

        {installing ? (
          <Stack spacing={0.5} sx={{ mt: 1 }}>
            {/* Determinate only while downloading: the unpack and profile steps
                have no measurable total, and a bar that stalls at a number reads
                as stuck rather than busy. */}
            <ProgressBar
              value={engine.status?.fraction !== undefined ? engine.status.fraction * 100 : null}
            />
            <Typography level="body-xs" textColor="text.tertiary">
              {engine.status?.label}
              {engine.status?.fraction !== undefined ? ` — ${Math.round(engine.status.fraction * 100)}%` : ''}
            </Typography>
          </Stack>
        ) : null}

        {failed ? (
          <Alert color="danger" variant="soft" sx={{ mt: 1 }}>
            {engine.status?.error ?? 'The install failed.'}
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  )
}
