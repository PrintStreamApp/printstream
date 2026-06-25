/**
 * Reorderable list of the primary nav tabs with up/down move buttons. Used in
 * Settings → General for both the workspace default order and the per-device
 * override. Emits the full ordered list of tab values on every move so callers
 * can persist it directly.
 */
import { IconButton, List, ListItem, Sheet, Stack, Typography } from '@mui/joy'
import KeyboardArrowUpRoundedIcon from '@mui/icons-material/KeyboardArrowUpRounded'
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded'
import { orderNavTabs } from '../../lib/navTabOrder'

export type NavTabOption = { value: string; label: string }

export function NavTabOrderEditor({
  options,
  order,
  onChange,
  disabled = false
}: {
  /** The available nav tabs (any order); the editor displays them in `order`. */
  options: ReadonlyArray<NavTabOption>
  /** Current order (tab values). Unknown/missing values resolve to the default position. */
  order: ReadonlyArray<string>
  /** Receives the full new order (every option's value) after a move. */
  onChange: (order: string[]) => void
  disabled?: boolean
}) {
  const ordered = orderNavTabs([...options], order)

  const move = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= ordered.length) return
    const next = [...ordered]
    const [moved] = next.splice(index, 1)
    if (!moved) return
    next.splice(target, 0, moved)
    onChange(next.map((tab) => tab.value))
  }

  if (ordered.length === 0) {
    return <Typography level="body-sm" textColor="text.tertiary">No nav tabs to order.</Typography>
  }

  return (
    <Sheet variant="outlined" sx={{ borderRadius: 'sm', overflow: 'hidden' }}>
      <List sx={{ '--ListItem-paddingY': '6px', '--ListItem-paddingX': '10px', '--ListDivider-gap': '0px' }}>
        {ordered.map((tab, index) => (
          <ListItem
            key={tab.value}
            sx={{ borderTop: index === 0 ? 'none' : '1px solid', borderColor: 'divider' }}
            endAction={
              <Stack direction="row" spacing={0.25}>
                <IconButton
                  size="sm"
                  variant="plain"
                  color="neutral"
                  aria-label={`Move ${tab.label} up`}
                  disabled={disabled || index === 0}
                  onClick={() => move(index, -1)}
                >
                  <KeyboardArrowUpRoundedIcon />
                </IconButton>
                <IconButton
                  size="sm"
                  variant="plain"
                  color="neutral"
                  aria-label={`Move ${tab.label} down`}
                  disabled={disabled || index === ordered.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <KeyboardArrowDownRoundedIcon />
                </IconButton>
              </Stack>
            }
          >
            <Typography level="body-sm" sx={{ minWidth: 0 }}>{tab.label}</Typography>
          </ListItem>
        ))}
      </List>
    </Sheet>
  )
}
