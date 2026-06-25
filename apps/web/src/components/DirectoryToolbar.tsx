import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown'
import CategoryRoundedIcon from '@mui/icons-material/CategoryRounded'
import FormatListNumberedRoundedIcon from '@mui/icons-material/FormatListNumberedRounded'
import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import SortRoundedIcon from '@mui/icons-material/SortRounded'
import TuneRoundedIcon from '@mui/icons-material/TuneRounded'
import {
  Box,
  Button,
  Divider,
  Dropdown,
  IconButton,
  Input,
  ListDivider,
  Menu,
  MenuButton,
  MenuItem,
  Option,
  Select,
  Stack,
  Tooltip,
  Typography
} from '@mui/joy'
import React, { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  type DirectorySortDirection,
  type DirectorySortOption,
  type DirectoryViewMode
} from './DirectoryControls'
import { ViewModeToggle } from './ViewModeToggle'
import { useMobileViewport } from './useMobileViewport'

type PageSizeOption<T extends string | number> = {
  value: T
  label: string
}

/**
 * Toolbar control sizing. The sort/grouping/filters/page-size controls are all
 * the same kind of dropdown button (leading icon + current value + chevron) and
 * the same compact size — bounded by a sensible min/max rather than stretched —
 * so the row reads as one consistent set.
 */
const TOOLBAR_CONTROL_SX = { minWidth: 130, maxWidth: 220 } as const
/** Content-width sizing for compact containers (modals) where the fixed min-width would wrap the row. */
const TOOLBAR_CONTROL_COMPACT_SX = { minWidth: 0, maxWidth: 200 } as const

/** Truncating value label inside a toolbar dropdown button (value left, chevron right). */
function ToolbarButtonLabel({ children }: { children: ReactNode }) {
  return (
    <Box
      component="span"
      sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}
    >
      {children}
    </Box>
  )
}

/**
 * Shared outside-pointer close for the toolbar dropdown panels. Joy's Menu
 * dismisses on focus-out, which never fires when a panel holds non-focusable
 * regions (the filters form) — so add an explicit outside-pointer close. The
 * disablePortal listboxes inside a panel render within the menu, so option
 * clicks count as inside and keep the panel open.
 */
function useToolbarDropdownClose(
  open: boolean,
  setOpen: (open: boolean) => void,
  buttonRef: React.RefObject<HTMLButtonElement>,
  menuRef: React.RefObject<HTMLDivElement>
) {
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
  }, [open, setOpen, buttonRef, menuRef])
}

/**
 * The shared shell for every primary-toolbar dropdown control (sort, grouping,
 * filters, page size). An outlined neutral button shows a leading icon, the
 * current value, and a chevron — styled to read like the native printers
 * "View:" select — and opens an anchored panel. `variant="list"` is a plain
 * options menu; `variant="panel"` is a wider padded surface (the filters form),
 * which is allowed to overflow so nested `Select` listboxes are not clipped.
 */
