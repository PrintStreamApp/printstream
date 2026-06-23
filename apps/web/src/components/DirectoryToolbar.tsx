import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown'
import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import TuneRoundedIcon from '@mui/icons-material/TuneRounded'
import {
  Box,
  Button,
  DialogActions,
  DialogTitle,
  Divider,
  Dropdown,
  FormControl,
  Input,
  Menu,
  MenuButton,
  ModalClose,
  Option,
  Select,
  Stack
} from '@mui/joy'
import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { BackAwareModal as Modal } from './BackAwareModal'
import {
  DirectorySortViewControls,
  type DirectorySortDirection,
  type DirectorySortOption,
  type DirectoryViewMode
} from './DirectoryControls'
import { ViewModeToggle } from './ViewModeToggle'
import { ScrollableDialogBody, ScrollableModalDialog } from './ScrollableDialog'
import { useMobileViewport } from './useMobileViewport'

type PageSizeOption<T extends string | number> = {
  value: T
  label: string
}

export function DirectoryPrimaryToolbar<TSort extends string, TPageSize extends string | number>({
  searchValue,
  onSearchChange,
  searchPlaceholder,
  searchAriaLabel,
  searchEndDecorator,
  filtersButton,
  pageSizeValue,
  pageSizeOptions,
  onPageSizeChange,
  pageSizeAriaLabel,
  pageSizeRenderValue,
  sortValue,
  sortOptions,
  onSortValueChange,
  sortDirection,
  onSortDirectionChange,
  sortAriaLabel,
  viewMode,
  onViewModeChange,
  disableIconModeOnMobile = false,
  rightAlignViewModeOnMobile = false,
  sortMinWidth = 140
}: {
  searchValue: string
  onSearchChange: (value: string) => void
  searchPlaceholder: string
  searchAriaLabel: string
  /** Optional control rendered at the right end of the search field (e.g. a scope toggle). */
  searchEndDecorator?: ReactNode
  filtersButton?: ReactNode
  pageSizeValue: TPageSize
  pageSizeOptions: ReadonlyArray<PageSizeOption<TPageSize>>
  onPageSizeChange: (value: TPageSize) => void
  pageSizeAriaLabel: string
  pageSizeRenderValue: (value: TPageSize) => string
  sortValue: TSort
  sortOptions: ReadonlyArray<DirectorySortOption<TSort>>
  onSortValueChange: (value: TSort) => void
  sortDirection: DirectorySortDirection
  onSortDirectionChange: (direction: DirectorySortDirection) => void
  sortAriaLabel: string
  viewMode?: DirectoryViewMode
  onViewModeChange?: (mode: DirectoryViewMode) => void
  disableIconModeOnMobile?: boolean
  rightAlignViewModeOnMobile?: boolean
  sortMinWidth?: number | string
}) {
  const isMobile = useMobileViewport()
  const hasViewModeToggle = viewMode != null && onViewModeChange != null
  const showInlineViewModeToggle = hasViewModeToggle && (!disableIconModeOnMobile || !isMobile)
  const hasFiltersButton = filtersButton != null

  return (
    <Stack spacing={1}>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: {
            xs: hasFiltersButton ? 'minmax(0, 1fr) auto' : 'minmax(0, 1fr)',
            md: 'repeat(4, minmax(0, 1fr))'
          },
          gap: 1,
          alignItems: 'center'
        }}
      >
        <Input
          size="sm"
          value={searchValue}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={searchPlaceholder}
          startDecorator={<SearchRoundedIcon />}
          endDecorator={searchEndDecorator}
          slotProps={{ input: { 'aria-label': searchAriaLabel } }}
          sx={{ minWidth: 0, gridColumn: { md: hasFiltersButton ? 'span 3' : '1 / span 4' } }}
        />
        {hasFiltersButton && (
          <Box sx={{ justifySelf: 'stretch', width: { md: '100%' }, '& > *': { width: '100%' } }}>
            {filtersButton}
          </Box>
        )}
      </Box>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: {
            xs: 'repeat(2, minmax(0, 1fr))',
            md: 'repeat(4, minmax(0, 1fr))'
          },
          gap: 1,
          alignItems: 'center'
        }}
      >
        <Box sx={{ width: '100%', minWidth: 0, gridColumn: { md: '1' } }}>
          <DirectorySortViewControls
            sortValue={sortValue}
            sortOptions={sortOptions}
            onSortValueChange={onSortValueChange}
            sortDirection={sortDirection}
            onSortDirectionChange={onSortDirectionChange}
            sortAriaLabel={sortAriaLabel}
            disableIconModeOnMobile={disableIconModeOnMobile}
            rightAlignViewModeOnMobile={rightAlignViewModeOnMobile}
            stretchToContainer
            sortMinWidth={sortMinWidth}
          />
        </Box>
        <Stack
          direction="row"
          spacing={1}
          justifyContent="flex-end"
          alignItems="center"
          sx={{ minWidth: 0, width: '100%', gridColumn: { md: '4' } }}
        >
          <FormControl
            sx={{
              flex: { xs: '0 1 auto', md: '1 1 auto' },
              width: { xs: 'auto', md: '100%' },
              minWidth: 0,
              maxWidth: '100%'
            }}
          >
            <Select<TPageSize>
              size="sm"
              value={pageSizeValue}
              onChange={(_event, value) => value && onPageSizeChange(value)}
              renderValue={() => pageSizeRenderValue(pageSizeValue)}
              slotProps={{
                button: {
                  'aria-label': pageSizeAriaLabel,
                  sx: {
                    maxWidth: '100%',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }
                }
              }}
              sx={{ width: '100%', minWidth: 0, maxWidth: '100%' }}
            >
              {pageSizeOptions.map((option) => (
                <Option key={String(option.value)} value={option.value}>{option.label}</Option>
              ))}
            </Select>
          </FormControl>
          {showInlineViewModeToggle && viewMode && onViewModeChange && (
            <ViewModeToggle viewMode={viewMode} onViewModeChange={onViewModeChange} />
          )}
        </Stack>
      </Box>
    </Stack>
  )
}

