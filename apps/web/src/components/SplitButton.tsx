import { Box, Button, ButtonGroup, Dropdown, IconButton, Menu, MenuButton, Tooltip, type ColorPaletteProp, type VariantProp } from '@mui/joy'
import type { SxProps } from '@mui/joy/styles/types'
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown'
import type { ReactNode } from 'react'

/**
 * Shared split button: one primary action, with its related variants behind a caret.
 *
 * Owns the Joy wiring (a `Dropdown` around a `ButtonGroup` of `Button` + `MenuButton`, with the
 * `Menu` as the Dropdown's second child so the group marks only its two buttons for corner radii)
 * and, the reason this is shared rather than hand-rolled per caller, the rule for the state
 * where the primary action is unavailable but the menu is not.
 *
 * Contract: `disabled` means the WHOLE control is unavailable (both halves grey, menu cannot
 * open). `primaryDisabled` means only the primary action is: the caret stays live and the group
 * de-emphasises, see `splitButtonGroupAppearance`. `disabledReason` explains either state.
 *
 * Callers: the editor's Add/Save/Slice buttons (`plugins/model-studio/editorPanels.tsx`), the
 * Library upload button (`pages/LibraryView.tsx`), and the printer card's Print button
 * (`components/printers/PrinterCardFooterActions.tsx`). Add new split buttons through here so the
 * disabled-half rule cannot drift between them.
 */
export function SplitButton({
  label,
  onClick,
  children,
  ariaLabel,
  menuAriaLabel = 'More options',
  startDecorator,
  loading = false,
  disabled = false,
  primaryDisabled = false,
  disabledReason,
  size,
  variant = 'solid',
  color = 'primary',
  menuPlacement = 'bottom-end',
  menuSx,
  groupSx
}: {
  /** Primary action label. */
  label: ReactNode
  /** Primary action. */
  onClick: () => void
  /** The caret's menu items (Joy `MenuItem`s). */
  children: ReactNode
  ariaLabel: string
  menuAriaLabel?: string
  startDecorator?: ReactNode
  /** Spinner on the primary half. Joy treats a loading button as disabled. */
  loading?: boolean
  /** The whole control is unavailable, both halves grey and the menu cannot open. */
  disabled?: boolean
  /** Only the primary action is unavailable; the menu stays reachable. */
  primaryDisabled?: boolean
  /**
   * Why the control is unavailable. Phrase it as STATE ("No unsaved changes"), not as an
   * instruction about the button: it is shown for the whole group, including the live caret.
   */
  disabledReason?: string
  size?: 'sm' | 'md' | 'lg'
  variant?: VariantProp
  color?: ColorPaletteProp
  menuPlacement?: 'bottom-end' | 'bottom-start' | 'top-end' | 'top-start'
  menuSx?: SxProps
  /**
   * Layout for the control itself (flex sizing in a toolbar row, a fixed mobile
   * width). On the GROUP rather than the primary button, so the caret is inside
   * whatever box the caller sizes instead of overflowing it.
   */
  groupSx?: SxProps
}) {
  const appearance = splitButtonGroupAppearance({ variant, color, disabled, primaryDisabled })
  const group = (
    <Dropdown>
      <ButtonGroup size={size} variant={appearance.variant} color={appearance.color} disabled={disabled} aria-label={ariaLabel} sx={groupSx}>
        {/* Both gates are passed explicitly: Joy's Button prefers its OWN `disabled` prop over the
            group's whenever the prop is present, so `disabled={primaryDisabled}` alone would
            re-enable the primary half inside a fully disabled group. */}
        <Button loading={loading} disabled={disabled || primaryDisabled} startDecorator={startDecorator} onClick={onClick}>{label}</Button>
        {/* IconButton root so the caret inherits the group's variant/color (a default MenuButton
            renders as its own Button and reads as a detached control). */}
        <MenuButton slots={{ root: IconButton }} aria-label={menuAriaLabel}>
          <ArrowDropDownIcon />
        </MenuButton>
      </ButtonGroup>
      {/* The decorator rule pins the icon gutter for every item. Joy sizes a
          `ListItemDecorator` per MenuItem, and in practice it does NOT come out the
          same for all of them: measured in this menu, the first item's decorator
          took `--ListItemDecorator-size` (40px) while its siblings collapsed to 0,
          so identical markup rendered labels 20px apart. Declaring it once here
          means an item cannot be misaligned by what it happens to sit next to,
          which matters most for the plugin-contributed items a caller never sees. */}
      <Menu
        placement={menuPlacement}
        sx={[
          { minWidth: 200, '& .MuiListItemDecorator-root': { minInlineSize: 'var(--ListItemDecorator-size)' } },
          ...(Array.isArray(menuSx) ? menuSx : [menuSx])
        ]}
      >
        {children}
      </Menu>
    </Dropdown>
  )
  // A disabled native button swallows hover events, so the tooltip has to sit on an element that
  // still receives them. It wraps the whole group rather than the primary half because a wrapper
  // INSIDE the group would take the first/last-child corner radii that belong to the button,
  // hence the "phrase it as state" rule on `disabledReason`, since the live caret shows it too.
  if ((disabled || primaryDisabled) && disabledReason) {
    return (
      <Tooltip title={disabledReason} variant="soft" sx={{ maxWidth: 280 }}>
        <Box sx={{ display: 'inline-flex' }}>{group}</Box>
      </Tooltip>
    )
  }
  return group
}

/**
 * Variant/color for the group, given which halves are live.
 *
 * When only the primary half is disabled, the group drops to soft/neutral. Joy applies disabled
 * styling per child, so an emphasised group in that state greys its primary half while the caret
 * keeps the solid fill: the loudest pixel becomes the secondary affordance, and the control reads
 * as two unrelated buttons instead of one with two entry points. Muting both halves keeps them at
 * one weight, and the emphasis returning is then a useful signal that the action is available.
 *
 * A fully `disabled` group keeps its own variant/color: Joy greys both halves anyway, so there is
 * no mismatch to correct, and rewriting it would make the two disabled states look different.
 */
// eslint-disable-next-line react-refresh/only-export-components -- pure leaf rule colocated with its sole caller.
export function splitButtonGroupAppearance({
  variant,
  color,
  disabled,
  primaryDisabled
}: {
  variant: VariantProp
  color: ColorPaletteProp
  disabled: boolean
  primaryDisabled: boolean
}): { variant: VariantProp, color: ColorPaletteProp } {
  if (primaryDisabled && !disabled) return { variant: 'soft', color: 'neutral' }
  return { variant, color }
}
