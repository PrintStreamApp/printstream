/**
 * Route-level components for the orders plugin.
 *
 * Owns the three section routes mounted by `OrdersView` — the orders list
 * (`OrdersListRoute`), the templates list (`TemplatesListRoute`), and the
 * single-order detail (`OrderDetailRoute`) — plus the shared `OrdersTableSection`
 * that renders an active/completed orders table (toolbar, pagination, and order
 * cards). These compose the shared leaves from `./OrderShared`, the cards from
 * `./OrderCards`, and the pure transforms from `../ordersViewHelpers`.
 *
 * These are extracted from `OrdersView.tsx` unchanged; behavior, props, and
 * markup are preserved.
 */
import {
  Button,
  Chip,
  FormControl,
  Input,
  Option,
  Select,
  Stack,
  Typography
} from '@mui/joy'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import PlaylistAddRoundedIcon from '@mui/icons-material/PlaylistAddRounded'
import type { LibraryFile, Order, OrderTemplate } from '@printstream/shared'
import { useParams } from 'react-router-dom'
import { type DirectorySortDirection } from '../../../components/DirectoryControls'
import { DirectoryPrimaryToolbar } from '../../../components/DirectoryToolbar'
import { PaginatedSection } from '../../../components/PaginationFooter'
import { formatDateTime } from '../../../lib/time'
import {
  LIST_PAGE_SIZE_OPTIONS,
  ORDER_SORT_OPTIONS,
  type OrderListPrintLauncher,
  type OrderSortValue
} from '../ordersViewHelpers'
import {
  DetailHeader,
  DetailNotFound,
  EmptyBlock,
  SectionEmptyState,
  SectionHeading
} from './OrderShared'
import { OrderCard, OrderListCard, TemplateDetailCard } from './OrderCards'