function ToolbarMenuButton({
  icon,
  label,
  ariaLabel,
  disabled = false,
  variant = 'list',
  widthSx = TOOLBAR_CONTROL_SX,
  children
}: {
  icon: ReactNode
  label: ReactNode
  ariaLabel: string
  disabled?: boolean
  variant?: 'list' | 'panel'
  /** Width sizing for the trigger button (defaults to the standard control sizing). */
  widthSx?: typeof TOOLBAR_CONTROL_SX | typeof TOOLBAR_CONTROL_COMPACT_SX
  /** Panel content. Receives `close` so option clicks can dismiss the menu. */
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useToolbarDropdownClose(open, setOpen, buttonRef, menuRef)

  // zIndex tooltip: the panel must surface above a modal dialog (the print picker);
  // the default popup z-index sits below modal.
  const menuSx = variant === 'panel'
    ? { p: 1.5, minWidth: 260, maxWidth: 'min(340px, 92vw)', overflow: 'visible', maxHeight: 'none', zIndex: (theme: { zIndex: { tooltip: number } }) => theme.zIndex.tooltip }
    : { minWidth: TOOLBAR_CONTROL_SX.minWidth, maxHeight: 'min(60vh, 420px)', overflow: 'auto', zIndex: (theme: { zIndex: { tooltip: number } }) => theme.zIndex.tooltip }

  return (
    <Dropdown open={open} onOpenChange={(_event, isOpen) => setOpen(isOpen)}>
      <MenuButton
        ref={buttonRef}
        slots={{ root: Button }}
        slotProps={{ root: {
          size: 'sm',
          variant: 'outlined',
          color: 'neutral',
          'aria-label': ariaLabel,
          startDecorator: icon,
          endDecorator: <ArrowDropDownIcon />,
          disabled,
          sx: widthSx
        } }}
      >
        <ToolbarButtonLabel>{label}</ToolbarButtonLabel>
      </MenuButton>
      <Menu ref={menuRef} placement="bottom-start" sx={menuSx}>
        {children(() => setOpen(false))}
      </Menu>
    </Dropdown>
  )
}

/**
 * A single-select option row for the list menus (sort, grouping, page size). The
 * current value is shown with Joy's `selected` highlight only — no checkmark.
 * Checkmarks are reserved for multi-select dropdowns (see {@link MultiSelectOption}),
 * where they signal that more than one value can be picked.
 */
function ToolbarOptionItem({
  selected,
  onClick,
  children
}: {
  selected: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <MenuItem selected={selected} onClick={onClick}>
      {children}
    </MenuItem>
  )
}

/** Grouping config for the toolbar (rendered as a button on desktop, a section on mobile). */
export type DirectoryGroupingConfig<G extends string> = {
  value: G
  options: ReadonlyArray<DirectoryGroupOption<G>>
  onChange: (value: G) => void
}

/** Filters config for the toolbar (a dropdown button on desktop, a section on mobile). */
export type DirectoryFiltersConfig = {
  activeCount?: number
  onClear?: () => void
  clearDisabled?: boolean
  disabled?: boolean
  /** The filter controls. `Select`s should set `slotProps={{ listbox: { disablePortal: true } }}`. */
  children: ReactNode
}

export function DirectoryPrimaryToolbar<TSort extends string, TPageSize extends string | number, TGroup extends string = string>({
  searchValue,
  onSearchChange,
  searchPlaceholder,
  searchAriaLabel,
  searchEndDecorator,
  filters,
  grouping,
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
  compactControls = false
}: {
  searchValue: string
  onSearchChange: (value: string) => void
  searchPlaceholder: string
  searchAriaLabel: string
  /** Optional control rendered at the right end of the search field (e.g. a scope toggle). */
  searchEndDecorator?: ReactNode
  filters?: DirectoryFiltersConfig
  grouping?: DirectoryGroupingConfig<TGroup>
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
  /**
   * Force the compact (phone-style) layout regardless of viewport: sort/grouping/
   * filters collapse into one combined dropdown and page size shows just the
   * number. Use inside a narrow container (e.g. a modal) so the second row fits on
   * one line instead of wrapping.
   */
  compactControls?: boolean
}) {
  const isMobile = useMobileViewport()
  const showViewModeToggle = viewMode != null && onViewModeChange != null && (!disableIconModeOnMobile || !isMobile)
  const sortConfig = {
    value: sortValue,
    options: sortOptions,
    onChange: onSortValueChange,
    direction: sortDirection,
    onDirectionChange: onSortDirectionChange,
    ariaLabel: sortAriaLabel
  }

  // Sort + grouping + filters collapse into one combined dropdown only when the row
  // is too narrow to show them as separate buttons (e.g. a tight modal); when there
  // is room they break back out. We measure the row's available width and compare it
  // against the width the separate controls need. Before the first measurement we
  // fall back to the caller's hint (mobile / compactControls) to avoid a flash.
  const rowRef = useRef<HTMLDivElement>(null)
  const [rowWidth, setRowWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const element = rowRef.current
    if (!element) return
    const measure = () => setRowWidth(element.getBoundingClientRect().width)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const dropdownControlCount = 1 /* sort */ + (grouping != null ? 1 : 0) + (filters != null ? 1 : 0) + 1 /* page size */
  const controlCount = dropdownControlCount + (showViewModeToggle ? 1 : 0)
  // Estimated width the separate controls need on one row (dropdowns ~150, view-mode
  // toggle ~84, 8px gaps, plus a small buffer so labels don't truncate).
  const widthForSeparate = dropdownControlCount * 150 + (showViewModeToggle ? 84 : 0) + 8 * Math.max(0, controlCount - 1) + 16
  const fitsSeparate = rowWidth == null ? !(isMobile || compactControls) : rowWidth >= widthForSeparate
  const combineControls = !fitsSeparate && (grouping != null || filters != null)
  // When combined the row is intentionally compact: stay on one line and shorten the
  // page-size label to just the number.
  const compact = combineControls

  return (
    <Stack spacing={1}>
      {/* Row 1: search. */}
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', minWidth: 0 }}>
        <Input
          size="sm"
          value={searchValue}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={searchPlaceholder}
          startDecorator={<SearchRoundedIcon />}
          endDecorator={searchEndDecorator}
          slotProps={{ input: { 'aria-label': searchAriaLabel } }}
          sx={{ flex: '1 1 auto', minWidth: 0 }}
        />
      </Box>

      {/* Row 2: sort, grouping, filters on the left; page size + view mode anchored
          to the right end. On phones sort/grouping/filters collapse into one
          combined dropdown. In compact mode the row stays on one line (nowrap) so a
          fit-content container (e.g. the print dialog) grows to fit it instead of
          wrapping the controls. */}
      <Box ref={rowRef} sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: compact ? 'nowrap' : 'wrap', minWidth: 0 }}>
        {combineControls ? (
          <DirectoryControlsMenu sort={sortConfig} grouping={grouping} filters={filters} />
        ) : (
          <>
            <DirectorySortMenu {...sortConfig} />
            {grouping && (
              <DirectoryGroupingMenu value={grouping.value} options={grouping.options} onChange={grouping.onChange} />
            )}
            {filters && (
              <DirectoryFiltersMenu activeCount={filters.activeCount} onClear={filters.onClear} clearDisabled={filters.clearDisabled} disabled={filters.disabled}>
                {filters.children}
              </DirectoryFiltersMenu>
            )}
          </>
        )}
        <Box sx={{ ml: 'auto', display: 'flex', gap: 1, alignItems: 'center', flexShrink: 0 }}>
          <DirectoryPageSizeMenu
            value={pageSizeValue}
            options={pageSizeOptions}
            onChange={onPageSizeChange}
            ariaLabel={pageSizeAriaLabel}
            renderValue={pageSizeRenderValue}
            compact={compact}
          />
          {showViewModeToggle && viewMode && onViewModeChange && (
            <ViewModeToggle viewMode={viewMode} onViewModeChange={onViewModeChange} />
          )}
        </Box>
      </Box>
    </Stack>
  )
}

