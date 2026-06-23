/**
 * Reusable library browser surface.
 *
 * Renders a list of folders + files with two view modes (list / icon) and
 * configurable sorting. Used both by the standalone Library page and by
 * the Print dialog's library picker so the two stay visually consistent.
 *
 * Folders always sort by name. Files honor the active sort. In list
 * mode, files show their upload date and size; in icon mode the
 * thumbnail is the focus and only the name is shown.
 */
import React, { useEffect, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import LinkOffRoundedIcon from '@mui/icons-material/LinkOffRounded'
import StarRoundedIcon from '@mui/icons-material/StarRounded'
import StarBorderRoundedIcon from '@mui/icons-material/StarBorderRounded'
import { AspectRatio, Box, Checkbox, Chip, IconButton, Stack, Tooltip, Typography } from '@mui/joy'
import { formatBytes, type LibraryFile, type LibraryFolder } from '@printstream/shared'
import { buildApiUrl } from '../lib/apiUrl'
import { getMeshThumbnailProvider, getSceneThumbnailProvider } from '../lib/modelThumbnailRegistry'
import { bambuSwatchForHex, readableTextColor } from '../data/bambuColors'
import { sortLibraryEntries } from '../lib/libraryDirectory'
import { formatLibraryFileKindLabel, formatLibraryFileName } from '../lib/libraryDisplay'
import {
  buildCompactFileTags,
  buildFullFileTags,
  type FileTagDescriptor,
  type FileTagColor,
  type FileTagKind
} from '../lib/libraryFileTags'
import { isBridgeFolderId } from '../lib/libraryNavigation'
import { DirectorySortViewControls, type DirectorySortDirection, type DirectoryViewMode } from './DirectoryControls'
import { formatDateTime } from '../lib/time'
import {
  LIBRARY_DRAG_MIME,
  parseLibraryDragItem,
  serializeLibraryDragItem,
  type LibraryDragItem
} from '../lib/libraryDragItem'
import { useMobileViewport } from './useMobileViewport'

export type LibraryViewMode = DirectoryViewMode
export type LibrarySortKey = 'name' | 'date' | 'size' | 'mostPrinted' | 'lastPrinted'
export type LibrarySortDir = DirectorySortDirection

export interface LibrarySort {
  key: LibrarySortKey
  dir: LibrarySortDir
}

// Re-exported for existing consumers (LibraryView, LibraryBreadcrumb); the
// canonical definitions live in ../lib/libraryDragItem.
export { LIBRARY_DRAG_MIME }
export type { LibraryDragItem }

const SORT_LABELS: Record<LibrarySortKey, string> = {
  name: 'Name',
  date: 'Date',
  size: 'Size',
  mostPrinted: 'Most printed',
  lastPrinted: 'Last printed'
}

/** All library sort keys, in display order — shared by the main view and the pickers. */
const LIBRARY_TOOLBAR_SORT_KEYS = ['name', 'date', 'size', 'mostPrinted', 'lastPrinted'] as const

/** Compact view-mode + sort toolbar shared by both consumers. */
export function LibraryToolbar({
  viewMode,
  onViewModeChange,
  sort,
  onSortChange,
  favoritesOnly,
  onFavoritesOnlyChange,
  rightAlignViewModeOnMobile = false
}: {
  viewMode: LibraryViewMode
  onViewModeChange: (mode: LibraryViewMode) => void
  sort: LibrarySort
  onSortChange: (sort: LibrarySort) => void
  /** When provided, renders a "favorites only" filter toggle ahead of the sort controls. */
  favoritesOnly?: boolean
  onFavoritesOnlyChange?: (value: boolean) => void
  rightAlignViewModeOnMobile?: boolean
}) {
  const controls = (
    <DirectorySortViewControls
      sortValue={sort.key}
      sortOptions={LIBRARY_TOOLBAR_SORT_KEYS.map((key) => ({ value: key, label: SORT_LABELS[key] }))}
      onSortValueChange={(key) => onSortChange({ ...sort, key })}
      sortDirection={sort.dir}
      onSortDirectionChange={(dir) => onSortChange({ ...sort, dir })}
      sortAriaLabel="Sort library by"
      viewMode={viewMode}
      onViewModeChange={onViewModeChange}
      matchFilterWidthOnMobile
      matchFilterWidthOnDesktop
      rightAlignViewModeOnMobile={rightAlignViewModeOnMobile}
    />
  )
  if (onFavoritesOnlyChange === undefined) return controls
  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ width: '100%', minWidth: 0 }}>
      <Tooltip title={favoritesOnly ? 'Showing favorites only' : 'Show favorites only'}>
        <IconButton
          size="sm"
          variant={favoritesOnly ? 'solid' : 'soft'}
          color={favoritesOnly ? 'warning' : 'neutral'}
          aria-label="Show favorites only"
          aria-pressed={favoritesOnly}
          onClick={() => onFavoritesOnlyChange(!favoritesOnly)}
          sx={{ flexShrink: 0 }}
        >
          {favoritesOnly ? <StarRoundedIcon /> : <StarBorderRoundedIcon />}
        </IconButton>
      </Tooltip>
      <Box sx={{ flex: 1, minWidth: 0 }}>{controls}</Box>
    </Stack>
  )
}

