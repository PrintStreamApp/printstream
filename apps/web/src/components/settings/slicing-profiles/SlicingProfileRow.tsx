/**
 * One custom preset in the slicing-profile manager. The kind chip is deliberately absent: the
 * list is already scoped to one kind by the active tab, so the row shows what the tab does not —
 * the preset's own metadata (printer model, nozzle, material, brand).
 */
import { Button, Card, CardContent, Checkbox, Chip, Stack, Tooltip, Typography } from '@mui/joy'
import type { SlicingProfileSummary } from '@printstream/shared'
import { SLICING_PROFILE_FACETS } from '../../../lib/slicingProfileFacets'

/** Beyond this the chips outweigh the preset name; the rest collapse into a "+N" with a tooltip. */
const MAX_ROW_FACET_CHIPS = 3

export function SlicingProfileRow({
  profile,
  selectionMode,
  selected,
  deleting,
  onToggleSelected,
  onDelete
}: {
  profile: SlicingProfileSummary
  selectionMode: boolean
  selected: boolean
  deleting: boolean
  onToggleSelected: () => void
  onDelete: () => void
}): JSX.Element {
  // Same source as the tab's filters, so a row always shows the values it can be filtered by.
  const facetValues = SLICING_PROFILE_FACETS[profile.kind].flatMap((facet) => facet.valuesOf(profile))
  // Capped: a quality preset can list a dozen compatible printers, which would bury the name.
  const shownValues = facetValues.slice(0, MAX_ROW_FACET_CHIPS)
  const hiddenValueCount = facetValues.length - shownValues.length
  return (
    <Card variant="soft">
      <CardContent>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }}>
          <Stack direction="row" spacing={1} alignItems={{ xs: 'flex-start', sm: 'center' }} sx={{ minWidth: 0, flex: 1 }}>
            {selectionMode && (
              <Checkbox
                checked={selected}
                onChange={() => onToggleSelected()}
                slotProps={{ input: { 'aria-label': `Select ${profile.name}` } }}
              />
            )}
            <Stack spacing={0.35} sx={{ minWidth: 0, flex: 1 }}>
              <Typography level="title-sm" sx={{ minWidth: 0 }}>{profile.name}</Typography>
              {shownValues.length > 0 && (
                <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
                  {shownValues.map((value) => (
                    <Chip key={value} size="sm" variant="outlined">{value}</Chip>
                  ))}
                  {hiddenValueCount > 0 && (
                    <Tooltip title={facetValues.join(', ')} disableInteractive>
                      <Chip size="sm" variant="outlined">+{hiddenValueCount}</Chip>
                    </Tooltip>
                  )}
                </Stack>
              )}
              {profile.updatedAt && (
                <Typography level="body-xs" textColor="text.tertiary">
                  Updated {new Date(profile.updatedAt).toLocaleString()}
                </Typography>
              )}
            </Stack>
          </Stack>
          {!selectionMode ? <Button size="sm" variant="plain" color="danger" loading={deleting} onClick={onDelete}>Delete</Button> : null}
        </Stack>
      </CardContent>
    </Card>
  )
}
