/**
 * Icon (card) view of spools. Each card leads with a colour band, then the
 * title, material/brand chips, a remaining bar, and where it's loaded.
 */
import { Box, Card, CardContent, Chip, Stack, Typography } from '@mui/joy'
import type { FilamentSpool } from '@printstream/shared'
import { SpoolColorSwatch, SpoolRemaining } from './SpoolVisuals'
import { SpoolActionsMenu } from './SpoolActionsMenu'
import { STATUS_COLORS, STATUS_LABELS, formatLoadedLocation, spoolTitle } from './filters'

export function SpoolGrid({
  spools,
  onEdit,
  onAdjust,
  onUnassign,
  onRecycle,
  onPick
}: {
  spools: FilamentSpool[]
  onEdit?: (spool: FilamentSpool) => void
  onAdjust?: (spool: FilamentSpool) => void
  onUnassign?: (spool: FilamentSpool) => void
  onRecycle?: (spool: FilamentSpool) => void
  /** When set, cards are clickable to pick a spool and the actions menu is hidden. */
  onPick?: (spool: FilamentSpool) => void
}) {
  const picking = onPick != null
  return (
    <Box
      sx={{
        display: 'grid',
        gap: 1.25,
        gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 240px), 1fr))'
      }}
    >
      {spools.map((spool) => {
        const loaded = formatLoadedLocation(spool)
        return (
          <Card
            key={spool.id}
            variant="outlined"
            size="sm"
            onClick={picking ? () => onPick(spool) : undefined}
            sx={{ gap: 1, ...(picking ? { cursor: 'pointer' } : {}) }}
          >
            <Stack direction="row" spacing={1} alignItems="flex-start">
              <SpoolColorSwatch colorHex={spool.colorHex} colors={spool.colors} size={36} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography level="title-sm" noWrap>{spoolTitle(spool)}</Typography>
                <Stack direction="row" spacing={0.5} sx={{ mt: 0.25, flexWrap: 'wrap' }}>
                  <Chip size="sm" variant="soft">{spool.materialSubtype ?? spool.filamentType}</Chip>
                  <Chip size="sm" variant="soft" color={STATUS_COLORS[spool.status]}>{STATUS_LABELS[spool.status]}</Chip>
                </Stack>
              </Box>
              {onEdit && onAdjust && onUnassign && onRecycle && (
                <SpoolActionsMenu spool={spool} onEdit={onEdit} onAdjust={onAdjust} onUnassign={onUnassign} onRecycle={onRecycle} />
              )}
            </Stack>
            <CardContent>
              <SpoolRemaining
                remainingGrams={spool.remainingGrams}
                remainPercent={spool.remainPercent}
                netWeightGrams={spool.netWeightGrams}
                size="lg"
              />
            </CardContent>
            {loaded && (
              <Typography level="body-xs" textColor="text.tertiary" noWrap>Loaded: {loaded}</Typography>
            )}
          </Card>
        )
      })}
    </Box>
  )
}