export function DirectoryFiltersButton({
  activeCount = 0,
  onClick,
  disabled = false
}: {
  activeCount?: number
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <Button
      size="sm"
      variant={activeCount > 0 ? 'soft' : 'outlined'}
      color={activeCount > 0 ? 'primary' : 'neutral'}
      startDecorator={<TuneRoundedIcon />}
      onClick={onClick}
      disabled={disabled}
    >
      {activeCount > 0 ? `Filters (${activeCount})` : 'Filters'}
    </Button>
  )
}

/**
 * Filters as an inline dropdown panel: a Filters button (with an active-count
 * badge) that opens a small anchored menu holding the filter controls plus an
 * optional Clear action — the dropdown alternative to the modal
 * {@link DirectoryFiltersDialog}. Filter `Select`s passed as children should set
 * `slotProps={{ listbox: { disablePortal: true } }}` so opening one doesn't
 * dismiss the panel (a portaled listbox reads as an outside click).
 */
export function DirectoryFiltersMenu({
  activeCount = 0,
  disabled = false,
  onClear,
  clearDisabled = false,
  children
}: {
  activeCount?: number
  disabled?: boolean
  onClear?: () => void
  clearDisabled?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Joy's Menu dismisses on focus-out, which never fires when the panel holds form
  // controls and the user clicks a non-focusable area — so the dropdown would stay open
  // until the button is clicked again. Add an explicit outside-pointer close. The
  // disablePortal Select listboxes render inside the menu, so option clicks count as
  // inside and keep the panel open.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

  return (
    <Dropdown open={open} onOpenChange={(_event, isOpen) => setOpen(isOpen)}>
      <MenuButton
        ref={buttonRef}
        slots={{ root: Button }}
        slotProps={{ root: {
          size: 'sm',
          variant: activeCount > 0 ? 'soft' : 'outlined',
          color: activeCount > 0 ? 'primary' : 'neutral',
          startDecorator: <TuneRoundedIcon />,
          endDecorator: <ArrowDropDownIcon />,
          disabled
        } }}
      >
        {activeCount > 0 ? `Filters (${activeCount})` : 'Filters'}
      </MenuButton>
      <Menu
        ref={menuRef}
        placement="bottom-end"
        // overflow/maxHeight: let nested (disablePortal) Select listboxes overflow the
        // panel rather than being clipped or forcing the whole panel to scroll.
        // zIndex: the panel must surface above a modal dialog (the print picker), so lift
        // it to the `tooltip` layer — the default `popup` z-index sits below `modal`.
        sx={{ p: 1.5, minWidth: 260, maxWidth: 'min(340px, 92vw)', overflow: 'visible', maxHeight: 'none', zIndex: (theme) => theme.zIndex.tooltip }}
      >
        <Stack spacing={1.25} sx={{ minWidth: 0 }}>
          {children}
          {onClear && (
            <>
              <Divider sx={{ my: 0.25 }} />
              <Button
                size="sm"
                variant="plain"
                color="neutral"
                onClick={onClear}
                disabled={clearDisabled}
                sx={{ alignSelf: 'flex-end' }}
              >
                Clear filters
              </Button>
            </>
          )}
        </Stack>
      </Menu>
    </Dropdown>
  )
}

export function DirectoryFiltersDialog({
  open,
  title,
  onClose,
  onClear,
  clearDisabled = false,
  children
}: {
  open: boolean
  title: string
  onClose: () => void
  onClear?: () => void
  clearDisabled?: boolean
  children: ReactNode
}) {
  return (
    <Modal open={open} onClose={() => onClose()}>
      <ScrollableModalDialog variant="outlined" sx={{ width: { xs: '100%', sm: 560 }, maxWidth: '100%' }}>
        <ModalClose />
        <DialogTitle>{title}</DialogTitle>
        <ScrollableDialogBody>
          <Stack spacing={1.25}>
            {children}
          </Stack>
        </ScrollableDialogBody>
        <DialogActions>
          {onClear && (
            <Button size="sm" variant="plain" color="neutral" onClick={onClear} disabled={clearDisabled}>
              Clear filters
            </Button>
          )}
          <Button size="sm" variant="solid" color="primary" onClick={onClose}>
            Done
          </Button>
        </DialogActions>
      </ScrollableModalDialog>
    </Modal>
  )
}