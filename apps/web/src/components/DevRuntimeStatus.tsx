import { Chip, Stack } from '@mui/joy'

interface ApiHealthRuntime {
  nodeEnv: string
  bootId: string
  startedAt: string
  uptimeSeconds: number
}

export interface DevRuntimeStatusProps {
  webStartedAt: string
  apiRuntime: ApiHealthRuntime | null
  apiRuntimeLoading: boolean
  apiRuntimeError: boolean
}

function formatRuntimeClock(value: string): string {
  const clock = value.slice(11, 19)
  return clock || value
}

export function DevRuntimeStatus({
  webStartedAt,
  apiRuntime,
  apiRuntimeLoading,
  apiRuntimeError
}: DevRuntimeStatusProps) {
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