type DirectorySortConfig<T extends string> = {
  value: T
  options: ReadonlyArray<DirectorySortOption<T>>
  onChange: (value: T) => void
  direction: DirectorySortDirection
  onDirectionChange: (direction: DirectorySortDirection) => void
  ariaLabel: string
}

/**
 * Combined sort + grouping + filters dropdown used on phones, where the three
 * separate buttons would not fit. One button opens a panel with a Sort section
 * (field + direction), an optional Group section, and an optional Filters section
 * (the same filter controls, plus Clear).
 */
function DirectoryControlsMenu<TSort extends string, TGroup extends string>({
  sort,
  grouping,
  filters
}: {
  sort: DirectorySortConfig<TSort>
  grouping?: DirectoryGroupingConfig<TGroup>
  filters?: DirectoryFiltersConfig
}) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useToolbarDropdownClose(open, setOpen, buttonRef, menuRef)

  return (
    <Dropdown open={open} onOpenChange={(_event, isOpen) => setOpen(isOpen)}>
      <MenuButton
        ref={buttonRef}
        slots={{ root: Button }}
        slotProps={{ root: {
          size: 'sm',
          variant: 'outlined',
          color: 'neutral',
          'aria-label': 'Sort, group, and filter',
          startDecorator: <TuneRoundedIcon />,
          endDecorator: <ArrowDropDownIcon />,
          sx: TOOLBAR_CONTROL_SX
        } }}
      >
        <ToolbarButtonLabel>Sort &amp; filter</ToolbarButtonLabel>
      </MenuButton>
      <Menu
        ref={menuRef}
        placement="bottom-start"
        sx={{ p: 1.5, minWidth: 260, maxWidth: 'min(340px, 92vw)', overflow: 'visible', maxHeight: 'none', zIndex: (theme) => theme.zIndex.tooltip }}
      >
        <Stack spacing={1.25} sx={{ minWidth: 0 }}>
          <Stack spacing={0.5}>
            <Typography level="title-sm">Sort</Typography>
            <Stack direction="row" spacing={1}>
              <Select<TSort>
                size="sm"
                value={sort.value}
                onChange={(_event, value) => value && sort.onChange(value)}
                slotProps={{ listbox: { disablePortal: true } }}
                sx={{ flex: 1, minWidth: 0 }}
              >
                {sort.options.map((option) => <Option key={option.value} value={option.value}>{option.label}</Option>)}
              </Select>
              <Tooltip title={sort.direction === 'asc' ? 'Ascending' : 'Descending'}>
                <IconButton
                  size="sm"
                  variant="outlined"
                  color="neutral"
                  aria-label={`Sort ${sort.direction === 'asc' ? 'ascending' : 'descending'}`}
                  onClick={() => sort.onDirectionChange(sort.direction === 'asc' ? 'desc' : 'asc')}
                >
                  <SortRoundedIcon style={{ transform: sort.direction === 'asc' ? 'scaleY(-1)' : undefined }} />
                </IconButton>
              </Tooltip>
            </Stack>
          </Stack>
          {grouping && (
            <>
              <ListDivider sx={{ my: 0.25 }} />
              <Stack spacing={0.5}>
                <Typography level="title-sm">Group</Typography>
                <Select<TGroup>
                  size="sm"
                  value={grouping.value}
                  onChange={(_event, value) => value && grouping.onChange(value)}
                  slotProps={{ listbox: { disablePortal: true } }}
                >
                  {grouping.options.map((option) => <Option key={option.value} value={option.value}>{option.label}</Option>)}
                </Select>
              </Stack>
            </>
          )}
          {filters && (
            <>
              <ListDivider sx={{ my: 0.25 }} />
              <Stack spacing={1}>
                <Typography level="title-sm">Filters</Typography>
                {filters.children}
                {filters.onClear && (
                  <Button size="sm" variant="plain" color="neutral" onClick={filters.onClear} disabled={filters.clearDisabled} sx={{ alignSelf: 'flex-end' }}>
                    Clear filters
                  </Button>
                )}
              </Stack>
            </>
          )}
        </Stack>
      </Menu>
    </Dropdown>
  )
}

