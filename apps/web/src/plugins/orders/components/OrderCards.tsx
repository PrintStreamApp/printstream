/**
 * Order and template card components for the orders plugin.
 *
 * Owns the list-row order card (`OrderListCard`) and its per-print sub-card
 * (`OrderListPrintCard`), the order-detail card (`OrderCard`), and the template
 * detail card (`TemplateDetailCard`). These compose the shared leaf components
 * from `./OrderShared` and the pure transforms from `../ordersViewHelpers`.
 *
 * These are extracted from `OrdersView.tsx` unchanged; behavior, props, and
 * markup are preserved.
 */
import { useMemo } from 'react'
import {
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  IconButton,
  Sheet,
  Stack,
  Tooltip,
  Typography
} from '@mui/joy'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import EditRoundedIcon from '@mui/icons-material/EditRounded'
import FactCheckRoundedIcon from '@mui/icons-material/FactCheckRounded'
import FolderOpenRoundedIcon from '@mui/icons-material/FolderOpenRounded'
import PlaylistAddRoundedIcon from '@mui/icons-material/PlaylistAddRounded'
import PrintRoundedIcon from '@mui/icons-material/PrintRounded'
import TaskAltRoundedIcon from '@mui/icons-material/TaskAltRounded'
import UndoRoundedIcon from '@mui/icons-material/UndoRounded'
import type { LibraryFile, Order, OrderTemplate } from '@printstream/shared'
import { PluginSlot } from '../../../plugin/PluginSlot'
import { formatLibraryFileName } from '../../../lib/libraryDisplay'
import { formatDateTime } from '../../../lib/time'
import {
  countTemplateCopies,
  countTemplateFiles,
  countTemplateVariantCopies,
  groupOrderPrints,
  stopEventPropagation,
  type OrderPrintGroup,
  type OrderPrintLauncher
} from '../ordersViewHelpers'
import {
  OrderPrintPlateName,
  OrderPrintPlateThumb,
  OrderProgressChips,
  OrderRowMenu,
  OrderSelectedVariantChips,
  TemplateItemSummary
} from './OrderShared'

export function OrderListCard({
  order,
  filesById,
  onOpenOrder,
  onStartPrint,
  onManualComplete,
  onEditOrder,
  onDeleteOrder,
  onToggleOrderStatus,
  pendingManualPrintId,
  pendingDeleteOrderId,
  pendingEditOrderId,
  pendingOrderId,
  canManageOrders,
  canStartOrderPrint
}: {
  order: Order
  filesById: Map<string, LibraryFile>
  onOpenOrder: (orderId: string) => void
  onStartPrint: OrderPrintLauncher
  onManualComplete: (printId: string) => void
  onEditOrder: (order: Order) => void
  onDeleteOrder: (orderId: string) => void
  onToggleOrderStatus: (orderId: string, status: 'active' | 'completed') => void
  pendingManualPrintId: string | null
  pendingDeleteOrderId: string | null
  pendingEditOrderId: string | null
  pendingOrderId: string | null
  canManageOrders: boolean
  canStartOrderPrint: boolean
}) {
  const groupedPrints = useMemo(() => groupOrderPrints(order.prints), [order.prints])

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={1.25}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'flex-start' }}>
            <Box sx={{ minWidth: 0 }}>
              <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                <Typography level="title-lg">{order.name}</Typography>
                <Chip size="sm" color={order.status === 'completed' ? 'success' : 'primary'} variant="soft">
                  {order.status === 'completed' ? 'Completed' : 'Active'}
                </Chip>
                {order.templateCode && <Chip size="sm" variant="soft">{order.templateCode}</Chip>}
              </Stack>
              <Typography level="body-sm" textColor="text.secondary">From template: {order.templateName}</Typography>
              {order.notes && <Typography level="body-sm" textColor="text.tertiary">{order.notes}</Typography>}
            </Box>
            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }} alignItems="center">
              <Button size="sm" startDecorator={<FolderOpenRoundedIcon />} onClick={() => onOpenOrder(order.id)}>
                Open order
              </Button>
              <OrderRowMenu
                order={order}
                onEditOrder={onEditOrder}
                onDeleteOrder={onDeleteOrder}
                onToggleOrderStatus={onToggleOrderStatus}
                pendingDeleteOrderId={pendingDeleteOrderId}
                pendingEditOrderId={pendingEditOrderId}
                pendingOrderId={pendingOrderId}
                canManageOrders={canManageOrders}
              />
            </Stack>
          </Stack>

          <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap' }}>
            <OrderProgressChips order={order} compact />
            <OrderSelectedVariantChips order={order} compact />
            <Chip size="sm" variant="soft">Updated {formatDateTime(order.updatedAt)}</Chip>
          </Stack>

          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
            {groupedPrints.map((group) => (
              <OrderListPrintCard
                key={group.key}
                orderId={order.id}
                group={group}
                file={group.libraryFileId ? filesById.get(group.libraryFileId) ?? null : null}
                orderIsActive={order.status === 'active'}
                onStartPrint={onStartPrint}
                onManualComplete={onManualComplete}
                pendingManualPrintId={pendingManualPrintId}
                canManageOrders={canManageOrders}
                canStartOrderPrint={canStartOrderPrint}
              />
            ))}
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  )
}

