/** Live tag chips use the same vocabulary cache as assignment and filtering. */
import { Chip, Stack } from '@mui/joy'
import CircleIcon from '@mui/icons-material/Circle'
import type { TagEntityKind } from '@printstream/shared'
import { useEntityTags } from '../../hooks/useEntityTags'

export function EntityTagChips({ kind, id, align = 'left', chipSx }: { kind: TagEntityKind; id: string; align?: 'left' | 'center' | 'right'; chipSx?: Record<string, unknown> }) {
  const justifyContent = { left: 'flex-start', center: 'center', right: 'flex-end' }[align]
  const { assignedTags } = useEntityTags(kind)
  const tags = assignedTags(id)
  if (!tags.length) return null
  return <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', justifyContent }}>
    {tags.map((tag) => <Chip key={tag.id} size="sm" sx={{ maxWidth: '100%', ...chipSx }} variant="soft" title={tag.group || undefined} startDecorator={<CircleIcon style={{ color: tag.color, fontSize: '0.8em' }} />}>{tag.name}</Chip>)}
  </Stack>
}
