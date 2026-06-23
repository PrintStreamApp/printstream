/**
 * Shared sort + density controls for directory-style views.
 *
 * Library, tenants, and other card/list directories use this compact toolbar
 * so sort direction and list/grid affordances stay visually consistent.
 */
import SortRoundedIcon from '@mui/icons-material/SortRounded'
import { Box, IconButton, Option, Select, Stack, Tooltip } from '@mui/joy'
import React from 'react'
import { useMobileViewport } from './useMobileViewport'
import { ViewModeToggle } from './ViewModeToggle'

export type DirectoryViewMode = 'list' | 'icon'
export type DirectorySortDirection = 'asc' | 'desc'

export type DirectorySortOption<T extends string> = {
  value: T
  label: string
}

export function DirectorySortViewControls<T extends string>({
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
  matchFilterWidthOnMobile = false,
  matchFilterWidthOnDesktop = false,
  stretchToContainer = false,
  sortMinWidth = 140
}: {
  sortValue: T
  sortOptions: ReadonlyArray<DirectorySortOption<T>>
  onSortValueChange: (value: T) => void
  sortDirection: DirectorySortDirection
  onSortDirectionChange: (direction: DirectorySortDirection) => void
  sortAriaLabel: string
  viewMode?: DirectoryViewMode
  onViewModeChange?: (mode: DirectoryViewMode) => void
  disableIconModeOnMobile?: boolean
  rightAlignViewModeOnMobile?: boolean
  matchFilterWidthOnMobile?: boolean
  matchFilterWidthOnDesktop?: boolean
  stretchToContainer?: boolean
  sortMinWidth?: number | string
}) {
  const isMobile = useMobileViewport()
  const showViewModeToggle = viewMode != null && onViewModeChange != null && (!disableIconModeOnMobile || !isMobile)
  const showViewModeSpacer = showViewModeToggle

  if (isMobile && matchFilterWidthOnMobile) {
    if (showViewModeToggle) {
      return (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gap: 1,
            width: '100%'
          }}
        >
          <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0, width: '100%' }}>
            <Select
              size="sm"
              value={sortValue}
              onChange={(_event, value) => value && onSortValueChange(value)}
              renderValue={() => `Sort by ${sortOptions.find((option) => option.value === sortValue)?.label ?? ''}`}
              slotProps={{ button: { 'aria-label': sortAriaLabel } }}
              sx={{ flex: 1, minWidth: 0 }}
            >
              {sortOptions.map((option) => (
                <Option key={option.value} value={option.value}>{option.label}</Option>
              ))}
            </Select>
            <Tooltip title={sortDirection === 'asc' ? 'Ascending' : 'Descending'}>
              <IconButton
                size="sm"
                variant="soft"
                aria-label={`Sort ${sortDirection === 'asc' ? 'ascending' : 'descending'}`}
                onClick={() => onSortDirectionChange(sortDirection === 'asc' ? 'desc' : 'asc')}
              >
                <SortRoundedIcon fontSize="small" style={{ transform: sortDirection === 'asc' ? 'scaleY(-1)' : undefined }} />
              </IconButton>
            </Tooltip>
          </Stack>
          {viewMode && onViewModeChange && (
            <Stack
              direction="row"
              spacing={1}
              justifyContent={rightAlignViewModeOnMobile ? 'flex-end' : 'flex-start'}
              alignItems="center"
              sx={{ minWidth: 0, width: '100%' }}
            >
              <ViewModeToggle viewMode={viewMode} onViewModeChange={onViewModeChange} />
            </Stack>
          )}
        </Box>
      )
    }

    return (
      <Stack spacing={1} sx={{ minWidth: 0, width: '100%' }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0, width: '100%' }}>
          <Select
            size="sm"
            value={sortValue}
            onChange={(_event, value) => value && onSortValueChange(value)}
            renderValue={() => `Sort by ${sortOptions.find((option) => option.value === sortValue)?.label ?? ''}`}
            slotProps={{ button: { 'aria-label': sortAriaLabel } }}
            sx={{ flex: 1, minWidth: 0 }}
          >
            {sortOptions.map((option) => (
              <Option key={option.value} value={option.value}>{option.label}</Option>
            ))}
          </Select>
          <Tooltip title={sortDirection === 'asc' ? 'Ascending' : 'Descending'}>
            <IconButton
              size="sm"
              variant="soft"
              aria-label={`Sort ${sortDirection === 'asc' ? 'ascending' : 'descending'}`}
              onClick={() => onSortDirectionChange(sortDirection === 'asc' ? 'desc' : 'asc')}
            >
              <SortRoundedIcon fontSize="small" style={{ transform: sortDirection === 'asc' ? 'scaleY(-1)' : undefined }} />
            </IconButton>
          </Tooltip>
        </Stack>
      </Stack>
    )
  }

  if (!isMobile && matchFilterWidthOnDesktop && showViewModeToggle && viewMode && onViewModeChange) {
    return (
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: 1,
          width: '100%'
        }}
      >
        <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0, width: '100%' }}>
          <Select
            size="sm"
            value={sortValue}
            onChange={(_event, value) => value && onSortValueChange(value)}
            renderValue={() => `Sort by ${sortOptions.find((option) => option.value === sortValue)?.label ?? ''}`}
            slotProps={{ button: { 'aria-label': sortAriaLabel } }}
            sx={{ flex: 1, minWidth: 0 }}
          >
            {sortOptions.map((option) => (
              <Option key={option.value} value={option.value}>{option.label}</Option>
            ))}
          </Select>
          <Tooltip title={sortDirection === 'asc' ? 'Ascending' : 'Descending'}>
            <IconButton
              size="sm"
              variant="soft"
              aria-label={`Sort ${sortDirection === 'asc' ? 'ascending' : 'descending'}`}
              onClick={() => onSortDirectionChange(sortDirection === 'asc' ? 'desc' : 'asc')}
            >
              <SortRoundedIcon fontSize="small" style={{ transform: sortDirection === 'asc' ? 'scaleY(-1)' : undefined }} />
            </IconButton>
          </Tooltip>
        </Stack>
        <Stack direction="row" spacing={1} justifyContent="flex-end" alignItems="center" sx={{ minWidth: 0, width: '100%' }}>
          <ViewModeToggle viewMode={viewMode} onViewModeChange={onViewModeChange} />
        </Stack>
      </Box>
    )
  }

  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', width: '100%' }}>
      <Select
        size="sm"
        value={sortValue}
        onChange={(_event, value) => value && onSortValueChange(value)}
        renderValue={() => `Sort by ${sortOptions.find((option) => option.value === sortValue)?.label ?? ''}`}
        slotProps={{ button: { 'aria-label': sortAriaLabel } }}
        sx={{
          flex: stretchToContainer ? '1 1 auto' : { xs: '1 1 auto', sm: '0 0 auto' },
          minWidth: stretchToContainer ? 0 : { xs: 0, sm: sortMinWidth }
        }}
      >
        {sortOptions.map((option) => (
          <Option key={option.value} value={option.value}>{option.label}</Option>
        ))}
      </Select>
      <Tooltip title={sortDirection === 'asc' ? 'Ascending' : 'Descending'}>
        <IconButton
          size="sm"
          variant="soft"
          aria-label={`Sort ${sortDirection === 'asc' ? 'ascending' : 'descending'}`}
          onClick={() => onSortDirectionChange(sortDirection === 'asc' ? 'desc' : 'asc')}
        >
          <SortRoundedIcon fontSize="small" style={{ transform: sortDirection === 'asc' ? 'scaleY(-1)' : undefined }} />
        </IconButton>
      </Tooltip>
      {showViewModeSpacer && (
        <Box
          sx={rightAlignViewModeOnMobile
            ? { flex: { xs: 1, sm: 1 }, minWidth: 0 }
            : { flex: { xs: 1, sm: 1 }, minWidth: { xs: '100%', sm: 0 } }}
        />
      )}
      {showViewModeToggle && viewMode && onViewModeChange && (
        <ViewModeToggle viewMode={viewMode} onViewModeChange={onViewModeChange} />
      )}
    </Stack>
  )
}