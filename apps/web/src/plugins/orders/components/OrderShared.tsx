/**
 * Shared leaf components and the small plate-label hook used across the orders
 * plugin's routes and cards.
 *
 * Owns the presentational primitives that the orders/templates list, detail,
 * and card surfaces all reuse: section headings and empty states, the nested
 * detail header / not-found block, the order progress and selected-variant
 * chips, the order row action menu, the template item thumbnail, and the order
 * print plate thumbnail / name. `useLibraryPlateLabel` resolves a 3MF plate's
 * display name from the library plates index.
 *
 * These are extracted from `OrdersView.tsx` unchanged; behavior, props, and
 * markup are preserved.
 */
import { type ReactNode } from 'react'
import {
  Box,
  Button,
  Chip,
  Dropdown,
  IconButton,
  Menu,
  MenuButton,
  MenuItem,
  Sheet,
  Stack,
  Tooltip,
  Typography
} from '@mui/joy'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import EditRoundedIcon from '@mui/icons-material/EditRounded'
import FactCheckRoundedIcon from '@mui/icons-material/FactCheckRounded'
import FolderOpenRoundedIcon from '@mui/icons-material/FolderOpenRounded'
import MoreVertIcon from '@mui/icons-material/MoreVert'
import PlaylistAddRoundedIcon from '@mui/icons-material/PlaylistAddRounded'
import TaskAltRoundedIcon from '@mui/icons-material/TaskAltRounded'
import type { Order, OrderTemplate, ThreeMfIndex } from '@printstream/shared'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../../lib/apiClient'
import { buildApiUrl } from '../../../lib/apiUrl'
import { formatLibraryFileName } from '../../../lib/libraryDisplay'
import { EmptyState } from '../../../components/EmptyState'
import { NestedViewHeader } from '../../../components/NestedViewHeader'
import { SquareMediaFrame } from '../../../components/SquareMediaFrame'
import { formatProjectFilamentLabel, getVisibleOrderSelectedVariants, stopEventPropagation } from '../ordersViewHelpers'

export function SectionHeading({
  title,
  subtitle,
  actions
}: {
  title: string
  subtitle: string
  actions?: ReactNode
}) {
  return (
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'flex-start' }}>
      <Stack spacing={0.25}>
        <Typography level="title-lg">{title}</Typography>
        <Typography level="body-sm" textColor="text.tertiary">{subtitle}</Typography>
      </Stack>
      {actions}
    </Stack>
  )
}

export function EmptyBlock({
  title,
  message,
  actionLabel,
  onAction,
  disabled = false
}: {
  title: string
  message: string
  actionLabel: string
  onAction: () => void
  disabled?: boolean
}) {
  return (
    <EmptyState
      icon={<PlaylistAddRoundedIcon />}
      title={title}
      description={message}
      action={<Button size="sm" disabled={disabled} onClick={onAction}>{actionLabel}</Button>}
    />
  )
}

export function SectionEmptyState({ title, message }: { title: string; message: string }) {
  return (
    <EmptyState
      icon={<FactCheckRoundedIcon />}
      title={title}
      description={message}
      compact
    />
  )
}

export function DetailHeader({
  kind,
  title,
  subtitle,
  onBack
}: {
  kind: 'Order' | 'Template'
  title?: string
  subtitle?: string
  onBack: () => void
}) {
  const rootLabel = kind === 'Order' ? 'Orders' : 'Templates'

  return (
    title && subtitle
      ? (
        <NestedViewHeader
          crumbs={[
            { label: rootLabel, onClick: onBack },
            { label: title }
          ]}
          description={subtitle}
        />
        )
      : (
        <NestedViewHeader
          crumbs={[
            { label: rootLabel, onClick: onBack },
            { label: kind }
          ]}
        />
        )
  )
}

export function DetailNotFound({ kind, loading, onBack }: { kind: 'order' | 'template'; loading: boolean; onBack: () => void }) {
  if (loading) {
    return <Typography level="body-sm" textColor="text.tertiary">Loading {kind}…</Typography>
  }

  return (
    <Stack spacing={1.5}>
      <NestedViewHeader
        crumbs={[
          { label: kind === 'order' ? 'Orders' : 'Templates', onClick: onBack },
          { label: kind === 'order' ? 'Order' : 'Template' }
        ]}
        description={`The requested ${kind} is no longer available.`}
      />
      <EmptyState
        icon={<FolderOpenRoundedIcon />}
        title={`${kind === 'order' ? 'Order' : 'Template'} not found`}
        description={`The requested ${kind} is no longer available.`}
        compact
      />
    </Stack>
  )
}

