/**
 * Dev-only footer chips showing when the web session and the API last booted, so a stale
 * process is visible instead of being debugged.
 *
 * **Owns its own poll on purpose.** The 5s health query used to live in `App`, which meant every
 * tick re-rendered the entire tree: measured at ~56ms per tick on a library page with ten cards
 * rendered, and nothing at all with one, because the cost is the tree underneath rather than the
 * badge. Dev-only, so no user ever paid it, but it polluted every main-thread profile taken in dev
 * (including the one that first went looking for it). Keeping the query here bounds the re-render
 * to three chips.
 */
import { Chip, Stack } from '@mui/joy'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../lib/apiClient'

interface ApiHealthRuntime {
  nodeEnv: string
  bootId: string
  startedAt: string
  uptimeSeconds: number
}

interface DevHealthResponse {
  runtime?: ApiHealthRuntime
}

export interface DevRuntimeStatusProps {
  webStartedAt: string
}

function formatRuntimeClock(value: string): string {
  const clock = value.slice(11, 19)
  return clock || value
}

export function DevRuntimeStatus({ webStartedAt }: DevRuntimeStatusProps) {
  // Only ever mounted in dev (the caller gates on `browserEnv.devMode`), so the poll needs no
  // `enabled` guard of its own, not mounting is the guard.
  const health = useQuery({
    queryKey: ['dev-health'],
    queryFn: ({ signal }) => apiFetch<DevHealthResponse>('/api/health', { signal }),
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
    meta: { suppressGlobalErrorToast: true }
  })
  const apiRuntime = health.data?.runtime ?? null
  const apiRuntimeLoading = health.isLoading
  const apiRuntimeError = health.isError
  const apiLabel = apiRuntime
    ? `API ${formatRuntimeClock(apiRuntime.startedAt)}`
    : apiRuntimeError
      ? 'API unavailable'
      : apiRuntimeLoading
        ? 'API checking'
        : 'API unknown'

  return (
    <Stack
      direction="row"
      spacing={0.75}
      useFlexGap
      sx={{ flexWrap: 'wrap', justifyContent: { xs: 'flex-start', sm: 'flex-end' } }}
    >
      <Chip size="sm" variant="soft" color="warning">
        DEV
      </Chip>
      <Chip
        size="sm"
        variant="soft"
        color="neutral"
        title={`Web session started ${webStartedAt}`}
      >
        {`Web ${formatRuntimeClock(webStartedAt)}`}
      </Chip>
      <Chip
        size="sm"
        variant="soft"
        color={apiRuntime ? 'success' : apiRuntimeError ? 'danger' : 'neutral'}
        title={apiRuntime
          ? `API boot ${apiRuntime.startedAt} · ${apiRuntime.bootId} · uptime ${apiRuntime.uptimeSeconds}s`
          : apiRuntimeError
            ? 'API health check failed'
            : 'Checking API runtime'}
      >
        {apiLabel}
      </Chip>
    </Stack>
  )
}