export function OrderListPrintCard({
  orderId,
  group,
  file,
  orderIsActive,
  onStartPrint,
  onManualComplete,
  pendingManualPrintId,
  canManageOrders,
  canStartOrderPrint
}: {
  orderId: string
  group: OrderPrintGroup
  file: LibraryFile | null
  orderIsActive: boolean
  onStartPrint: OrderPrintLauncher
  onManualComplete: (printId: string) => void
  pendingManualPrintId: string | null
  canManageOrders: boolean
  canStartOrderPrint: boolean
}) {
  const fileLabel = formatLibraryFileName(group.libraryFileName)

  return (
    <Sheet
      variant="outlined"
      sx={{
        p: 1.25,
        borderRadius: 'md',
        width: { xs: '100%', sm: 'auto' },
        minWidth: { sm: 240 },
        flex: '1 1 240px',
        display: 'flex'
      }}
    >
      <Stack spacing={1} sx={{ flex: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={1} sx={{ minWidth: 0, alignItems: 'flex-start' }}>
          <OrderPrintPlateThumb
            libraryFileId={group.libraryFileId}
            plate={group.plate}
            fileAvailable={group.fileAvailable}
            projectFilamentOverrides={group.projectFilamentOverrides}
          />
          <Box sx={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
            <Typography level="title-sm" noWrap>{fileLabel}</Typography>
            <OrderPrintPlateName
              libraryFileId={group.libraryFileId}
              plate={group.plate}
              fileAvailable={group.fileAvailable}
            />
            <Typography level="body-xs" textColor="text.tertiary">
              {group.total === 1 ? '1 copy required' : `${group.total} copies required`}
            </Typography>
            {group.notes && <Typography level="body-xs" sx={{ mt: 0.25 }}>{group.notes}</Typography>}
          </Box>
        </Stack>

        <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap' }}>
          <Chip size="sm" variant="soft">{group.completed}/{group.total} done</Chip>
          {group.awaitingConfirmation > 0 && (
            <Chip size="sm" color="warning" variant="soft">{group.awaitingConfirmation} awaiting confirmation</Chip>
          )}
          {group.active > 0 && (
            <Chip size="sm" color="primary" variant="soft">{group.active} active</Chip>
          )}
          {group.pending > 0 && (
            <Chip size="sm" color="neutral" variant="soft">{group.pending} remaining</Chip>
          )}
          {!group.fileAvailable && <Chip size="sm" color="danger" variant="soft">Missing file</Chip>}
        </Stack>

        <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', mt: 'auto', justifyContent: 'flex-start' }}>
          {group.startablePrint && orderIsActive && (
            <Tooltip title="Start print">
              <span>
                <IconButton
                  size="sm"
                  variant="soft"
                  color="primary"
                  aria-label="Start print"
                  disabled={!canStartOrderPrint || !file || !group.fileAvailable}
                  onClick={() => {
                    if (!file || !group.startablePrint) return
                    onStartPrint(file, group.startablePrint.id, group.plate, group.startablePrint.projectFilamentOverrides)
                  }}
                >
                  <PrintRoundedIcon />
                </IconButton>
              </span>
            </Tooltip>
          )}
          {/* Optional "Add to queue" (print-queue plugin), linking the queued print to this order. */}
          {group.startablePrint && orderIsActive && (
            <PluginSlot
              name="orders.itemActions"
              context={{
                libraryFileId: group.libraryFileId,
                fileName: group.libraryFileName,
                plate: group.plate,
                orderId,
                orderPrintId: group.startablePrint.id,
                disabled: !canStartOrderPrint || !file || !group.fileAvailable,
                variant: 'icon'
              }}
            />
          )}
          {group.manuallyCompletablePrint && orderIsActive && (
            <Tooltip title={group.total > 1 ? 'Mark one done' : 'Mark done manually'}>
              <span>
                <IconButton
                  size="sm"
                  variant="soft"
                  color="warning"
                  aria-label={group.total > 1 ? 'Mark one done' : 'Mark done manually'}
                  disabled={!canManageOrders}
                  loading={pendingManualPrintId === group.manuallyCompletablePrint.id}
                  onClick={() => {
                    if (!group.manuallyCompletablePrint) return
                    onManualComplete(group.manuallyCompletablePrint.id)
                  }}
                >
                  <TaskAltRoundedIcon />
                </IconButton>
              </span>
            </Tooltip>
          )}
        </Stack>
      </Stack>
    </Sheet>
  )
}

export function TemplateDetailCard({
  template,
  onCreateOrder,
  onEdit,
  onDelete,
  pendingDelete,
  canManageOrders
}: {
  template: OrderTemplate
  onCreateOrder: () => void
  onEdit: () => void
  onDelete: () => void
  pendingDelete: boolean
  canManageOrders: boolean
}) {
  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={1.25}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'flex-start' }}>
            <Box sx={{ minWidth: 0 }}>
              <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                <Typography level="title-lg">{template.name}</Typography>
                {template.code && <Chip size="sm" variant="soft">{template.code}</Chip>}
              </Stack>
              {template.description && <Typography level="body-sm" textColor="text.secondary">{template.description}</Typography>}
            </Box>
            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }} onClick={stopEventPropagation} onKeyDown={stopEventPropagation}>
              <Button size="sm" startDecorator={<PlaylistAddRoundedIcon />} disabled={!canManageOrders} onClick={onCreateOrder}>Create order</Button>
              <Button size="sm" variant="soft" startDecorator={<EditRoundedIcon />} disabled={!canManageOrders} onClick={onEdit}>Edit</Button>
              <Button size="sm" variant="plain" color="danger" disabled={!canManageOrders} loading={pendingDelete} onClick={onDelete}>Delete</Button>
            </Stack>
          </Stack>

          <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap' }}>
            <Chip size="sm" variant="soft">{template.variants.length} variant{template.variants.length === 1 ? '' : 's'}</Chip>
            <Chip size="sm" variant="soft">{template.items.length} plates</Chip>
            <Chip size="sm" variant="soft">{countTemplateCopies(template)} copies</Chip>
            <Chip size="sm" variant="soft">{countTemplateFiles(template)} files</Chip>
            <Chip size="sm" variant="soft">Updated {formatDateTime(template.updatedAt)}</Chip>
          </Stack>

          <Stack spacing={1}>
            {template.variants.map((variant) => (
              <Sheet key={variant.id} variant="soft" sx={{ p: 1.25, borderRadius: 'md' }}>
                <Stack spacing={1}>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }}>
                    <Typography level="title-sm">{variant.name}</Typography>
                    <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap' }}>
                      <Chip size="sm" variant="soft">{variant.items.length} plates</Chip>
                      <Chip size="sm" variant="soft">{countTemplateVariantCopies(variant)} copies</Chip>
                    </Stack>
                  </Stack>
                  <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
                    {variant.items.map((item) => (
                      <TemplateItemSummary key={item.id} templateItem={item} />
                    ))}
                  </Stack>
                </Stack>
              </Sheet>
            ))}
          </Stack>

          {template.notesTemplate && (
            <Sheet variant="soft" sx={{ p: 1.25, borderRadius: 'md' }}>
              <Typography level="body-xs" textColor="text.tertiary">Default order notes</Typography>
              <Typography level="body-sm">{template.notesTemplate}</Typography>
            </Sheet>
          )}
        </Stack>
      </CardContent>
    </Card>
  )
}

