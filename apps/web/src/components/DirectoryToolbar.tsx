import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import TuneRoundedIcon from '@mui/icons-material/TuneRounded'
import {
  Box,
  Button,
  DialogActions,
  DialogTitle,
  FormControl,
  IconButton,
  Input,
  ModalClose,
  Option,
  Select,
  Stack
} from '@mui/joy'
import React, { type ReactNode } from 'react'
import { BackAwareModal as Modal } from './BackAwareModal'
import {
  DirectorySortViewControls,
  type DirectorySortDirection,
  type DirectorySortOption,
  type DirectoryViewMode
} from './DirectoryControls'
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
            md: hasFiltersButton ? 'repeat(4, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))'
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
            <>
              <IconButton
                size="sm"
                variant={viewMode === 'list' ? 'solid' : 'soft'}
                color={viewMode === 'list' ? 'primary' : 'neutral'}
                aria-label="List view"
                aria-pressed={viewMode === 'list'}
                onClick={() => onViewModeChange('list')}
              >
                <ListViewIcon />
              </IconButton>
              <IconButton
                size="sm"
                variant={viewMode === 'icon' ? 'solid' : 'soft'}
                color={viewMode === 'icon' ? 'primary' : 'neutral'}
                aria-label="Icon view"
                aria-pressed={viewMode === 'icon'}
                onClick={() => onViewModeChange('icon')}
              >
                <IconViewIcon />
              </IconButton>
            </>
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

function ListViewIcon() {
  return (
    <Box component="svg" viewBox="0 0 24 24" aria-hidden sx={{ width: '1.1em', height: '1.1em', fill: 'currentColor' }}>
      <path d="M3 5h18v2H3V5zm0 6h18v2H3v-2zm0 6h18v2H3v-2z" />
    </Box>
  )
}

function IconViewIcon() {
  return (
    <Box component="svg" viewBox="0 0 24 24" aria-hidden sx={{ width: '1.1em', height: '1.1em', fill: 'currentColor' }}>
      <path d="M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z" />
    </Box>
  )
}