export function OrdersListRoute({
  orders,
  openOrders,
  completedOrders,
  filteredOpenOrders,
  visibleOpenOrders,
  safeActiveOrdersPage,
  activeOrdersPageCount,
  activeOrdersPageSize,
  activeOrderSearch,
  onActiveOrderSearchChange,
  onActiveOrdersPageChange,
  onActiveOrdersPageSizeChange,
  activeSortDirection,
  activeSortValue,
  onActiveSortDirectionChange,
  onActiveSortValueChange,
  filteredCompletedOrders,
  visibleCompletedOrders,
  safeCompletedOrdersPage,
  completedOrdersPageCount,
  completedOrdersPageSize,
  completedOrderSearch,
  onCompletedOrderSearchChange,
  onCompletedOrdersPageChange,
  onCompletedOrdersPageSizeChange,
  completedSortDirection,
  completedSortValue,
  onCompletedSortDirectionChange,
  onCompletedSortValueChange,
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
  templatesAvailable,
  onCreateOrder,
  canManageOrders,
  canStartOrderPrint,
  loading
}: {
  orders: Order[]
  openOrders: Order[]
  completedOrders: Order[]
  filteredOpenOrders: Order[]
  visibleOpenOrders: Order[]
  safeActiveOrdersPage: number
  activeOrdersPageCount: number
  activeOrdersPageSize: number
  activeOrderSearch: string
  onActiveOrderSearchChange: (value: string) => void
  onActiveOrdersPageChange: (page: number) => void
  onActiveOrdersPageSizeChange: (value: number) => void
  activeSortDirection: DirectorySortDirection
  activeSortValue: OrderSortValue
  onActiveSortDirectionChange: (direction: DirectorySortDirection) => void
  onActiveSortValueChange: (value: OrderSortValue) => void
  filteredCompletedOrders: Order[]
  visibleCompletedOrders: Order[]
  safeCompletedOrdersPage: number
  completedOrdersPageCount: number
  completedOrdersPageSize: number
  completedOrderSearch: string
  onCompletedOrderSearchChange: (value: string) => void
  onCompletedOrdersPageChange: (page: number) => void
  onCompletedOrdersPageSizeChange: (value: number) => void
  completedSortDirection: DirectorySortDirection
  completedSortValue: OrderSortValue
  onCompletedSortDirectionChange: (direction: DirectorySortDirection) => void
  onCompletedSortValueChange: (value: OrderSortValue) => void
  filesById: Map<string, LibraryFile>
  onOpenOrder: (orderId: string) => void
  onStartPrint: OrderListPrintLauncher
  onManualComplete: (orderId: string, printId: string) => void
  onEditOrder: (order: Order) => void
  onDeleteOrder: (orderId: string) => void
  onToggleOrderStatus: (orderId: string, status: 'active' | 'completed') => void
  pendingManualPrintId: string | null
  pendingDeleteOrderId: string | null
  pendingEditOrderId: string | null
  pendingOrderId: string | null
  templatesAvailable: boolean
  onCreateOrder: () => void
  canManageOrders: boolean
  canStartOrderPrint: boolean
  loading: boolean
}) {
  return (
    <Stack spacing={1.5}>
      <SectionHeading
        title="Production orders"
        subtitle={`${openOrders.length} open • ${completedOrders.length} completed`}
        actions={(
          <Button
            size="sm"
            variant="soft"
            startDecorator={<PlaylistAddRoundedIcon />}
            disabled={!canManageOrders || !templatesAvailable}
            onClick={onCreateOrder}
          >
            New order
          </Button>
        )}
      />
      {orders.length === 0 && !loading ? (
        <EmptyBlock
          title="No production orders"
          message="Create an order from a template to track starts, confirmations, and manual completions."
          actionLabel="Create order"
          disabled={!canManageOrders || !templatesAvailable}
          onAction={onCreateOrder}
        />
      ) : (
        <Stack spacing={1.5}>
          <OrdersTableSection
            title="Active orders"
            subtitle={`${openOrders.length} active`}
            orders={filteredOpenOrders}
            visibleOrders={visibleOpenOrders}
            page={safeActiveOrdersPage}
            pageCount={activeOrdersPageCount}
            pageSize={activeOrdersPageSize}
            searchValue={activeOrderSearch}
            searchPlaceholder="Search order, template, notes, or file"
            emptyMessage="No active orders right now."
            filteredEmptyMessage="No active orders match that search."
            onSearchChange={onActiveOrderSearchChange}
            onPageChange={onActiveOrdersPageChange}
            onPageSizeChange={onActiveOrdersPageSizeChange}
            sortValue={activeSortValue}
            sortDirection={activeSortDirection}
            onSortValueChange={onActiveSortValueChange}
            onSortDirectionChange={onActiveSortDirectionChange}
            filesById={filesById}
            onOpenOrder={onOpenOrder}
            onStartPrint={onStartPrint}
            onManualComplete={onManualComplete}
            onEditOrder={onEditOrder}
            onDeleteOrder={onDeleteOrder}
            onToggleOrderStatus={onToggleOrderStatus}
            pendingManualPrintId={pendingManualPrintId}
            pendingDeleteOrderId={pendingDeleteOrderId}
            pendingEditOrderId={pendingEditOrderId}
            pendingOrderId={pendingOrderId}
            canManageOrders={canManageOrders}
            canStartOrderPrint={canStartOrderPrint}
          />
          <OrdersTableSection
            title="Completed orders"
            subtitle={`${completedOrders.length} completed`}
            orders={filteredCompletedOrders}
            visibleOrders={visibleCompletedOrders}
            page={safeCompletedOrdersPage}
            pageCount={completedOrdersPageCount}
            pageSize={completedOrdersPageSize}
            searchValue={completedOrderSearch}
            searchPlaceholder="Search completed orders"
            emptyMessage="No completed orders yet."
            filteredEmptyMessage="No completed orders match that search."
            onSearchChange={onCompletedOrderSearchChange}
            onPageChange={onCompletedOrdersPageChange}
            onPageSizeChange={onCompletedOrdersPageSizeChange}
            sortValue={completedSortValue}
            sortDirection={completedSortDirection}
            onSortValueChange={onCompletedSortValueChange}
            onSortDirectionChange={onCompletedSortDirectionChange}
            filesById={filesById}
            onOpenOrder={onOpenOrder}
            onStartPrint={onStartPrint}
            onManualComplete={onManualComplete}
            onEditOrder={onEditOrder}
            onDeleteOrder={onDeleteOrder}
            onToggleOrderStatus={onToggleOrderStatus}
            pendingManualPrintId={pendingManualPrintId}
            pendingDeleteOrderId={pendingDeleteOrderId}
            pendingEditOrderId={pendingEditOrderId}
            pendingOrderId={pendingOrderId}
            canManageOrders={canManageOrders}
            canStartOrderPrint={canStartOrderPrint}
          />
        </Stack>
      )}
    </Stack>
  )
}