export function OrderCard({
  order,
  filesById,
  onStartPrint,
  onConfirmPrint,
  onManualComplete,
  onReopenPrint,
  onEdit,
  onToggleComplete,
  onDelete,
  pendingConfirmPrintId,
  pendingManualPrintId,
  pendingReopenPrintId,
  pendingDeleteOrderId,
  pendingEditOrderId,
  pendingOrderId,
  canManageOrders,
  canStartOrderPrint,
  hideIdentityHeading = false
}: {
  order: Order
  filesById: Map<string, LibraryFile>
  onStartPrint: OrderPrintLauncher
  onConfirmPrint: (printId: string) => void
  onManualComplete: (printId: string) => void
  onReopenPrint: (printId: string) => void
  onEdit: () => void
  onToggleComplete: (status: 'active' | 'completed') => void
  onDelete: () => void
  pendingConfirmPrintId: string | null
  pendingManualPrintId: string | null
  pendingReopenPrintId: string | null
  pendingDeleteOrderId: string | null
  pendingEditOrderId: string | null
  pendingOrderId: string | null
  canManageOrders: boolean
  canStartOrderPrint: boolean
  hideIdentityHeading?: boolean
}) {
  const groupedPrints = useMemo(() => groupOrderPrints(order.prints), [order.prints])

  return (
    <Card variant="soft">
      <CardContent>
        <Stack spacing={1.25}>
          <Stack direction="row" spacing={1} justifyContent="space-between" alignItems="flex-start">
            <Box sx={{ minWidth: 0, flex: 1 }}>
              {!hideIdentityHeading && (
                <>
                  <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                    <Typography level="title-lg">{order.name}</Typography>
                    <Chip size="sm" color={order.status === 'completed' ? 'success' : 'primary'} variant="soft">
                      {order.status === 'completed' ? 'Completed' : 'Active'}
                    </Chip>
                    {order.templateCode && <Chip size="sm" variant="outlined">{order.templateCode}</Chip>}
                  </Stack>
                  <Typography level="body-sm" textColor="text.secondary">
                    From template: {order.templateName}
                  </Typography>
                </>
              )}
              {hideIdentityHeading && (
                <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                  <Chip size="sm" color={order.status === 'completed' ? 'success' : 'primary'} variant="soft">
                    {order.status === 'completed' ? 'Completed' : 'Active'}
                  </Chip>
                  {order.templateCode && <Chip size="sm" variant="outlined">{order.templateCode}</Chip>}
                </Stack>
              )}
              {order.notes && <Typography level="body-sm" sx={{ mt: hideIdentityHeading ? 0 : 0.5 }}>{order.notes}</Typography>}
            </Box>
            <Stack direction="row" spacing={0.5} alignItems="flex-start">
              <Tooltip title="Edit order details">
                <IconButton
                  size="sm"
                  variant="plain"
                  disabled={!canManageOrders}
                  loading={pendingEditOrderId === order.id}
                  onClick={onEdit}
                >
                  <EditRoundedIcon />
                </IconButton>
              </Tooltip>
              <Tooltip title="Delete order">
                <IconButton
                  size="sm"
                  variant="plain"
                  color="danger"
                  disabled={!canManageOrders}
                  loading={pendingDeleteOrderId === order.id}
                  onClick={onDelete}
                >
                  <DeleteRoundedIcon />
                </IconButton>
              </Tooltip>
              {order.status === 'active' ? (
                <Button
                  size="sm"
                  variant="soft"
                  startDecorator={<TaskAltRoundedIcon />}
                  disabled={!canManageOrders}
                  loading={pendingOrderId === order.id}
                  onClick={() => onToggleComplete('completed')}
                >
                  Mark complete
                </Button>
              ) : (
                <Button size="sm" variant="plain" disabled={!canManageOrders} loading={pendingOrderId === order.id} onClick={() => onToggleComplete('active')}>
                  Reopen
                </Button>
              )}
            </Stack>
          </Stack>

          <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap' }}>
            <Chip size="sm" variant="soft">{order.progress.completed}/{order.progress.total} done</Chip>
            <OrderSelectedVariantChips order={order} compact />
            {order.progress.awaitingConfirmation > 0 && (
              <Chip size="sm" color="warning" variant="soft">{order.progress.awaitingConfirmation} awaiting confirmation</Chip>
            )}
            {order.progress.active > 0 && (
              <Chip size="sm" color="primary" variant="soft">{order.progress.active} active</Chip>
            )}
            {order.progress.pending > 0 && (
              <Chip size="sm" color="neutral" variant="soft">{order.progress.pending} remaining</Chip>
            )}
          </Stack>

          <Divider />

          <Stack spacing={1}>
            {groupedPrints.map((group) => {
              const file = group.libraryFileId ? filesById.get(group.libraryFileId) ?? null : null
              return (
                <Sheet key={group.key} variant="outlined" sx={{ p: 1.25, borderRadius: 'md' }}>
                  <Stack spacing={1} sx={{ minWidth: 0 }}>
                    <Stack direction="row" spacing={1} justifyContent="space-between" alignItems="flex-start">
                      <Stack direction="row" spacing={1} sx={{ minWidth: 0, flex: 1 }}>
                        <OrderPrintPlateThumb
                          libraryFileId={group.libraryFileId}
                          plate={group.plate}
                          fileAvailable={group.fileAvailable}
                          projectFilamentOverrides={group.projectFilamentOverrides}
                        />
                        <Box sx={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
                          <Typography level="title-sm" noWrap>{formatLibraryFileName(group.libraryFileName)}</Typography>
                          <OrderPrintPlateName
                            libraryFileId={group.libraryFileId}
                            plate={group.plate}
                            fileAvailable={group.fileAvailable}
                          />
                          <Typography level="body-xs" textColor="text.tertiary">
                            {group.total === 1 ? '1 copy required' : `${group.total} copies required`}
                          </Typography>
                          {group.notes && <Typography level="body-xs" sx={{ mt: 0.25 }}>{group.notes}</Typography>}
                        </Box>
                      </Stack>
                      <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        <Chip size="sm" variant="soft">{group.completed}/{group.total} done</Chip>
                        {group.awaitingConfirmation > 0 && (
                          <Chip size="sm" color="warning" variant="soft">{group.awaitingConfirmation} awaiting confirmation</Chip>
                        )}
                        {group.active > 0 && (
                          <Chip size="sm" color="primary" variant="soft">{group.active} active</Chip>
                        )}
                        {group.pending > 0 && (
                          <Chip size="sm" color="neutral" variant="soft">{group.pending} remaining</Chip>
                        )}
                        {!group.fileAvailable && <Chip size="sm" color="danger" variant="soft">Missing file</Chip>}
                      </Stack>
                    </Stack>

                    {(group.latestStartedPrinterName || group.latestFinishedAt) && (
                      <Typography level="body-xs" textColor="text.tertiary">
                        {group.latestStartedPrinterName ? `Printer: ${group.latestStartedPrinterName}` : 'Printer not recorded'}
                        {group.latestFinishedAt ? ` • Last finish: ${formatDateTime(group.latestFinishedAt)}` : ''}
                      </Typography>
                    )}

                    <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap' }}>
                      {group.startablePrint && order.status === 'active' && (
                        <Button
                          size="sm"
                          startDecorator={<PrintRoundedIcon />}
                          disabled={!canStartOrderPrint || !file || !group.fileAvailable}
                          onClick={() => {
                            if (!file || !group.startablePrint) return
                            onStartPrint(file, group.startablePrint.id, group.plate, group.startablePrint.projectFilamentOverrides)
                          }}
                        >
                          Start print
                        </Button>
                      )}
                      {/* Optional "Add to queue" (print-queue plugin), linked to this order. */}
                      {group.startablePrint && order.status === 'active' && (
                        <PluginSlot
                          name="orders.itemActions"
                          context={{
                            libraryFileId: group.libraryFileId,
                            fileName: group.libraryFileName,
                            plate: group.plate,
                            orderId: order.id,
                            orderPrintId: group.startablePrint.id,
                            disabled: !canStartOrderPrint || !file || !group.fileAvailable,
                            variant: 'button'
                          }}
                        />
                      )}
                      {group.confirmablePrint && (
                        <Button
                          size="sm"
                          color="success"
                          startDecorator={<FactCheckRoundedIcon />}
                          disabled={!canManageOrders}
                          loading={pendingConfirmPrintId === group.confirmablePrint.id}
                          onClick={() => {
                            if (!group.confirmablePrint) return
                            onConfirmPrint(group.confirmablePrint.id)
                          }}
                        >
                          {group.awaitingConfirmation > 1 ? 'Confirm one good' : 'Confirm good'}
                        </Button>
                      )}
                      {group.manuallyCompletablePrint && (
                        <Button
                          size="sm"
                          variant="soft"
                          color="warning"
                          startDecorator={<TaskAltRoundedIcon />}
                          disabled={!canManageOrders}
                          loading={pendingManualPrintId === group.manuallyCompletablePrint.id}
                          onClick={() => {
                            if (!group.manuallyCompletablePrint) return
                            onManualComplete(group.manuallyCompletablePrint.id)
                          }}
                        >
                          {group.total > 1 ? 'Mark one done' : 'Mark done manually'}
                        </Button>
                      )}
                      {group.reopenablePrint && (
                        <Button
                          size="sm"
                          variant="plain"
                          color="neutral"
                          startDecorator={<UndoRoundedIcon />}
                          disabled={!canManageOrders}
                          loading={pendingReopenPrintId === group.reopenablePrint.id}
                          onClick={() => {
                            if (!group.reopenablePrint) return
                            onReopenPrint(group.reopenablePrint.id)
                          }}
                        >
                          {group.total > 1 ? 'Unmark one done' : 'Unmark done'}
                        </Button>
                      )}
                    </Stack>
                  </Stack>
                </Sheet>
              )
            })}
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  )
}
