/**
 * List (table) view of spools for desktop-style scanning. Each row shows the
 * colour + title, material, a remaining bar, where it's loaded, status, and the
 * overflow actions menu.
 */
import { Box, Chip, Sheet, Stack, Table, Typography } from '@mui/joy'
import type { FilamentSpool } from '@printstream/shared'
import { SpoolColorSwatch, SpoolRemaining } from './SpoolVisuals'
import { SpoolActionsMenu } from './SpoolActionsMenu'
import { STATUS_COLORS, STATUS_LABELS, formatLoadedLocation, spoolTitle } from './filters'

export function SpoolList({
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
  /** When set, rows are clickable to pick a spool and the actions column is hidden. */
  onPick?: (spool: FilamentSpool) => void
}) {
  const picking = onPick != null
  const canAct = !picking && Boolean(onEdit && onAdjust && onUnassign && onRecycle)
  return (
    <Sheet variant="outlined" sx={{ borderRadius: 'sm', overflow: 'auto' }}>
      <Table size="sm" borderAxis="xBetween" hoverRow stripe="odd" sx={{ '--TableCell-headBackground': 'transparent' }}>
        <thead>
          <tr>
            <th style={{ width: '30%' }}>Spool</th>
            <th style={{ width: 96 }}>Material</th>
            <th style={{ width: 110 }}>Brand</th>
            <th style={{ width: '20%' }}>Remaining</th>
            <th>Loaded</th>
            <th style={{ width: 104 }}>Status</th>
            {canAct && <th style={{ width: 56 }} aria-label="Actions" />}
          </tr>
        </thead>
        <tbody>
          {spools.map((spool) => {
            const loaded = formatLoadedLocation(spool)
            return (
              <tr
                key={spool.id}
                onClick={picking ? () => onPick(spool) : undefined}
                style={picking ? { cursor: 'pointer' } : undefined}
              >
                <th scope="row">
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
                    <SpoolColorSwatch colorHex={spool.colorHex} colors={spool.colors} />
                    <Typography level="title-sm" noWrap>{spoolTitle(spool)}</Typography>
                  </Stack>
                </th>
                <td>
                  <Chip size="sm" variant="soft">{spool.materialSubtype ?? spool.filamentType}</Chip>
                </td>
                <td>
                  <Typography level="body-sm" noWrap textColor={spool.brand ? undefined : 'text.tertiary'}>
                    {spool.brand ?? '—'}
                  </Typography>
                </td>
                <td>
                  <SpoolRemaining
                    remainingGrams={spool.remainingGrams}
                    remainPercent={spool.remainPercent}
                    netWeightGrams={spool.netWeightGrams}
                  />
                </td>
                <td>
                  <Typography level="body-sm" textColor={loaded ? undefined : 'text.tertiary'} noWrap>
                    {loaded ?? '—'}
                  </Typography>
                </td>
                <td>
                  <Chip size="sm" variant="soft" color={STATUS_COLORS[spool.status]}>{STATUS_LABELS[spool.status]}</Chip>
                </td>
                {onEdit && onAdjust && onUnassign && onRecycle && (
                  <td>
                    <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <SpoolActionsMenu spool={spool} onEdit={onEdit} onAdjust={onAdjust} onUnassign={onUnassign} onRecycle={onRecycle} />
                    </Box>
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </Table>
    </Sheet>
  )
}
