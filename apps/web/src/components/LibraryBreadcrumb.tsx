import { useState, type DragEvent } from 'react'
import { Box, Button, Stack, Typography } from '@mui/joy'
import { LIBRARY_DRAG_MIME, type LibraryDragItem } from './LibraryBrowser'
import type { LibraryBreadcrumbCrumb } from '../lib/libraryNavigation'

export function LibraryBreadcrumb({
  crumbs,
  onNavigate,
  onCrumbDrop,
  draggedItem
}: {
  crumbs: LibraryBreadcrumbCrumb[]
  onNavigate: (id: string | null) => void
  onCrumbDrop?: (event: DragEvent<HTMLElement>, targetFolderId: string | null) => void
  draggedItem?: LibraryDragItem | null
}) {
  const [dropActiveCrumbId, setDropActiveCrumbId] = useState<string | null>(null)
  const crumbShellSx = {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: '24px',
    px: 0.25
  } as const

  const canAcceptDrop = (event: DragEvent<HTMLElement>) => {
    if (draggedItem) return true
    return Array.from(event.dataTransfer.types).includes(LIBRARY_DRAG_MIME)
  }

  return (
    <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
      {crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1
        const dropKey = crumb.id ?? '__root'
        const dropEnabled = Boolean(onCrumbDrop) && crumb.dropTarget !== 'none'
        const dropActive = dropActiveCrumbId === dropKey
        // Ancestors (including the root) read as LINKS — coloured with a hover
        // underline — so the path is obviously clickable; the current location is
        // plain bold text with a trailing slash so it reads as a directory path.
        const content = !isLast && crumb.navigable ? (
          <Button
            size="sm"
            variant="plain"
            color="primary"
            onClick={() => onNavigate(crumb.id)}
            sx={{
              minHeight: 'unset',
              py: 0,
              px: 0,
              fontSize: 'var(--joy-fontSize-sm)',
              fontWeight: 'md',
              lineHeight: 'var(--joy-lineHeight-sm)',
              color: 'primary.300',
              textDecoration: 'none',
              '&:hover': { background: 'none', textDecoration: 'underline', color: 'primary.200' }
            }}
          >
            {crumb.name}
          </Button>
        ) : (
          <Typography level="body-sm" fontWeight={isLast ? 'lg' : 'md'} textColor={isLast ? 'text.primary' : 'text.tertiary'}>{crumb.name}</Typography>
        )

        return (
          <Stack key={crumb.id ?? 'root'} direction="row" spacing={0.5} alignItems="center">
            <Box
              onDragOver={dropEnabled ? (event) => {
                if (!canAcceptDrop(event)) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                setDropActiveCrumbId(dropKey)
              } : undefined}
              onDragLeave={dropEnabled ? () => setDropActiveCrumbId((current) => (current === dropKey ? null : current)) : undefined}
              onDrop={dropEnabled ? (event) => {
                if (!canAcceptDrop(event)) return
                setDropActiveCrumbId(null)
                onCrumbDrop?.(event, crumb.dropTarget === 'bridge-root' ? null : crumb.id)
              } : undefined}
              sx={dropEnabled ? {
                ...crumbShellSx,
                borderRadius: 'sm',
                border: dropActive ? '1px solid var(--joy-palette-primary-500)' : '1px solid transparent',
                boxShadow: dropActive ? '0 0 0 1px var(--joy-palette-primary-500)' : undefined
              } : crumbShellSx}
            >
              {content}
            </Box>
            <Typography level="body-sm" textColor="text.tertiary">/</Typography>
          </Stack>
        )
      })}
    </Stack>
  )
}