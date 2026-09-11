/**
 * A single button whose click opens a menu of actions. The sibling of `SplitButton`, and the
 * choice between them is about what the label PROMISES.
 *
 * Use a `SplitButton` when there is one obvious action and the rest are variants of it: its wide
 * half performs the labelled action, and the caret is where the alternatives live. Use this when
 * the label names a CATEGORY rather than an action, so every route out of it is a peer. The
 * editor's Add, Save and Slice are all the second kind: "Add" is a choice between library, local
 * file and primitive; "Save" between overwriting the version and saving a new file; "Slice"
 * between this plate and all of them. As split buttons each had a wide half that quietly picked
 * one of those for you, which is how Add ended up opening the library picker in the app and the
 * file picker on the public editor from the same pixel, with nothing on screen saying which.
 *
 * The caret is not decoration: it is the only thing distinguishing this from a button that acts on
 * click. `Dropdown` supplies the clickaway, Escape, keyboard nav and ARIA wiring, and `MenuButton`
 * adds `aria-haspopup="menu"` + `aria-expanded`, so the affordance is announced as well as drawn.
 *
 * A row that is unavailable is a `disabled` `MenuItem`, NOT a reason to disable the button: the
 * menu's other rows are still worth reaching, and the greyed row explains itself in a list the
 * user deliberately opened. `disabled` here means the whole control is unavailable.
 */
import { Box, CircularProgress, Dropdown, Menu, MenuButton, Tooltip, type ColorPaletteProp, type VariantProp } from '@mui/joy'
import type { SxProps } from '@mui/joy/styles/types'
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown'
import type { ReactNode } from 'react'

export function ActionMenuButton({
  label,
  children,
  ariaLabel,
  startDecorator,
  loading = false,
  disabled = false,
  disabledReason,
  size,
  variant = 'solid',
  color = 'primary',
  menuPlacement = 'bottom-end',
  menuSx,
  sx
}: {
  /** What the menu is FOR. A category ("Add", "Slice"), not an action it performs on click. */
  label: ReactNode
  /** The menu's items (Joy `MenuItem`s). */
  children: ReactNode
  ariaLabel: string
  startDecorator?: ReactNode
  /**
   * Work is in flight: swaps `startDecorator` for a spinner and leaves the label in place, rather
   * than Joy's `loading`, which centres the spinner OVER the label and disables the button. The
   * caller decides separately whether that work should also close the menu off, because it differs:
   * a save blocks itself, a slice does not (queueing another plate mid-slice is legitimate).
   */
  loading?: boolean
  /** The whole control is unavailable. For one unavailable ROW, disable that `MenuItem` instead. */
  disabled?: boolean
  /**
   * Why the control is unavailable. Phrase it as STATE ("No printer selected"), not as an
   * instruction about the button.
   */
  disabledReason?: string
  size?: 'sm' | 'md' | 'lg'
  variant?: VariantProp
  color?: ColorPaletteProp
  menuPlacement?: 'bottom-end' | 'bottom-start' | 'top-end' | 'top-start'
  menuSx?: SxProps
  /** Layout for the button itself (flex sizing in a toolbar row, a fixed mobile width). */
  sx?: SxProps
}) {
  const control = (
    <Dropdown>
      <MenuButton
        size={size}
        variant={variant}
        color={color}
        aria-label={ariaLabel}
        disabled={disabled}
        startDecorator={loading ? <CircularProgress size="sm" /> : startDecorator}
        endDecorator={<ArrowDropDownIcon />}
        sx={sx}
      >
        {label}
      </MenuButton>
      <Menu
        placement={menuPlacement}
        sx={[
          { minWidth: 200 },
          ...(Array.isArray(menuSx) ? menuSx : [menuSx])
        ]}
      >
        {children}
      </Menu>
    </Dropdown>
  )
  // A disabled native button swallows hover events, so the tooltip has to sit on an element that
  // still receives them.
  if (disabled && disabledReason) {
    return (
      <Tooltip title={disabledReason} variant="soft" sx={{ maxWidth: 280 }}>
        <Box sx={{ display: 'inline-flex' }}>{control}</Box>
      </Tooltip>
    )
  }
  return control
}