interface BrowserProps {
  folders: LibraryFolder[]
  files: LibraryFile[]
  viewMode: LibraryViewMode
  sort: LibrarySort
  surfaceStyle?: 'default' | 'dialog'
  stretchIconColumns?: boolean
  iconColumnCount?: number
  onFolderOpen: (folder: LibraryFolder) => void
  /** Optional click handler on file rows/tiles. Set when the browser is acting as a picker. */
  onFilePick?: (file: LibraryFile) => void
  /** Restricts which files receive picker affordances when `onFilePick` is set. */
  isFilePickable?: (file: LibraryFile) => boolean
  /** Optional explanation shown when a file is visible but not pickable. */
  getFileDisabledReason?: (file: LibraryFile) => string | null
  /** Avoid loading bridge-backed thumbnails when the source is unavailable. */
  disableFileThumbnails?: boolean
  /** Optional per-file action slot (typically a ⋮ menu). */
  renderFileActions?: (file: LibraryFile) => ReactNode
  /** Optional per-folder action slot. */
  renderFolderActions?: (folder: LibraryFolder) => ReactNode
  /** Optional right-click handler for file rows and tiles. */
  onFileContextMenu?: (event: MouseEvent<HTMLElement>, file: LibraryFile) => void
  /** Optional right-click handler for folder rows and tiles. */
  onFolderContextMenu?: (event: MouseEvent<HTMLElement>, folder: LibraryFolder) => void
  /** Optional drop handler for moving a file/folder into another folder. */
  onItemDrop?: (item: LibraryDragItem, targetFolder: LibraryFolder) => void
  /** Mirrors the currently dragged item up to callers that also expose drop targets. */
  onDragItemChange?: (item: LibraryDragItem | null) => void
  /** Optional explicit file-selection state, used by the main Library page for bulk delete. */
  selectableFiles?: boolean
  selectedFileIds?: string[]
  onFileSelectionToggle?: (file: LibraryFile) => void
  hideMetadataChipsOnMobile?: boolean
  hideFilamentSwatches?: boolean
  emptyText?: string
  emptyState?: ReactNode
}

export function LibraryBrowser({
  folders,
  files,
  viewMode,
  sort,
  surfaceStyle = 'default',
  stretchIconColumns = true,
  iconColumnCount,
  onFolderOpen,
  onFilePick,
  isFilePickable,
  getFileDisabledReason,
  disableFileThumbnails = false,
  renderFileActions,
  renderFolderActions,
  onFileContextMenu,
  onFolderContextMenu,
  onItemDrop,
  onDragItemChange,
  selectableFiles = false,
  selectedFileIds = [],
  onFileSelectionToggle,
  hideMetadataChipsOnMobile = false,
  hideFilamentSwatches = false,
  emptyText = 'This folder is empty.',
  emptyState
}: BrowserProps) {
  const isMobileViewport = useMobileViewport()
  // Mobile list rows are narrow, so metadata chips are suppressed there to keep them scannable.
  // Icon cards render the chips centered below the name with room to wrap, so they stay visible
  // on mobile in icon mode.
  const hideMetadataTags = hideMetadataChipsOnMobile && isMobileViewport && viewMode === 'list'
  const draggedItemRef = useRef<LibraryDragItem | null>(null)
  const suppressDragClickRef = useRef(false)
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null)
  const selectedFileIdSet = new Set(selectedFileIds)
  const { folders: sortedFolders, files: sortedFiles } = sortLibraryEntries(folders, files, sort)
  const fixedIconColumnCount =
    typeof iconColumnCount === 'number' && Number.isFinite(iconColumnCount)
      ? Math.max(1, Math.floor(iconColumnCount))
      : null

  const buildFileDragItem = (file: LibraryFile): LibraryDragItem => {
    if (!selectableFiles || !selectedFileIdSet.has(file.id)) {
      return { type: 'file', file }
    }
    const selectedFiles = files.filter((entry) => selectedFileIdSet.has(entry.id))
    return selectedFiles.length > 1 ? { type: 'files', files: selectedFiles } : { type: 'file', file }
  }

  const beginDrag = (item: LibraryDragItem) => (event: DragEvent<HTMLElement>) => {
    if (!onItemDrop) return
    draggedItemRef.current = item
    suppressDragClickRef.current = true
    onDragItemChange?.(item)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(
      LIBRARY_DRAG_MIME,
      JSON.stringify(serializeLibraryDragItem(item))
    )
    event.dataTransfer.setData(
      'text/plain',
      item.type === 'folder'
        ? item.folder.id
        : item.type === 'file'
          ? item.file.id
          : item.files.map((file) => file.id).join(',')
    )
  }

  const endDrag = () => {
    window.setTimeout(() => {
      draggedItemRef.current = null
      onDragItemChange?.(null)
      setDragOverFolderId(null)
      suppressDragClickRef.current = false
    }, 0)
  }

  const ignoreSuppressedDragClick = (handler: (() => void) | undefined) => {
    if (!handler) return undefined
    return () => {
      if (suppressDragClickRef.current) return
      handler()
    }
  }

  const resolveDraggedItem = (event: DragEvent<HTMLElement>): LibraryDragItem | null => {
    if (draggedItemRef.current) return draggedItemRef.current
    return parseLibraryDragItem(event.dataTransfer.getData(LIBRARY_DRAG_MIME), { files, folders })
  }

  const handleFolderDragOver = (folder: LibraryFolder) => (event: DragEvent<HTMLElement>) => {
    const draggedItem = draggedItemRef.current
    if (!onItemDrop || !draggedItem) return
    if (draggedItem.type === 'folder' && draggedItem.folder.id === folder.id) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDragOverFolderId(folder.id)
  }

  const handleFolderDragLeave = (folder: LibraryFolder) => () => {
    setDragOverFolderId((current) => (current === folder.id ? null : current))
  }

  const handleFolderDrop = (folder: LibraryFolder) => (event: DragEvent<HTMLElement>) => {
    const draggedItem = resolveDraggedItem(event)
    if (!onItemDrop || !draggedItem) return
    event.preventDefault()
    event.stopPropagation()
    setDragOverFolderId(null)
    draggedItemRef.current = null
    onDragItemChange?.(null)
    if (draggedItem.type === 'folder' && draggedItem.folder.id === folder.id) return
    onItemDrop(draggedItem, folder)
  }

  const handleFolderContextMenu = (folder: LibraryFolder) => (event: MouseEvent<HTMLElement>) => {
    if (suppressTouchContextMenu(event)) return
    onFolderContextMenu?.(event, folder)
  }

  const handleFileContextMenu = (file: LibraryFile) => (event: MouseEvent<HTMLElement>) => {
    if (suppressTouchContextMenu(event)) return
    onFileContextMenu?.(event, file)
  }

  if (sortedFolders.length === 0 && sortedFiles.length === 0) {
    return emptyState ?? <Typography level="body-sm" textColor="text.tertiary">{emptyText}</Typography>
  }

  if (viewMode === 'icon') {
    return (
      <Box
        sx={{
          display: 'grid',
          gap: 1,
          width: fixedIconColumnCount
            ? { xs: '100%', sm: 'max-content' }
            : 'auto',
          maxWidth: '100%',
          gridTemplateColumns: fixedIconColumnCount
            ? {
                xs: 'repeat(auto-fill, minmax(150px, 1fr))',
                sm: `repeat(${fixedIconColumnCount}, minmax(min(150px, 100%), 150px))`
              }
            : stretchIconColumns
              ? 'repeat(auto-fill, minmax(150px, 1fr))'
              : 'repeat(auto-fill, minmax(min(150px, 100%), 150px))'
        }}
      >
        {sortedFolders.map((folder) => (
          <FolderTile
            key={folder.id}
            folder={folder}
            surfaceStyle={surfaceStyle}
            onOpen={() => onFolderOpen(folder)}
            actions={renderFolderActions?.(folder)}
            draggable={Boolean(onItemDrop)}
            onDragStart={beginDrag({ type: 'folder', folder })}
            onDragEnd={endDrag}
            onDragOver={handleFolderDragOver(folder)}
            onDragLeave={handleFolderDragLeave(folder)}
            onDrop={handleFolderDrop(folder)}
            dropActive={dragOverFolderId === folder.id}
            onContextMenu={onFolderContextMenu ? handleFolderContextMenu(folder) : undefined}
          />
        ))}
        {sortedFiles.map((file) => (
          <FileTile
            key={file.id}
            file={file}
            surfaceStyle={surfaceStyle}
            onClick={ignoreSuppressedDragClick(selectableFiles
              ? () => onFileSelectionToggle?.(file)
              : onFilePick && (isFilePickable?.(file) ?? true)
                ? () => onFilePick(file)
                : undefined)}
            disabledReason={getFileDisabledReason?.(file) ?? null}
            actions={renderFileActions?.(file)}
            draggable={Boolean(onItemDrop)}
            onDragStart={beginDrag(buildFileDragItem(file))}
            onDragEnd={endDrag}
            selectable={selectableFiles}
            selected={selectedFileIdSet.has(file.id)}
            onSelectionToggle={onFileSelectionToggle ? () => onFileSelectionToggle(file) : undefined}
            hideMetadataTags={hideMetadataTags}
            hideFilamentSwatches={hideFilamentSwatches}
            onContextMenu={onFileContextMenu ? handleFileContextMenu(file) : undefined}
          />
        ))}
      </Box>
    )
  }

  return (
    <Stack spacing={0.75}>
      {sortedFolders.map((folder) => (
        <FolderRow
          key={folder.id}
          folder={folder}
          surfaceStyle={surfaceStyle}
          onOpen={() => onFolderOpen(folder)}
          actions={renderFolderActions?.(folder)}
          draggable={Boolean(onItemDrop)}
          onDragStart={beginDrag({ type: 'folder', folder })}
          onDragEnd={endDrag}
          onDragOver={handleFolderDragOver(folder)}
          onDragLeave={handleFolderDragLeave(folder)}
          onDrop={handleFolderDrop(folder)}
          dropActive={dragOverFolderId === folder.id}
          onContextMenu={onFolderContextMenu ? handleFolderContextMenu(folder) : undefined}
        />
      ))}
      {sortedFiles.map((file) => (
        <LibraryFileRow
          key={file.id}
          file={file}
          surfaceStyle={surfaceStyle}
          onClick={ignoreSuppressedDragClick(selectableFiles
            ? () => onFileSelectionToggle?.(file)
            : onFilePick && (isFilePickable?.(file) ?? true)
              ? () => onFilePick(file)
              : undefined)}
          disabledReason={getFileDisabledReason?.(file) ?? null}
          disableThumbnail={disableFileThumbnails}
          actions={renderFileActions?.(file)}
          draggable={Boolean(onItemDrop)}
          onDragStart={beginDrag(buildFileDragItem(file))}
          onDragEnd={endDrag}
          selectable={selectableFiles}
          selected={selectedFileIdSet.has(file.id)}
          onSelectionToggle={onFileSelectionToggle ? () => onFileSelectionToggle(file) : undefined}
          hideMetadataTags={hideMetadataTags}
          hideFilamentSwatches={hideFilamentSwatches}
          onContextMenu={onFileContextMenu ? handleFileContextMenu(file) : undefined}
        />
      ))}
    </Stack>
  )
}

