/**
 * Reorderable list of the primary nav tabs: drag a row, or use its up/down buttons. Used in
 * Settings -> General for both the workspace default order and the per-device override. Emits the
 * full ordered list of tab values on every move so callers can persist it directly.
 *
 * The buttons stay alongside the drag deliberately, they are not a leftover: drag is a pointer-only
 * affordance, so they are the keyboard and assistive path to the same edit. The drag itself is the
 * shared `hooks/useListReorderDrag` (pointer events, hold-to-drag on touch, insertion gaps), which
 * is why this core surface can have it without importing anything from the model-studio plugin.
 */
import { useMemo } from 'react'
import { Box, IconButton, List, ListItem, Sheet, Stack, Typography } from '@mui/joy'
import KeyboardArrowUpRoundedIcon from '@mui/icons-material/KeyboardArrowUpRounded'
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded'
import DragIndicatorRoundedIcon from '@mui/icons-material/DragIndicatorRounded'
import { orderNavTabs } from '../../lib/navTabOrder'
import { useSingleListReorderDrag } from '../../hooks/useListReorderDrag'
import { listGapToIndex } from '../../lib/listReorder'
import { ListReorderCaret } from '../ListReorderCaret'

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
  const ordered = useMemo(() => orderNavTabs([...options], order), [options, order])

  /** The one mover both entry points go through, so the drag and the buttons cannot disagree. */
  const moveTo = (from: number, target: number) => {
    if (from === target || target < 0 || target >= ordered.length) return
    const next = [...ordered]
    const [moved] = next.splice(from, 1)
    if (!moved) return
    next.splice(target, 0, moved)
    onChange(next.map((tab) => tab.value))
  }

  const itemIndices = useMemo(() => ordered.map((_unused, index) => index), [ordered])
  const { drag, setContainerElement, setCaretElement, setTileElement, handleTilePointerDown, shouldSuppressClick } = useSingleListReorderDrag({
    vertical: true,
    itemIndices,
    // The rows ARE the positions here, so the gap converts straight to a target index. The
    // resolved anchor is deliberately unused: it names an item, and `moveTo` wants a position.
    onDrop: (from, insertAt) => moveTo(from, listGapToIndex(from, insertAt))
  })

  if (ordered.length === 0) {
    return <Typography level="body-sm" textColor="text.tertiary">No nav tabs to order.</Typography>
  }

  return (
    <Sheet variant="outlined" sx={{ borderRadius: 'sm', overflow: 'hidden' }}>
      <List
        ref={disabled ? undefined : setContainerElement}
        sx={{ '--ListItem-paddingY': '6px', '--ListItem-paddingX': '10px', '--ListDivider-gap': '0px', position: 'relative' }}
      >
        {ordered.map((tab, index) => (
          <ListItem
            key={tab.value}
            ref={disabled ? undefined : (element: HTMLElement | null) => setTileElement(index, element)}
            // The whole row is the drag handle here (unlike the editor sidebar's rows, which carry
            // switches and menus): the only controls are the move buttons, and they stop the press
            // reaching the row.
            onPointerDown={disabled ? undefined : (event) => {
              if ((event.target as HTMLElement).closest('button')) return
              handleTilePointerDown(index, event)
            }}
            onClick={(event) => { if (shouldSuppressClick()) event.stopPropagation() }}
            sx={{
              borderTop: index === 0 ? 'none' : '1px solid',
              borderColor: 'divider',
              ...(disabled
                ? {}
                : { cursor: 'grab', touchAction: 'none', userSelect: 'none' }),
              ...(drag?.itemIndex === index ? { opacity: 0.4 } : {})
            }}
            endAction={
              <Stack direction="row" spacing={0.25}>
                <IconButton
                  size="sm"
                  variant="plain"
                  color="neutral"
                  aria-label={`Move ${tab.label} up`}
                  disabled={disabled || index === 0}
                  onClick={() => moveTo(index, index - 1)}
                >
                  <KeyboardArrowUpRoundedIcon />
                </IconButton>
                <IconButton
                  size="sm"
                  variant="plain"
                  color="neutral"
                  aria-label={`Move ${tab.label} down`}
                  disabled={disabled || index === ordered.length - 1}
                  onClick={() => moveTo(index, index + 1)}
                >
                  <KeyboardArrowDownRoundedIcon />
                </IconButton>
              </Stack>
            }
          >
            {!disabled && (
              // Affordance only; the row itself is the handle, so this must not take the pointer.
              //
              // The styling sits on a Joy `Box` rather than on the icon, because `sx` on an
              // `@mui/icons-material` icon CRASHES this app: Material's `sx` processor comes from
              // `@mui/system` 9 while the surrounding theme is Joy's from `@mui/system` 5, so it
              // reads a `breakpoints` object with no `internal_mediaKeys` and throws. It takes the
              // whole page down through the route error boundary, and it has bitten here before.
              // The icon keeps `fontSize`, which is a plain prop and safe.
              <Box
                aria-hidden
                sx={{ color: 'text.tertiary', flexShrink: 0, mr: 0.5, display: 'inline-flex' }}
              >
                <DragIndicatorRoundedIcon fontSize="small" />
              </Box>
            )}
            <Typography level="body-sm" sx={{ minWidth: 0 }}>{tab.label}</Typography>
          </ListItem>
        ))}
        <ListReorderCaret setCaretElement={setCaretElement} />
      </List>
    </Sheet>
  )
}
