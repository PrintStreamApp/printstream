/**
 * One preset in the slicing-profile manager: the workspace's own or a built-in. The kind chip is deliberately absent: the
 * list is already scoped to one kind by the active tab, so the row shows what the tab does not:
 * the preset's own metadata (printer model, nozzle, material, brand).
 *
 * Laid out as a dense LINE, not a card: these lists run to hundreds of presets (594 process presets
 * on a stock catalogue), so a card per preset meant scrolling past a handful at a time. Reads
 * table-like, aligned columns, a hairline between rows, a hover highlight, without being a
 * `<table>`, which would not survive the 375px width this has to work at. The row owns its own
 * separator so the list container can stack rows with no gap.
 */
import { Box, Button, Checkbox, Chip, Stack, Tooltip, Typography } from '@mui/joy'
import type { SlicingPresetSummary } from '@printstream/shared'
import { SLICING_PRESET_FACETS } from '../../../lib/slicingPresetFacets'

/** Beyond this the chips outweigh the preset name; the rest collapse into a "+N" with a tooltip. */
const MAX_ROW_FACET_CHIPS = 3

export function SlicingPresetRow({
  profile,
  selectionMode,
  selected,
  deleting,
  onToggleSelected,
  onDelete,
  onOpen
}: {
  profile: SlicingPresetSummary
  selectionMode: boolean
  selected: boolean
  deleting: boolean
  onToggleSelected: () => void
  onDelete: () => void
  /** Absent when this kind has no editor to open yet. */
  onOpen?: () => void
}): JSX.Element {
  // A built-in belongs to the slicer, not the workspace: it cannot be deleted or bulk-selected,
  // and its editor opens read-only-with-save-as (see `canEditOriginal`).
  const isBuiltin = profile.source === 'builtin'
  // Same source as the tab's filters, so a row always shows the values it can be filtered by.
  const facetValues = SLICING_PRESET_FACETS[profile.kind].flatMap((facet) => facet.valuesOf(profile))
  // Capped: a quality preset can list a dozen compatible printers, which would bury the name.
  const shownValues = facetValues.slice(0, MAX_ROW_FACET_CHIPS)
  const hiddenValueCount = facetValues.length - shownValues.length
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        minWidth: 0,
        px: 1,
        py: 0.5,
        borderBottom: '1px solid',
        borderColor: 'divider',
        '&:last-of-type': { borderBottom: 'none' },
        '&:hover': { bgcolor: 'background.level1' }
      }}
    >
      {selectionMode && !isBuiltin && (
        <Checkbox
          size="sm"
          checked={selected}
          onChange={() => onToggleSelected()}
          slotProps={{ input: { 'aria-label': `Select ${profile.name}` } }}
          sx={{ flexShrink: 0 }}
        />
      )}
      {/* The name is the row's identity, so it takes the slack and truncates rather than wrapping. */}
      <Typography level="body-sm" noWrap sx={{ minWidth: '8rem', flex: 1 }}>{profile.name}</Typography>
      {isBuiltin && <Chip size="sm" variant="soft" color="neutral" sx={{ flexShrink: 0 }}>Built-in</Chip>}
      {/* Metadata and the timestamp are the first things to go as the row narrows: the name and
          the actions are what a phone needs. Hidden rather than wrapped, which is what kept the
          row one line tall. */}
      {shownValues.length > 0 && (
        <Stack
          direction="row"
          spacing={0.5}
          sx={{
            // Capped and shrinkable, unlike the name: a process preset can carry a dozen printer
            // chips, and letting them hold their width squeezed the name, the row's identity,
            // down to an ellipsis. They clip instead; the full set is in the "+N" tooltip.
            minWidth: 0,
            flexShrink: 1,
            maxWidth: '45%',
            overflow: 'hidden',
            display: { xs: 'none', md: 'flex' }
          }}
        >
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
        <Typography
          level="body-xs"
          textColor="text.tertiary"
          noWrap
          sx={{ flexShrink: 0, display: { xs: 'none', lg: 'block' } }}
        >
          {new Date(profile.updatedAt).toLocaleDateString()}
        </Typography>
      )}
      {!selectionMode && (
        <Stack direction="row" spacing={0.25} sx={{ flexShrink: 0 }}>
          {onOpen && (
            <Button size="sm" variant="plain" onClick={onOpen}>{isBuiltin ? 'View' : 'Edit'}</Button>
          )}
          {!isBuiltin && (
            <Button size="sm" variant="plain" color="danger" loading={deleting} onClick={onDelete}>Delete</Button>
          )}
        </Stack>
      )}
    </Box>
  )
}