function suppressTouchContextMenu(event: MouseEvent<HTMLElement>): boolean {
  const nativeEvent = event.nativeEvent as globalThis.MouseEvent & {
    pointerType?: string
    sourceCapabilities?: { firesTouchEvents?: boolean } | null
  }

  if (nativeEvent.pointerType !== 'touch' && nativeEvent.sourceCapabilities?.firesTouchEvents !== true) {
    return false
  }

  event.preventDefault()
  event.stopPropagation()
  return true
}

/**
 * Wrapper for the per-row/tile actions slot. Stops click and keyboard
 * events from bubbling up to the parent card so menu buttons inside
 * actions don't also trigger the card's onClick (open folder / pick
 * file).
 */
function ActionSlot({ children }: { children: ReactNode }) {
  return (
    <Box
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      sx={{ display: 'flex', alignItems: 'center' }}
    >
      {children}
    </Box>
  )
}

function FolderRow({
  folder,
  surfaceStyle = 'default',
  onOpen,
  actions,
  draggable,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  dropActive,
  onContextMenu
}: {
  folder: LibraryFolder
  surfaceStyle?: 'default' | 'dialog'
  onOpen: () => void
  actions?: ReactNode
  draggable?: boolean
  onDragStart?: (event: DragEvent<HTMLElement>) => void
  onDragEnd?: () => void
  onDragOver?: (event: DragEvent<HTMLElement>) => void
  onDragLeave?: () => void
  onDrop?: (event: DragEvent<HTMLElement>) => void
  dropActive?: boolean
  onContextMenu?: (event: MouseEvent<HTMLElement>) => void
}) {
  const folderTypeLabel = isBridgeFolderId(folder.id) ? 'Bridge' : 'Folder'

  return (
    <Box
      onClick={onOpen}
      onContextMenu={onContextMenu}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        p: surfaceStyle === 'dialog' ? 1.25 : 1,
        borderRadius: surfaceStyle === 'dialog' ? 'md' : 'sm',
        border: dropActive
          ? '1px solid var(--joy-palette-primary-500)'
          : surfaceStyle === 'dialog'
            ? '1px solid var(--joy-palette-divider)'
            : '1px solid var(--joy-palette-neutral-700)',
        backgroundColor: surfaceStyle === 'dialog' ? 'background.level1' : 'var(--joy-palette-background-surface)',
        cursor: 'pointer',
        boxShadow: dropActive ? '0 0 0 1px var(--joy-palette-primary-500)' : undefined,
        transition: 'border-color 120ms, background-color 120ms, box-shadow 120ms',
        '&:hover': {
          borderColor: 'var(--joy-palette-primary-500)',
          backgroundColor: surfaceStyle === 'dialog' ? 'background.surface' : 'var(--joy-palette-background-surface)'
        }
      }}
    >
      <Box
        sx={{
          width: 56,
          height: 56,
          borderRadius: 'sm',
          backgroundColor: 'var(--joy-palette-primary-900)',
          border: '1px solid var(--joy-palette-primary-700)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0
        }}
      >
        <Typography level="h4">📁</Typography>
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography level="title-sm" noWrap>{folder.name}</Typography>
        <Typography level="body-xs" textColor="text.tertiary">{folderTypeLabel}</Typography>
      </Box>
      {actions && <ActionSlot>{actions}</ActionSlot>}
    </Box>
  )
}