export function TemplatesListRoute({
  templates,
  filteredTemplates,
  visibleTemplates,
  safeTemplatesPage,
  templatesPageCount,
  templatesPageSize,
  templateSearch,
  onTemplateSearchChange,
  onTemplatesPageChange,
  onTemplatesPageSizeChange,
  onCreateTemplate,
  onCreateOrder,
  onEditTemplate,
  onDeleteTemplate,
  pendingDeleteTemplateId,
  canManageOrders,
  loading
}: {
  templates: OrderTemplate[]
  filteredTemplates: OrderTemplate[]
  visibleTemplates: OrderTemplate[]
  safeTemplatesPage: number
  templatesPageCount: number
  templatesPageSize: number
  templateSearch: string
  onTemplateSearchChange: (value: string) => void
  onTemplatesPageChange: (page: number) => void
  onTemplatesPageSizeChange: (value: number) => void
  onCreateTemplate: () => void
  onCreateOrder: (template: OrderTemplate) => void
  onEditTemplate: (template: OrderTemplate) => void
  onDeleteTemplate: (templateId: string) => void
  pendingDeleteTemplateId: string | null
  canManageOrders: boolean
  loading: boolean
}) {
  return (
    <Stack spacing={1.5}>
      <SectionHeading
        title="Templates"
        subtitle={`${templates.length} saved template${templates.length === 1 ? '' : 's'}`}
        actions={(
          <Button size="sm" variant="soft" startDecorator={<AddRoundedIcon />} disabled={!canManageOrders} onClick={onCreateTemplate}>
            New template
          </Button>
        )}
      />
      {templates.length > 0 && (
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <FormControl sx={{ flex: 1 }}>
            <Input
              aria-label="Search templates"
              value={templateSearch}
              onChange={(event) => onTemplateSearchChange(event.target.value)}
              placeholder="Search name, code, notes, or file"
            />
          </FormControl>
          <FormControl sx={{ minWidth: { xs: '100%', sm: 180 } }}>
            <Select
              aria-label="Templates rows per page"
              value={templatesPageSize}
              onChange={(_event, value) => {
                if (!value) return
                onTemplatesPageSizeChange(value)
              }}
              renderValue={(option) => `Rows: ${option?.value ?? templatesPageSize} per page`}
            >
              {LIST_PAGE_SIZE_OPTIONS.map((value) => (
                <Option key={value} value={value}>{value} rows per page</Option>
              ))}
            </Select>
          </FormControl>
        </Stack>
      )}
      {templates.length === 0 && !loading ? (
        <EmptyBlock
          title="No templates yet"
          message="Create a template with the plates and quantities you repeatedly need to print."
          actionLabel="Create template"
          disabled={!canManageOrders}
          onAction={onCreateTemplate}
        />
      ) : filteredTemplates.length === 0 ? (
        <SectionEmptyState title="No templates found" message="No templates match that search." />
      ) : (
        <PaginatedSection
          showingLabel={`Showing ${safeTemplatesPage * templatesPageSize + 1}-${Math.min(filteredTemplates.length, (safeTemplatesPage + 1) * templatesPageSize)} of ${filteredTemplates.length}`}
          previousDisabled={safeTemplatesPage === 0}
          nextDisabled={safeTemplatesPage >= templatesPageCount - 1}
          onPrevious={() => onTemplatesPageChange(Math.max(0, safeTemplatesPage - 1))}
          onNext={() => onTemplatesPageChange(Math.min(templatesPageCount - 1, safeTemplatesPage + 1))}
        >
          <Stack spacing={1.25}>
            {visibleTemplates.map((template) => (
              <TemplateDetailCard
                key={template.id}
                template={template}
                onCreateOrder={() => onCreateOrder(template)}
                onEdit={() => onEditTemplate(template)}
                onDelete={() => onDeleteTemplate(template.id)}
                pendingDelete={pendingDeleteTemplateId === template.id}
                canManageOrders={canManageOrders}
              />
            ))}
          </Stack>
        </PaginatedSection>
      )}
    </Stack>
  )
}