export function OrderProgressChips({ order, compact = false }: { order: Order; compact?: boolean }) {
  return (
    <>
      <Chip size={compact ? 'sm' : 'md'} variant="soft">{order.progress.completed}/{order.progress.total} done</Chip>
      {order.progress.awaitingConfirmation > 0 && (
        <Chip size={compact ? 'sm' : 'md'} color="warning" variant="soft">{order.progress.awaitingConfirmation} awaiting</Chip>
      )}
      {order.progress.active > 0 && (
        <Chip size={compact ? 'sm' : 'md'} color="primary" variant="soft">{order.progress.active} active</Chip>
      )}
      {order.progress.pending > 0 && (
        <Chip size={compact ? 'sm' : 'md'} color="neutral" variant="soft">{order.progress.pending} left</Chip>
      )}
    </>
  )
}

export function OrderSelectedVariantChips({ order, compact = false }: { order: Order; compact?: boolean }) {
  const visibleVariants = getVisibleOrderSelectedVariants(order)
  if (visibleVariants.length === 0) return null

  return (
    <>
      {visibleVariants.map((variant) => (
        <Chip key={variant.id} size={compact ? 'sm' : 'md'} variant="soft" color="neutral">
          {variant.quantity} x {variant.templateVariantName}
        </Chip>
      ))}
    </>
  )
}

export function OrderRowMenu({
  order,
  onEditOrder,
  onDeleteOrder,
  onToggleOrderStatus,
  pendingDeleteOrderId,
  pendingEditOrderId,
  pendingOrderId,
  canManageOrders
}: {
  order: Order
  onEditOrder: (order: Order) => void
  onDeleteOrder: (orderId: string) => void
  onToggleOrderStatus: (orderId: string, status: 'active' | 'completed') => void
  pendingDeleteOrderId: string | null
  pendingEditOrderId: string | null
  pendingOrderId: string | null
  canManageOrders: boolean
}) {
  const deleting = pendingDeleteOrderId === order.id
  const editing = pendingEditOrderId === order.id
  const updating = pendingOrderId === order.id

  return (
    <Box onClick={stopEventPropagation} onKeyDown={stopEventPropagation}>
      <Dropdown>
        <MenuButton
          slots={{ root: IconButton }}
          slotProps={{ root: { size: 'sm', variant: 'plain', color: 'neutral', 'aria-label': `${order.name} actions` } }}
        >
          <MoreVertIcon />
        </MenuButton>
        <Menu placement="bottom-end">
          <MenuItem disabled={!canManageOrders || editing} onClick={() => onEditOrder(order)}>
            <EditRoundedIcon /> {editing ? 'Opening editor…' : 'Edit'}
          </MenuItem>
          <MenuItem
            disabled={!canManageOrders || updating}
            onClick={() => onToggleOrderStatus(order.id, order.status === 'active' ? 'completed' : 'active')}
          >
            <TaskAltRoundedIcon /> {updating ? 'Updating…' : order.status === 'active' ? 'Mark complete' : 'Reopen'}
          </MenuItem>
          <MenuItem color="danger" disabled={!canManageOrders || deleting} onClick={() => onDeleteOrder(order.id)}>
            <DeleteRoundedIcon /> {deleting ? 'Deleting…' : 'Delete'}
          </MenuItem>
        </Menu>
      </Dropdown>
    </Box>
  )
}

export function TemplateItemSummary({ templateItem }: { templateItem: OrderTemplate['items'][number] }) {
  const fileLabel = formatLibraryFileName(templateItem.libraryFileName)
  const plateLabel = useLibraryPlateLabel(templateItem.libraryFileId, templateItem.plate, templateItem.fileAvailable)
  const title = `${plateLabel} from ${fileLabel}`

  return (
    <Tooltip
      title={(
        <Stack spacing={0.25}>
          <Typography level="body-sm">{fileLabel}</Typography>
          {!templateItem.fileAvailable && <Typography level="body-xs">Missing file</Typography>}
        </Stack>
      )}
    >
      <Box sx={{ position: 'relative', width: { xs: 88, sm: 112 }, flexShrink: 0 }}>
        <SquareMediaFrame
          contentSx={{
            borderRadius: 'var(--joy-radius-md)',
            borderColor: templateItem.fileAvailable ? 'neutral.outlinedBorder' : 'danger.outlinedBorder',
            backgroundColor: 'background.level2',
            boxShadow: 'sm'
          }}
        >
          {templateItem.libraryFileId && templateItem.fileAvailable ? (
            <Box
              component="img"
              src={buildApiUrl(`/api/library/${templateItem.libraryFileId}/thumbnail?plate=${templateItem.plate}`)}
              alt={title}
              loading="lazy"
              sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
          ) : (
            <Stack
              spacing={0.25}
              alignItems="center"
              justifyContent="center"
              sx={{ width: '100%', height: '100%', p: 1, textAlign: 'center' }}
            >
              <Typography level="body-xs" textColor="text.tertiary">Plate</Typography>
              <Typography level="title-sm">{templateItem.plate}</Typography>
            </Stack>
          )}
        </SquareMediaFrame>

        <Chip
          size="sm"
          color="primary"
          variant="solid"
          sx={{ position: 'absolute', top: 8, right: 8, boxShadow: 'sm', pointerEvents: 'none' }}
        >
          {templateItem.quantity}
        </Chip>

        {!templateItem.fileAvailable && (
          <Chip
            size="sm"
            color="danger"
            variant="soft"
            sx={{ position: 'absolute', left: 8, right: 8, bottom: 8, justifyContent: 'center', pointerEvents: 'none' }}
          >
            Missing
          </Chip>
        )}
      </Box>
    </Tooltip>
  )
}