/** Rich list-style file presentation shared by library-adjacent pickers. */
export function LibraryFileRow({
  file,
  surfaceStyle = 'default',
  onClick,
  disabledReason,
  disableThumbnail = false,
  actions,
  draggable,
  onDragStart,
  onDragEnd,
  selectable = false,
  selected = false,
  onSelectionToggle,
  hideMetadataTags = false,
  hideFilamentSwatches = false,
  onContextMenu
}: {
  file: LibraryFile
  surfaceStyle?: 'default' | 'dialog'
  onClick?: () => void
  disabledReason?: string | null
  disableThumbnail?: boolean
  actions?: ReactNode
  draggable?: boolean
  onDragStart?: (event: DragEvent<HTMLElement>) => void
  onDragEnd?: () => void
  selectable?: boolean
  selected?: boolean
  onSelectionToggle?: () => void
  hideMetadataTags?: boolean
  hideFilamentSwatches?: boolean
  onContextMenu?: (event: MouseEvent<HTMLElement>) => void
}) {
  const interactive = Boolean(onClick)
  const compactTags = buildCompactFileTags(file)
  return (
    <Box
      onClick={onClick}
      onContextMenu={onContextMenu}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={(event) => {
        if (!interactive) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onClick?.()
        }
      }}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        p: surfaceStyle === 'dialog' ? 1.25 : 1,
        borderRadius: surfaceStyle === 'dialog' ? 'md' : 'sm',
        border: surfaceStyle === 'dialog' ? '1px solid var(--joy-palette-divider)' : '1px solid var(--joy-palette-neutral-700)',
        backgroundColor: surfaceStyle === 'dialog' ? 'background.level1' : 'var(--joy-palette-background-surface)',
        cursor: draggable ? 'grab' : interactive ? 'pointer' : disabledReason ? 'not-allowed' : 'default',
        opacity: disabledReason ? 0.72 : 1,
        '&:active': draggable ? { cursor: 'grabbing' } : undefined,
        transition: 'border-color 120ms, background-color 120ms, box-shadow 120ms',
        '&:hover': interactive || draggable ? {
          borderColor: 'var(--joy-palette-primary-500)',
          backgroundColor: surfaceStyle === 'dialog' ? 'background.surface' : 'var(--joy-palette-background-surface)'
        } : undefined
      }}
    >
      {selectable && onSelectionToggle && (
        <Checkbox
          checked={selected}
          onClick={(event) => event.stopPropagation()}
          onChange={() => onSelectionToggle()}
          slotProps={{ input: { 'aria-label': `Select ${formatLibraryFileName(file.name)}` } }}
        />
      )}
      <Box sx={{ position: 'relative', width: 56, height: 56, flexShrink: 0 }}>
        <FileThumbnail file={file} size={56} disabled={disableThumbnail} />
        {disabledReason && <FileUnavailableOverlay reason={disabledReason} iconSize={20} />}
        {file.favorite && <FavoriteStarBadge />}
        <Chip
          size="sm"
          variant="solid"
          color="neutral"
          sx={{
            position: 'absolute',
            right: 2,
            bottom: 2,
            zIndex: 1,
            '--Chip-minHeight': '16px',
            fontSize: '8px',
            px: 0.5,
            backgroundColor: 'rgba(7, 10, 16, 0.8)',
            color: 'var(--joy-palette-common-white)',
            border: '1px solid rgba(255, 255, 255, 0.14)',
            backdropFilter: 'blur(4px)'
          }}
        >
          {fileTypeIndicatorLabel(file)}
        </Chip>
      </Box>
      <Stack sx={{ flex: 1, minWidth: 0 }} spacing={0.25}>
        <Typography level="title-sm" noWrap>{formatLibraryFileName(file.name)}</Typography>
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ flexWrap: 'wrap', minWidth: 0 }}>
          <Typography level="body-xs" textColor="text.tertiary" noWrap>
            {formatBytes(file.sizeBytes)} · {formatDate(file.uploadedAt)}
          </Typography>
        </Stack>
        {!hideFilamentSwatches && compactTags.filament.length > 0 && (
          <FileTagRow
            tags={compactTags.filament}
            mode="compact"
            kind="filament"
            align="left"
          />
        )}
      </Stack>
      {!hideMetadataTags && <FileTags file={file} hideFilament />}
      {actions && <ActionSlot>{actions}</ActionSlot>}
    </Box>
  )
}

/**
 * Read-only "favorited" indicator overlaid on the top-left of a file's thumbnail.
 * Rendered only for favorited files; favoriting itself happens from the file's
 * actions menu. Non-interactive — clicks pass through to the row/tile beneath it.
 */
