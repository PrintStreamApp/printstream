import { useQuery } from '@tanstack/react-query'
import { Chip, Stack, Tooltip, Typography } from '@mui/joy'
import type { AppVersionResponse } from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'

/**
 * Footer line showing the running image's build and, for the published
 * open-core image, a subtle "update available" hint when GHCR's `:latest` is a
 * newer build. The server applies visibility (everyone for the published image,
 * platform users only for the cloud image, nobody for a source/dev run), so this
 * renders nothing whenever there is no build to show.
 */
export function AppVersionFooter() {
  const { data } = useQuery({
    queryKey: ['app', 'version'],
    queryFn: ({ signal }) => apiFetch<AppVersionResponse>('/api/app/version', { signal }),
    retry: false,
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false
  })

  if (!data || data.revision == null || data.shortRevision == null) return null
  const update = data.update
  const hasUpdate = update?.status === 'updateAvailable'

  return (
    <Stack
      direction="row"
      spacing={0.75}
      alignItems="center"
      useFlexGap
      sx={{ flexWrap: 'wrap', justifyContent: 'center' }}
    >
      <Typography level="body-xs" title={data.revision} sx={{ color: 'neutral.500', fontFamily: 'code' }}>
        {`build ${data.shortRevision}`}
      </Typography>
      {hasUpdate && update && (
        <Tooltip variant="soft" title={describeUpdate(update)}>
          <Chip size="sm" variant="soft" color="warning">
            Update available
          </Chip>
        </Tooltip>
      )}
    </Stack>
  )
}

function describeUpdate(update: NonNullable<AppVersionResponse['update']>): string {
  const target = update.latestShortRevision ? ` (build ${update.latestShortRevision})` : ''
  const pull = update.imageRef ? ` Pull ${update.imageRef} to update.` : ''
  return `A newer image is available${target}.${pull}`
}