export function OrderPrintPlateThumb({
  libraryFileId,
  plate,
  fileAvailable,
  projectFilamentOverrides
}: {
  libraryFileId: string | null
  plate: number
  fileAvailable: boolean
  projectFilamentOverrides: Order['prints'][number]['projectFilamentOverrides']
}) {
  if (!libraryFileId || !fileAvailable) {
    return (
      <Sheet
        variant="soft"
        sx={{
          width: 56,
          minWidth: 56,
          height: 56,
          p: 0.75,
          borderRadius: 'md',
          textAlign: 'center',
          alignSelf: 'flex-start',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        <Typography level="title-sm">{plate}</Typography>
      </Sheet>
    )
  }

  return (
    <Box
      sx={{
        position: 'relative',
        width: 56,
        height: 56,
        borderRadius: 'sm',
        border: '1px solid var(--joy-palette-neutral-700)',
        overflow: 'hidden',
        flexShrink: 0,
        alignSelf: 'flex-start'
      }}
    >
      <Box
        component="img"
        src={buildApiUrl(`/api/library/${libraryFileId}/thumbnail?plate=${plate}`)}
        alt={`Plate ${plate}`}
        loading="lazy"
        sx={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          display: 'block'
        }}
      />

      {projectFilamentOverrides && projectFilamentOverrides.length > 0 && (
        <Box
          sx={{
            position: 'absolute',
            right: 3,
            bottom: 3,
            zIndex: 1,
            borderRadius: '999px',
            px: 0.5,
            py: 0.25,
            backgroundColor: 'rgba(7, 10, 16, 0.62)',
            backdropFilter: 'blur(6px)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            transform: 'scale(0.72)',
            transformOrigin: 'bottom right'
          }}
        >
          <Stack direction="row" spacing={0.5} alignItems="center">
            {projectFilamentOverrides.map((filament) => (
              <Tooltip
                key={`${filament.id}-${filament.color ?? 'none'}`}
                variant="outlined"
                placement="top"
                arrow
                title={formatProjectFilamentLabel(filament)}
              >
                <Box
                  sx={{
                    width: 10,
                    height: 10,
                    borderRadius: '999px',
                    flexShrink: 0,
                    backgroundColor: filament.color ?? 'var(--joy-palette-neutral-500)',
                    boxShadow: '0 0 0 1px rgba(255, 255, 255, 0.18)'
                  }}
                />
              </Tooltip>
            ))}
          </Stack>
        </Box>
      )}
    </Box>
  )
}

export function OrderPrintPlateName({
  libraryFileId,
  plate,
  fileAvailable
}: {
  libraryFileId: string | null
  plate: number
  fileAvailable: boolean
}) {
  const label = useLibraryPlateLabel(libraryFileId, plate, fileAvailable)

  return (
    <Typography
      noWrap
      level="body-xs"
      textColor="text.tertiary"
      title={label}
      sx={{
        display: 'block',
        minWidth: 0,
        maxWidth: '100%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }}
    >
      {label}
    </Typography>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useLibraryPlateLabel(libraryFileId: string | null, plate: number, fileAvailable: boolean): string {
  const platesQuery = useQuery<ThreeMfIndex>({
    queryKey: ['library-plates', libraryFileId],
    queryFn: ({ signal }) => apiFetch<ThreeMfIndex>(`/api/library/${libraryFileId}/plates`, { signal }),
    enabled: Boolean(libraryFileId && fileAvailable),
    staleTime: 60_000
  })

  const resolvedPlate = platesQuery.data?.plates.find((entry) => entry.index === plate)
  return resolvedPlate?.name?.trim() || `Plate ${plate}`
}