function FavoriteStarBadge({ matchActionsButton = false }: { matchActionsButton?: boolean }) {
  return (
    <Box
      role="img"
      aria-label="Favorited"
      sx={{
        position: 'absolute',
        top: 6,
        left: 6,
        zIndex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
        filter: 'drop-shadow(0 1px 2px rgba(7, 10, 16, 0.7))',
        // In icon/grid mode the kebab is an IconButton (size sm = 2rem) whose glyph is
        // centered and so inset from the corner; give the star the same square footprint
        // with a centered icon so the two line up optically instead of hugging the corner.
        ...(matchActionsButton ? { width: '2rem', height: '2rem' } : {})
      }}
    >
      {/* htmlColor sets the SVG fill directly — a gold-yellow favorite star (no Joy
          token is a true yellow; `warning` is amber) that won't inherit theme text color. */}
      <StarRoundedIcon fontSize="small" htmlColor="gold" />
    </Box>
  )
}

function FolderTile({
  folder,
  surfaceStyle = 'default',
  onOpen,
  actions,
  draggable,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  dropActive,
  onContextMenu
}: {
  folder: LibraryFolder
  surfaceStyle?: 'default' | 'dialog'
  onOpen: () => void
  actions?: ReactNode
  draggable?: boolean
  onDragStart?: (event: DragEvent<HTMLElement>) => void
  onDragEnd?: () => void
  onDragOver?: (event: DragEvent<HTMLElement>) => void
  onDragLeave?: () => void
  onDrop?: (event: DragEvent<HTMLElement>) => void
  dropActive?: boolean
  onContextMenu?: (event: MouseEvent<HTMLElement>) => void
}) {
  return (
    <Box
      onClick={onOpen}
      onContextMenu={onContextMenu}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
      sx={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: surfaceStyle === 'dialog' ? 'md' : 'sm',
        border: dropActive
          ? '1px solid var(--joy-palette-primary-500)'
          : surfaceStyle === 'dialog'
            ? '1px solid var(--joy-palette-divider)'
            : '1px solid var(--joy-palette-neutral-700)',
        backgroundColor: surfaceStyle === 'dialog' ? 'background.level1' : 'var(--joy-palette-background-surface)',
        overflow: 'hidden',
        cursor: 'pointer',
        boxShadow: dropActive ? '0 0 0 1px var(--joy-palette-primary-500)' : undefined,
        transition: 'border-color 120ms, background-color 120ms, box-shadow 120ms',
        '&:hover': {
          borderColor: 'var(--joy-palette-primary-500)',
          backgroundColor: surfaceStyle === 'dialog' ? 'background.surface' : 'var(--joy-palette-background-surface)'
        }
      }}
    >
      <AspectRatio ratio="1 / 1" sx={{ '--AspectRatio-radius': '0px', flexShrink: 0 }}>
        <Box
          sx={{
            position: 'relative',
            width: '100%',
            height: '100%',
            backgroundColor: 'var(--joy-palette-primary-900)',
            borderBottom: '1px solid var(--joy-palette-primary-700)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <Typography level="h2" sx={{ fontSize: '3.5rem', lineHeight: 1 }}>📁</Typography>
          {actions && (
            <Box
              sx={{
                position: 'absolute',
                top: 6,
                right: 6,
                zIndex: 1
              }}
            >
              <ActionSlot>{actions}</ActionSlot>
            </Box>
          )}
        </Box>
      </AspectRatio>
      <Box sx={{ p: 0.75, flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0.5 }}>
        <Typography level="body-xs" sx={{ minWidth: 0, textAlign: 'center' }} noWrap>{folder.name}</Typography>
      </Box>
    </Box>
  )
}

function FileTile({
  file,
  surfaceStyle = 'default',
  onClick,
  disabledReason,
  disableThumbnail = false,
  actions,
  draggable,
  onDragStart,
  onDragEnd,
  selectable = false,
  selected = false,
  onSelectionToggle,
  hideMetadataTags = false,
  hideFilamentSwatches = false,
  onContextMenu
}: {
  file: LibraryFile
  surfaceStyle?: 'default' | 'dialog'
  onClick?: () => void
  disabledReason?: string | null
  disableThumbnail?: boolean
  actions?: ReactNode
  draggable?: boolean
  onDragStart?: (event: DragEvent<HTMLElement>) => void
  onDragEnd?: () => void
  selectable?: boolean
  selected?: boolean
  onSelectionToggle?: () => void
  hideMetadataTags?: boolean
  hideFilamentSwatches?: boolean
  onContextMenu?: (event: MouseEvent<HTMLElement>) => void
}) {
  const interactive = Boolean(onClick)
  // Icon cards are narrow, so shorten plate chips ("High Temp Plate" -> "High Temp").
  const compactTags = buildCompactFileTags(file, { shortPlateLabels: true })
  return (
    <Box
      onClick={onClick}
      onContextMenu={onContextMenu}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={(event) => {
        if (!interactive) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onClick?.()
        }
      }}
      sx={{
        position: 'relative',
        // Flex column so the footer can fill the card's stretched height (grid equal-height rows)
        // and vertically centre the file name in the leftover space.
        display: 'flex',
        flexDirection: 'column',
        borderRadius: surfaceStyle === 'dialog' ? 'md' : 'sm',
        border: surfaceStyle === 'dialog' ? '1px solid var(--joy-palette-divider)' : '1px solid var(--joy-palette-neutral-700)',
        backgroundColor: surfaceStyle === 'dialog' ? 'background.level1' : 'var(--joy-palette-background-surface)',
        overflow: 'hidden',
        cursor: draggable ? 'grab' : interactive ? 'pointer' : disabledReason ? 'not-allowed' : 'default',
        opacity: disabledReason ? 0.72 : 1,
        '&:active': draggable ? { cursor: 'grabbing' } : undefined,
        transition: 'border-color 120ms, background-color 120ms, box-shadow 120ms',
        '&:hover': interactive || draggable ? {
          borderColor: 'var(--joy-palette-primary-500)',
          backgroundColor: surfaceStyle === 'dialog' ? 'background.surface' : 'var(--joy-palette-background-surface)'
        } : undefined
      }}
    >
      <AspectRatio ratio="1 / 1" sx={{ '--AspectRatio-radius': '0px', flexShrink: 0 }}>
        <Box sx={{ position: 'relative', width: '100%', height: '100%' }}>
          <FileThumbnail file={file} fill disabled={disableThumbnail} />
          {disabledReason && <FileUnavailableOverlay reason={disabledReason} iconSize={30} />}
          {/* Favorited indicator (top-left). Hidden in selection mode where the checkbox owns that corner. */}
          {file.favorite && !selectable && <FavoriteStarBadge matchActionsButton />}
          {selectable && onSelectionToggle && (
            <Checkbox
              checked={selected}
              onClick={(event) => event.stopPropagation()}
              onChange={() => onSelectionToggle()}
              slotProps={{ input: { 'aria-label': `Select ${formatLibraryFileName(file.name)}` } }}
              sx={{
                position: 'absolute',
                top: 6,
                left: 6,
                zIndex: 1
              }}
            />
          )}
          {actions && (
            <Box
              sx={{
                position: 'absolute',
                top: 6,
                right: 6,
                zIndex: 1
              }}
            >
              <ActionSlot>{actions}</ActionSlot>
            </Box>
          )}
          <Chip
            size="sm"
            variant="solid"
            color="neutral"
            sx={{
              position: 'absolute',
              right: 6,
              bottom: 6,
              zIndex: 1,
              '--Chip-minHeight': '16px',
              fontSize: '8px',
              px: 0.5,
              backgroundColor: 'rgba(7, 10, 16, 0.8)',
              color: 'var(--joy-palette-common-white)',
              border: '1px solid rgba(255, 255, 255, 0.14)',
              backdropFilter: 'blur(4px)'
            }}
          >
            {fileTypeIndicatorLabel(file)}
          </Chip>
          {!hideFilamentSwatches && compactTags.filament.length > 0 && (
            <Box
              sx={{
                position: 'absolute',
                right: 8,
                bottom: 8,
                zIndex: 1,
                borderRadius: '999px',
                px: 0.5,
                py: 0.25,
                backgroundColor: 'rgba(7, 10, 16, 0.62)',
                backdropFilter: 'blur(6px)',
                border: '1px solid rgba(255, 255, 255, 0.08)'
              }}
            >
              <FileTagRow
                tags={compactTags.filament}
                mode="compact"
                kind="filament"
                align="right"
              />
            </Box>
          )}
        </Box>
      </AspectRatio>
      <Stack
        spacing={0.5}
        sx={{
          p: 0.75,
          flex: 1,
          minHeight: 0,
          // Vertically centre the chips + name as a group in the lower area.
          justifyContent: 'center',
          // Divider between the thumbnail and the lower area, matching the folder tile.
          borderTop: surfaceStyle === 'dialog' ? '1px solid var(--joy-palette-divider)' : '1px solid var(--joy-palette-neutral-700)'
        }}
      >
        {/* Centred file name above the centred chips. */}
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 0.25 }}>
          <Typography level="body-xs" sx={{ minWidth: 0, textAlign: 'center' }} noWrap>{formatLibraryFileName(file.name)}</Typography>
        </Box>
        {!hideMetadataTags && (
          <FileTagRow
            tags={compactTags.meta}
            mode="compact"
            kind="meta"
            align="center"
          />
        )}
      </Stack>
    </Box>
  )
}