/**
 * Filters as a dropdown button matching the other toolbar controls (a leading
 * tune icon, an active-count in the label, and a chevron). Opens a small panel
 * holding the filter controls plus an optional Clear action. This is the
 * **standard** directory-filters affordance — pass the structured `filters`
 * config to {@link DirectoryPrimaryToolbar}, or render this directly. Filter
 * `Select`s passed as children should set
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
  return (
    <ToolbarMenuButton
      icon={<TuneRoundedIcon />}
      label={activeCount > 0 ? `Filters (${activeCount})` : 'Filters'}
      ariaLabel="Filters"
      disabled={disabled}
      variant="panel"
    >
      {() => (
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
      )}
    </ToolbarMenuButton>
  )
}

export type DirectoryGroupOption<T extends string> = {
  value: T
  label: string
}

/**
 * Grouping as a dropdown button (leading category icon + current group). The
 * panel lists the group options with a check on the active one.
 */
export function DirectoryGroupingMenu<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: ReadonlyArray<DirectoryGroupOption<T>>
  onChange: (value: T) => void
}) {
  const current = options.find((option) => option.value === value)
  return (
    <ToolbarMenuButton icon={<CategoryRoundedIcon />} label={current?.label ?? 'Group'} ariaLabel="Grouping">
      {(close) => options.map((option) => (
        <ToolbarOptionItem
          key={option.value}
          selected={option.value === value}
          onClick={() => { onChange(option.value); close() }}
        >
          {option.label}
        </ToolbarOptionItem>
      ))}
    </ToolbarMenuButton>
  )
}