export function OrderDetailRoute({
  orders,
  filesById,
  onBack,
  onStartPrint,
  onConfirmPrint,
  onManualComplete,
  onReopenPrint,
  onEditOrder,
  onToggleOrderStatus,
  onDeleteOrder,
  pendingConfirmPrintId,
  pendingManualPrintId,
  pendingReopenPrintId,
  pendingDeleteOrderId,
  pendingEditOrderId,
  pendingOrderId,
  canManageOrders,
  canStartOrderPrint,
  loading
}: {
  orders: Order[]
  filesById: Map<string, LibraryFile>
  onBack: () => void
  onStartPrint: OrderListPrintLauncher
  onConfirmPrint: (orderId: string, printId: string) => void
  onManualComplete: (orderId: string, printId: string) => void
  onReopenPrint: (orderId: string, printId: string) => void
  onEditOrder: (order: Order) => void
  onToggleOrderStatus: (orderId: string, status: 'active' | 'completed') => void
  onDeleteOrder: (orderId: string) => void
  pendingConfirmPrintId: string | null
  pendingManualPrintId: string | null
  pendingReopenPrintId: string | null
  pendingDeleteOrderId: string | null
  pendingEditOrderId: string | null
  pendingOrderId: string | null
  canManageOrders: boolean
  canStartOrderPrint: boolean
  loading: boolean
}) {
  const { orderId } = useParams<{ orderId: string }>()
  const order = orders.find((entry) => entry.id === orderId) ?? null

  if (!order) {
    return <DetailNotFound kind="order" loading={loading} onBack={onBack} />
  }

  return (
    <Stack spacing={1.5}>
      <DetailHeader kind="Order" title={order.name} subtitle={`From template: ${order.templateName}`} onBack={onBack} />
      <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap' }}>
        <Chip size="sm" variant="soft">Created {formatDateTime(order.createdAt)}</Chip>
        <Chip size="sm" variant="soft">Updated {formatDateTime(order.updatedAt)}</Chip>
        {order.completedAt && <Chip size="sm" color="success" variant="soft">Completed {formatDateTime(order.completedAt)}</Chip>}
      </Stack>
      <OrderCard
        order={order}
        filesById={filesById}
        onStartPrint={(file, printId, plate, projectFilamentOverrides) => onStartPrint(order.id, file, printId, plate, projectFilamentOverrides)}
        onConfirmPrint={(printId) => onConfirmPrint(order.id, printId)}
        onManualComplete={(printId) => onManualComplete(order.id, printId)}
        onReopenPrint={(printId) => onReopenPrint(order.id, printId)}
        onEdit={() => onEditOrder(order)}
        onToggleComplete={(status) => onToggleOrderStatus(order.id, status)}
        onDelete={() => onDeleteOrder(order.id)}
        pendingConfirmPrintId={pendingConfirmPrintId}
        pendingManualPrintId={pendingManualPrintId}
        pendingReopenPrintId={pendingReopenPrintId}
        pendingDeleteOrderId={pendingDeleteOrderId}
        pendingEditOrderId={pendingEditOrderId}
        pendingOrderId={pendingOrderId}
        canManageOrders={canManageOrders}
        canStartOrderPrint={canStartOrderPrint}
        hideIdentityHeading
      />
    </Stack>
  )
}