function fileTypeIndicatorLabel(file: LibraryFile): string {
  const name = file.name.trim().toLowerCase()
  if (name.endsWith('.gcode.3mf')) return 'GCODE'
  if (name.endsWith('.3mf')) return '3MF'
  if (name.endsWith('.gcode')) return 'GCODE'
  if (name.endsWith('.stl')) return 'STL'
  if (name.endsWith('.step') || name.endsWith('.stp')) return 'STEP'
  return formatLibraryFileKindLabel(file.name, file.kind).toUpperCase()
}

function FileTags({ file, mode = 'full', hideFilament = false }: { file: LibraryFile; mode?: 'full' | 'compact'; hideFilament?: boolean }) {
  const tags = mode === 'compact'
    ? buildCompactFileTags(file)
    : buildFullFileTags(file)
  const visibleFilament = hideFilament ? [] : tags.filament
  const visibleFilamentTrailing = tags.filamentTrailing
  if (visibleFilament.length === 0 && tags.meta.length === 0 && visibleFilamentTrailing.length === 0) return null

  return (
    <Stack spacing={0.5} sx={{ minWidth: 0, alignItems: 'stretch' }}>
      <FileTagRow
        tags={tags.meta}
        mode={mode}
        kind="meta"
        align="right"
      />
      <FileTagRow
        tags={visibleFilament}
        trailingTags={visibleFilamentTrailing}
        mode={mode}
        kind="filament"
        align="right"
      />
    </Stack>
  )
}

function FileTagRow({
  tags,
  trailingTags = [],
  mode,
  kind,
  align
}: {
  tags: FileTagDescriptor[]
  trailingTags?: FileTagDescriptor[]
  mode: 'full' | 'compact'
  kind: FileTagKind
  align: 'left' | 'right' | 'center'
}) {
  if (tags.length === 0 && trailingTags.length === 0) return null

  const compact = true
  // Icon-card chip stacks fill the BOTTOM line first when they wrap (pyramid shape):
  // reversed item order + row-reverse keeps the left-to-right reading order while
  // wrap-reverse puts the overflow remainder on the top line instead of the bottom.
  const bottomFill = kind === 'meta' && mode === 'compact'
  const orderedTags = bottomFill ? [...tags].reverse() : tags
  const justifyContent = align === 'left'
    ? (bottomFill ? 'flex-end' : 'flex-start')
    : align === 'center'
      ? 'center'
      : (bottomFill ? 'flex-start' : 'flex-end')
  const alignItems = kind === 'filament' ? 'center' : 'flex-start'
  const row = (
    <Stack
      direction={bottomFill ? 'row-reverse' : 'row'}
      spacing={0.5}
      sx={{
        flexWrap: bottomFill ? 'wrap-reverse' : 'wrap',
        justifyContent,
        alignItems,
        minWidth: 0
      }}
    >
      {kind === 'filament'
        ? orderedTags.map((tag) => renderFilamentDot(tag))
        : orderedTags.map((tag) => renderTagChip({ ...tag, compact }))}
    </Stack>
  )

  if (kind === 'filament' && mode === 'full') {
    return (
      <Stack
        direction="row"
        spacing={0.5}
        sx={{
          alignSelf: align === 'left' ? 'flex-start' : 'flex-end',
          justifyContent,
          alignItems: 'center',
          maxWidth: '100%',
          flexWrap: 'wrap'
        }}
      >
        {tags.length > 0 && (
          <Box
            sx={{
              borderRadius: '999px',
              px: 0.5,
              py: 0.25,
              backgroundColor: 'rgba(7, 10, 16, 0.62)',
              backdropFilter: 'blur(6px)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              maxWidth: '100%'
            }}
          >
            {row}
          </Box>
        )}
        {trailingTags.map((tag) => renderTagChip({ ...tag, compact }))}
      </Stack>
    )
  }

  if (trailingTags.length > 0) {
    return (
      <Stack
        direction="row"
        spacing={0.5}
        sx={{
          justifyContent,
          alignItems,
          minWidth: 0,
          flexWrap: 'wrap'
        }}
      >
        {row}
        {trailingTags.map((tag) => renderTagChip({ ...tag, compact }))}
      </Stack>
    )
  }

  return row
}