/**
 * Sort as a single dropdown button (leading sort icon that mirrors the
 * direction + current field). The panel lists the sort fields, then a divider
 * and Ascending/Descending — so field and direction both live inside the one
 * control. Picking a field closes the menu; toggling direction keeps it open.
 */
export function DirectorySortMenu<T extends string>({
  value,
  options,
  onChange,
  direction,
  onDirectionChange,
  ariaLabel
}: {
  value: T
  options: ReadonlyArray<DirectorySortOption<T>>
  onChange: (value: T) => void
  direction: DirectorySortDirection
  onDirectionChange: (direction: DirectorySortDirection) => void
  ariaLabel: string
}) {
  const current = options.find((option) => option.value === value)
  return (
    <ToolbarMenuButton
      icon={<SortRoundedIcon style={{ transform: direction === 'asc' ? 'scaleY(-1)' : undefined }} />}
      label={current?.label ?? 'Sort'}
      ariaLabel={ariaLabel}
    >
      {(close) => (
        <>
          {options.map((option) => (
            <ToolbarOptionItem
              key={option.value}
              selected={option.value === value}
              onClick={() => { onChange(option.value); close() }}
            >
              {option.label}
            </ToolbarOptionItem>
          ))}
          <ListDivider />
          <ToolbarOptionItem selected={direction === 'asc'} onClick={() => onDirectionChange('asc')}>
            Ascending
          </ToolbarOptionItem>
          <ToolbarOptionItem selected={direction === 'desc'} onClick={() => onDirectionChange('desc')}>
            Descending
          </ToolbarOptionItem>
        </>
      )}
    </ToolbarMenuButton>
  )
}

/**
 * Page size as a dropdown button (leading list icon + "N per page"; just the
 * number on phones / in compact mode to stay narrow). The panel lists the size
 * options, highlighting the active one.
 */
export function DirectoryPageSizeMenu<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
  renderValue,
  compact
}: {
  value: T
  options: ReadonlyArray<PageSizeOption<T>>
  onChange: (value: T) => void
  ariaLabel: string
  renderValue: (value: T) => string
  /** Show just the number instead of the full "N per page" label. Defaults to the mobile viewport. */
  compact?: boolean
}) {
  const isMobile = useMobileViewport()
  const showNumberOnly = compact ?? isMobile
  return (
    <ToolbarMenuButton
      icon={<FormatListNumberedRoundedIcon />}
      label={showNumberOnly ? String(value) : renderValue(value)}
      ariaLabel={ariaLabel}
      widthSx={showNumberOnly ? TOOLBAR_CONTROL_COMPACT_SX : TOOLBAR_CONTROL_SX}
    >
      {(close) => options.map((option) => (
        <ToolbarOptionItem
          key={String(option.value)}
          selected={option.value === value}
          onClick={() => { onChange(option.value); close() }}
        >
          {option.label}
        </ToolbarOptionItem>
      ))}
    </ToolbarMenuButton>
  )
}