export function OrdersTableSection({
  title,
  subtitle,
  orders,
  visibleOrders,
  page,
  pageCount,
  pageSize,
  searchValue,
  searchPlaceholder,
  emptyMessage,
  filteredEmptyMessage,
  onSearchChange,
  onPageChange,
  onPageSizeChange,
  sortValue,
  sortDirection,
  onSortValueChange,
  onSortDirectionChange,
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
  title: string
  subtitle: string
  orders: Order[]
  visibleOrders: Order[]
  page: number
  pageCount: number
  pageSize: number
  searchValue: string
  searchPlaceholder: string
  emptyMessage: string
  filteredEmptyMessage: string
  onSearchChange: (value: string) => void
  onPageChange: (page: number) => void
  onPageSizeChange: (value: number) => void
  sortValue: OrderSortValue
  sortDirection: DirectorySortDirection
  onSortValueChange: (value: OrderSortValue) => void
  onSortDirectionChange: (direction: DirectorySortDirection) => void
  filesById: Map<string, LibraryFile>
  onOpenOrder: (orderId: string) => void
  onStartPrint: OrderListPrintLauncher
  onManualComplete: (orderId: string, printId: string) => void
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
  return (
    <Stack spacing={1}>
      <Stack spacing={0.25}>
        <Typography level="title-md">{title}</Typography>
        <Typography level="body-sm" textColor="text.tertiary">{subtitle}</Typography>
      </Stack>
      <DirectoryPrimaryToolbar
        pinStorageKey="orders"
        searchValue={searchValue}
        onSearchChange={onSearchChange}
        searchPlaceholder={searchPlaceholder}
        searchAriaLabel="Search orders"
        pageSizeValue={pageSize}
        pageSizeOptions={LIST_PAGE_SIZE_OPTIONS.map((value) => ({ value, label: `${value} rows per page` }))}
        onPageSizeChange={onPageSizeChange}
        pageSizeAriaLabel="Orders rows per page"
        pageSizeRenderValue={(value) => `${value} per page`}
        sortValue={sortValue}
        sortOptions={ORDER_SORT_OPTIONS}
        onSortValueChange={(value) => {
          onPageChange(0)
          onSortValueChange(value as OrderSortValue)
        }}
        sortDirection={sortDirection}
        onSortDirectionChange={(direction) => {
          onPageChange(0)
          onSortDirectionChange(direction)
        }}
        sortAriaLabel="Sort orders by"
      />

      {orders.length === 0 ? (
        <SectionEmptyState
          title={searchValue.trim() ? 'No matching orders' : 'Nothing here yet'}
          message={searchValue.trim() ? filteredEmptyMessage : emptyMessage}
        />
      ) : (
        <PaginatedSection
          showingLabel={`Showing ${page * pageSize + 1}-${Math.min(orders.length, (page + 1) * pageSize)} of ${orders.length}`}
          previousDisabled={page === 0}
          nextDisabled={page >= pageCount - 1}
          onPrevious={() => onPageChange(Math.max(0, page - 1))}
          onNext={() => onPageChange(Math.min(pageCount - 1, page + 1))}
        >
          <Stack spacing={1.25}>
            {visibleOrders.map((order) => (
              <OrderListCard
                key={order.id}
                order={order}
                filesById={filesById}
                onOpenOrder={onOpenOrder}
                onStartPrint={(file, printId, plate, projectFilamentOverrides) => onStartPrint(order.id, file, printId, plate, projectFilamentOverrides)}
                onManualComplete={(printId) => onManualComplete(order.id, printId)}
                onEditOrder={onEditOrder}
                onDeleteOrder={onDeleteOrder}
                onToggleOrderStatus={onToggleOrderStatus}
                pendingManualPrintId={pendingManualPrintId}
                pendingDeleteOrderId={pendingDeleteOrderId}
                pendingEditOrderId={pendingEditOrderId}
                pendingOrderId={pendingOrderId}
                canManageOrders={canManageOrders}
                canStartOrderPrint={canStartOrderPrint}
              />
            ))}
          </Stack>
        </PaginatedSection>
      )}
    </Stack>
  )
}