function renderTagChip({
  key,
  label,
  color,
  kind,
  dotColor,
  chipSx,
  compact = false
}: {
  key: string
  label: string
  color: FileTagColor
  kind: FileTagKind
  dotColor?: string | null
  chipSx?: Record<string, unknown>
  compact?: boolean
}) {
  const display = summarizeChipLabel(label)
  const chip = (
    <Chip
      key={key}
      size="sm"
      variant="soft"
      color={color}
      sx={{
        '--Chip-minHeight': compact ? '15px' : '17px',
        fontSize: compact ? '9px' : '10px',
        maxWidth: '100%',
        ...(kind === 'filament'
          ? {
            backgroundColor: 'var(--joy-palette-neutral-softBg)',
            color: 'var(--joy-palette-neutral-softColor)',
            border: '1px solid rgba(196, 208, 221, 0.18)'
          }
          : undefined),
        ...chipSx
      }}
    >
      {kind === 'filament' ? (
        <>
          <Box
            component="span"
            sx={{
              width: compact ? 6 : 7,
              height: compact ? 6 : 7,
              borderRadius: '999px',
              flexShrink: 0,
              backgroundColor: dotColor ?? 'var(--joy-palette-neutral-500)',
              boxShadow: '0 0 0 1px rgba(255, 255, 255, 0.14)'
            }}
          />
          <span>{display.shortLabel}</span>
        </>
      ) : display.shortLabel}
    </Chip>
  )
  if (kind === 'filament') {
    return (
      <Tooltip
        key={key}
        variant="outlined"
        placement="top"
        arrow
        title={<FilamentTooltipBody label={label} color={dotColor ?? null} />}
        sx={{ maxWidth: 280, p: 0 }}
      >
        {chip}
      </Tooltip>
    )
  }
  if (!display.truncated) return chip
  return (
    <Tooltip key={key} title={label} variant="solid">
      {chip}
    </Tooltip>
  )
}

function renderFilamentDot(tag: FileTagDescriptor) {
  const dot = (
    <Box
      key={tag.key}
      sx={{
        width: 10,
        height: 10,
        borderRadius: '999px',
        flexShrink: 0,
        backgroundColor: tag.dotColor ?? 'var(--joy-palette-neutral-500)',
        boxShadow: '0 0 0 1px rgba(255, 255, 255, 0.18)'
      }}
    />
  )
  return (
    <Tooltip
      key={tag.key}
      variant="outlined"
      placement="top"
      arrow
      title={<FilamentTooltipBody label={tag.label} color={tag.dotColor ?? null} />}
      sx={{ maxWidth: 280, p: 0 }}
    >
      {dot}
    </Tooltip>
  )
}

function FilamentTooltipBody({ label, color }: { label: string; color: string | null }) {
  const swatch = bambuSwatchForHex(color)
  const headerBg = color ?? 'var(--joy-palette-neutral-800)'
  const headerFg = color ? readableTextColor(color) : 'var(--joy-palette-text-primary)'
  const colorLabel = swatch?.name ?? (color ? 'Custom colour' : 'No colour')
  const materialLabel = swatch ? `Bambu ${swatch.material}` : 'Project filament'
  const basicType = extractBasicFilamentType(label, swatch?.material ?? null)

  return (
    <Stack
      sx={{
        minWidth: 220,
        maxWidth: 280,
        borderRadius: 'var(--joy-radius-sm)',
        overflow: 'hidden'
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        spacing={1}
        sx={{
          px: 1.25,
          py: 0.75,
          backgroundColor: headerBg,
          color: headerFg,
          borderBottom: '1px solid rgba(0, 0, 0, 0.25)'
        }}
      >
        <Typography
          level="title-sm"
          sx={{ color: 'inherit', fontWeight: 'lg', flex: 1, minWidth: 0 }}
          noWrap
        >
          {colorLabel}
        </Typography>
        <Typography level="body-xs" sx={{ color: 'inherit', opacity: 0.85, flexShrink: 0 }}>
          Filament
        </Typography>
      </Stack>
      <Stack spacing={0.5} sx={{ px: 1.25, py: 1 }}>
        <Typography level="body-sm">{label}</Typography>
        <Typography level="body-xs" textColor="text.tertiary">{materialLabel}</Typography>
        {basicType && (
          <Typography level="body-xs" textColor="text.tertiary">Type: {basicType}</Typography>
        )}
      </Stack>
    </Stack>
  )
}

function extractBasicFilamentType(label: string, material: string | null): string | null {
  const haystacks = [material, label]
  const filamentTypes = [
    'PETG',
    'PLA',
    'ABS',
    'ASA',
    'TPU',
    'PA',
    'PC',
    'PVA',
    'HIPS',
    'PP',
    'PET',
    'PPS',
    'PEEK'
  ]

  for (const haystack of haystacks) {
    if (!haystack) continue
    const upper = haystack.toUpperCase()
    for (const filamentType of filamentTypes) {
      const pattern = new RegExp(`(^|[^A-Z])${filamentType}([^A-Z]|$)`)
      if (pattern.test(upper)) return filamentType
    }
  }

  return null
}

function summarizeChipLabel(label: string): { shortLabel: string; truncated: boolean } {
  const separators = [' - ', ' · ', ' / ', ' | ', ' @', ' (']
  let cutoff = -1
  for (const separator of separators) {
    const index = label.indexOf(separator)
    if (index <= 0) continue
    if (cutoff === -1 || index < cutoff) cutoff = index
  }
  if (cutoff === -1) return { shortLabel: label, truncated: false }
  return { shortLabel: `${label.slice(0, cutoff).trim()}...`, truncated: true }
}

/**
 * Square plate-1 thumbnail. Falls back to the kind label when the file
 * is not a 3MF/gcode (no embedded image) or the request errors.
 */
/**
 * Full-cover overlay marking a file whose backing source (e.g. a disconnected
 * bridge) is temporarily unavailable. Replaces per-card explanatory text — the
 * page-level banner carries the full reason — with a compact icon; the reason
 * stays available on hover.
 */
function FileUnavailableOverlay({ reason, iconSize }: { reason: string; iconSize: number }) {
  return (
    <Tooltip variant="soft" size="sm" title={reason}>
      <Box
        aria-label={reason}
        sx={{
          position: 'absolute',
          inset: 0,
          zIndex: 2,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--joy-palette-warning-300)',
          backgroundColor: 'rgba(7, 10, 16, 0.55)'
        }}
      >
        {/* Plain `style`, not `sx`: this is an @mui/material SvgIcon (icons-material) in a Joy app.
            Joy (@mui/system v5) and material/x-charts (@mui/system v9) coexist and share a single
            emotion ThemeContext that Joy fills with its own theme, so a Material component's `sx` is
            processed by Material's v9 styleFunctionSx against a theme it can't read -> crash in
            createEmptyBreakpointObject. `style` sets the size directly and sidesteps sx entirely.
            (The proper fix is aligning the @mui major versions; until then avoid sx on Material icons.) */}
        <LinkOffRoundedIcon style={{ fontSize: iconSize }} />
      </Box>
    </Tooltip>
  )
}

export function FileThumbnail({
  file,
  size,
  fill = false,
  disabled = false
}: {
  file: LibraryFile
  size?: number
  fill?: boolean
  disabled?: boolean
}) {
  const [failed, setFailed] = useState(false)
  // BambuStudio renders the MODEL (iso, material colour) into a 3MF/gcode file's embedded plate
  // PNG — including sliced gcode.3mf files — so the server thumbnail is already the "original
  // model" image. (The model mesh itself is stripped from sliced outputs via --min-save, so a
  // client mesh render isn't possible there anyway.)
  // Cache-bust on uploadedAt: saving a new version keeps the same file id (and thus URL),
  // so without this the browser keeps showing the previously-fetched <img> from memory even
  // though the server now returns a fresh thumbnail for the new arrangement.
  const serverThumbnailUrl = file.kind === '3mf' || file.kind === 'gcode'
    ? buildApiUrl(`/api/library/${file.id}/thumbnail?v=${encodeURIComponent(file.uploadedAt)}`)
    : null

  // STL/STEP files have no server thumbnail; a plugin may register a client-side
  // renderer (Three.js lives in the model-studio plugin, not in core). STEP is
  // tessellated to STL by the server's /mesh endpoint before it reaches the renderer.
  const meshProvider = file.kind === 'stl' || file.kind === 'step' ? getMeshThumbnailProvider() : null
  const [meshThumbnailUrl, setMeshThumbnailUrl] = useState<string | null>(null)
  useEffect(() => {
    if (disabled || !meshProvider) {
      setMeshThumbnailUrl(null)
      return
    }
    let cancelled = false
    const controller = new AbortController()
    meshProvider(file, controller.signal)
      .then((url) => { if (!cancelled) setMeshThumbnailUrl(url) })
      .catch(() => { if (!cancelled) setMeshThumbnailUrl(null) })
    return () => {
      cancelled = true
      controller.abort()
    }
    // Re-render only when the underlying file (id/revision) or gating changes.
  }, [disabled, meshProvider, file, file.id, file.uploadedAt])

  const thumbnailUrl = serverThumbnailUrl ?? meshThumbnailUrl

  // Client-side fallback when the server thumbnail for a 3MF/gcode file is missing (a
  // sliced gcode.3mf may have no embedded plate PNG). Only rendered after the server
  // thumbnail fails, so most files never pay the cost.
  const sceneProvider = file.kind === '3mf' || file.kind === 'gcode' ? getSceneThumbnailProvider() : null
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null)
  useEffect(() => { setFallbackUrl(null) }, [file.id, file.uploadedAt])
  useEffect(() => {
    if (disabled || !failed || !sceneProvider) return
    let cancelled = false
    const controller = new AbortController()
    sceneProvider(file.id, 1, controller.signal)
      .then((url) => { if (!cancelled) setFallbackUrl(url) })
      .catch(() => { if (!cancelled) setFallbackUrl(null) })
    return () => { cancelled = true; controller.abort() }
  }, [disabled, failed, sceneProvider, file, file.id, file.uploadedAt])

  useEffect(() => {
    if (!disabled) {
      setFailed(false)
    }
  }, [disabled, thumbnailUrl])

  // After the server thumbnail errors, show the client-rendered fallback instead.
  const displayUrl = failed ? fallbackUrl : thumbnailUrl
  const showImage = !disabled && displayUrl !== null
  const kindLabel = formatLibraryFileKindLabel(file.name, file.kind)
  return (
    <Box
      sx={{
        width: fill ? '100%' : size,
        height: fill ? '100%' : size,
        flexShrink: 0,
        backgroundColor: 'var(--joy-palette-neutral-800)',
        borderRadius: fill ? 0 : 'sm',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        pointerEvents: 'none',
        userSelect: 'none'
      }}
    >
      {showImage ? (
        <Box
          component="img"
          src={displayUrl ?? undefined}
          alt={file.name}
          loading="lazy"
          draggable={false}
          // Only the server thumbnail can error here; once it has, we render the
          // client fallback (a data URL) instead, so don't re-trip the flag.
          onError={() => { if (!failed) setFailed(true) }}
          sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      ) : (
        <Typography level="body-xs" textColor="text.tertiary">{kindLabel}</Typography>
      )}
    </Box>
  )
}

function formatDate(iso: string): string {
  return formatDateTime(iso)
}

