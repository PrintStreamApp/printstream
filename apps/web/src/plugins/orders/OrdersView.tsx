import { useEffect, useMemo, useState, type ComponentProps } from 'react'
import {
  Alert,
  Button,
  Stack,
  Typography
} from '@mui/joy'
import ChecklistRoundedIcon from '@mui/icons-material/ChecklistRounded'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import type {
  LibraryFile,
  Order,
  OrderList,
  OrderUpdateInput,
  Permission,
  OrderTemplate,
  OrderTemplateList,
  Printer,
  PrinterStatus,
  SlicingCapabilities,
  SlicingJobResponse
} from '@printstream/shared'
import {
  JOBS_VIEW_PERMISSION,
  LIBRARY_UPLOAD_PERMISSION,
  LIBRARY_VIEW_PERMISSION,
  PRINTERS_VIEW_PERMISSION,
  PRINTS_DISPATCH_PERMISSION,
  isDirectPrintableFileName
} from '@printstream/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { apiFetch } from '../../lib/apiClient'
import { prefetchSlicingProfiles } from '../../lib/slicingProfilesQuery'
import { useAuthBootstrapQuery } from '../../lib/authQuery'
import { usePersistentState } from '../../hooks/usePersistentState'
import { type DirectorySortDirection } from '../../components/DirectoryControls'
import { PluginSlot } from '../../plugin/PluginSlot'
import { ConfirmActionDialog } from '../../components/ConfirmActionDialog'
import { SliceFileModal } from '../../components/library/SliceFileModal'
import { buildCreateSlicingJobBody } from '../../lib/libraryViewHelpers'
import { SliceThenPrintModal } from '../../components/library/SliceThenPrintModal'
import { PrintModal } from '../../components/library/PrintModal'
import { isUnslicedThreeMfFile } from '../../lib/libraryFileTags'
import { toast } from '../../lib/toast'
import { readCurrentWorkspaceScopeKey, workspaceQueryKeys } from '../../lib/workspaceScope'
import { buildTenantWorkspacePath, parseWorkspacePathname } from '../../lib/workspaceRoute'
import {
  LIST_PAGE_SIZE_OPTIONS,
  ORDER_SORT_OPTIONS,
  compareOrderDates,
  matchesOrderSearch,
  matchesTemplateSearch,
  type OrderListPrintLauncher,
  type OrderSortValue,
  type PrintTargetState,
  type SliceThenPrintState
} from './ordersViewHelpers'
import {
  OrderDetailRoute,
  OrdersListRoute,
  TemplatesListRoute
} from './components/OrderRoutes'
import {
  EditOrderDialog,
  OrderDialog,
  TemplateDialog
} from './components/OrderDialogs'

type SliceFlowSubmitInput = Parameters<ComponentProps<typeof SliceFileModal>['onSubmit']>[0]
type SliceFlowSubmitAction = Parameters<ComponentProps<typeof SliceFileModal>['onSubmit']>[1]

// localStorage keys for the orders directory controls (sort + page size of each
// list). Search text and the current page index stay ephemeral on purpose.
const ACTIVE_SORT_KEY = 'printstream.orders.active.sort'
const ACTIVE_SORT_DIR_KEY = 'printstream.orders.active.sortDir'
const ACTIVE_PAGE_SIZE_KEY = 'printstream.orders.active.pageSize'
const COMPLETED_SORT_KEY = 'printstream.orders.completed.sort'
const COMPLETED_SORT_DIR_KEY = 'printstream.orders.completed.sortDir'
const COMPLETED_PAGE_SIZE_KEY = 'printstream.orders.completed.pageSize'
const TEMPLATES_PAGE_SIZE_KEY = 'printstream.orders.templates.pageSize'

const ORDER_SORT_VALUES = new Set<string>(ORDER_SORT_OPTIONS.map((option) => option.value))

// Coerce stored (or corrupt) preference blobs back into valid values, falling
// back per field to the same defaults the directory controls start with.
function sanitizeOrderSort(value: unknown): OrderSortValue {
  return ORDER_SORT_VALUES.has(value as string) ? (value as OrderSortValue) : 'updated'
}

function sanitizeSortDirection(value: unknown): DirectorySortDirection {
  return value === 'asc' ? 'asc' : 'desc'
}

function sanitizePageSize(value: unknown): number {
  return (LIST_PAGE_SIZE_OPTIONS as readonly number[]).includes(value as number)
    ? (value as number)
    : 10
}

// Templates start at the smallest page size rather than 10 like the order lists.
function sanitizeTemplatesPageSize(value: unknown): number {
  return (LIST_PAGE_SIZE_OPTIONS as readonly number[]).includes(value as number)
    ? (value as number)
    : LIST_PAGE_SIZE_OPTIONS[0]
}

export function OrdersView() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const location = useLocation()
  const authBootstrapQuery = useAuthBootstrapQuery()
  const [editingTemplate, setEditingTemplate] = useState<OrderTemplate | null>(null)
  const [editingOrder, setEditingOrder] = useState<Order | null>(null)
  const [creatingTemplate, setCreatingTemplate] = useState(false)
  const [creatingOrderFor, setCreatingOrderFor] = useState<OrderTemplate | null>(null)
  const [printTarget, setPrintTarget] = useState<PrintTargetState | null>(null)
  const [sliceTarget, setSliceTarget] = useState<PrintTargetState | null>(null)
  const [sliceThenPrintTarget, setSliceThenPrintTarget] = useState<SliceThenPrintState | null>(null)
  const [deleteTemplateTarget, setDeleteTemplateTarget] = useState<OrderTemplate | null>(null)
  const [deleteOrderTarget, setDeleteOrderTarget] = useState<Order | null>(null)
  const [templateSearch, setTemplateSearch] = useState('')
  const [activeOrderSearch, setActiveOrderSearch] = useState('')
  const [completedOrderSearch, setCompletedOrderSearch] = useState('')
  const [activeOrderSortValue, setActiveOrderSortValue] = usePersistentState<OrderSortValue>(ACTIVE_SORT_KEY, 'updated', sanitizeOrderSort)
  const [activeOrderSortDirection, setActiveOrderSortDirection] = usePersistentState<DirectorySortDirection>(ACTIVE_SORT_DIR_KEY, 'desc', sanitizeSortDirection)
  const [completedOrderSortValue, setCompletedOrderSortValue] = usePersistentState<OrderSortValue>(COMPLETED_SORT_KEY, 'updated', sanitizeOrderSort)
  const [completedOrderSortDirection, setCompletedOrderSortDirection] = usePersistentState<DirectorySortDirection>(COMPLETED_SORT_DIR_KEY, 'desc', sanitizeSortDirection)
  const [templatesPageSize, setTemplatesPageSize] = usePersistentState<number>(TEMPLATES_PAGE_SIZE_KEY, LIST_PAGE_SIZE_OPTIONS[0], sanitizeTemplatesPageSize)
  const [activeOrdersPageSize, setActiveOrdersPageSize] = usePersistentState<number>(ACTIVE_PAGE_SIZE_KEY, 10, sanitizePageSize)
  const [completedOrdersPageSize, setCompletedOrdersPageSize] = usePersistentState<number>(COMPLETED_PAGE_SIZE_KEY, 10, sanitizePageSize)
  const [templatesPage, setTemplatesPage] = useState(0)
  const [activeOrdersPage, setActiveOrdersPage] = useState(0)
  const [completedOrdersPage, setCompletedOrdersPage] = useState(0)

  const authEnabled = authBootstrapQuery.data?.authEnabled ?? false
  const permissions = authBootstrapQuery.data?.permissions ?? []
  const hasPermission = (permission: Permission) => !authEnabled || permissions.includes(permission)
  const canViewOrders = hasPermission(JOBS_VIEW_PERMISSION)
  const canViewLibrary = hasPermission(LIBRARY_VIEW_PERMISSION)
  const canViewPrinters = hasPermission(PRINTERS_VIEW_PERMISSION)
  const canManageOrders = hasPermission(PRINTS_DISPATCH_PERMISSION)
  const canReadOrdersPage = canViewOrders && canViewLibrary
  const canStartOrderPrint = canManageOrders && canViewPrinters
  // Starting an unsliced-3MF order item runs a slicing job first, which the
  // API gates behind the library upload permission.
  const canSliceFiles = hasPermission(LIBRARY_UPLOAD_PERMISSION)

  const templatesQuery = useQuery<OrderTemplateList>({
    queryKey: ['orders', 'templates'],
    queryFn: ({ signal }) => apiFetch<OrderTemplateList>('/api/plugins/orders/templates', { signal }),
    enabled: authBootstrapQuery.isSuccess ? canReadOrdersPage : false
  })
  const ordersQuery = useQuery<OrderList>({
    queryKey: ['orders'],
    queryFn: ({ signal }) => apiFetch<OrderList>('/api/plugins/orders/orders', { signal }),
    enabled: authBootstrapQuery.isSuccess ? canReadOrdersPage : false
  })
  // Resolve only the library files the loaded templates/orders actually reference,
  // not the whole library — the picker browses via /browse, so this list is purely
  // a metadata lookup for already-chosen file ids (thumbnails, plates). Loading the
  // entire library here would re-introduce an unbounded fetch and, with the listing
  // cap, silently fail to resolve files older than the cap.
  const referencedFileIds = useMemo(() => {
    const ids = new Set<string>()
    for (const template of templatesQuery.data?.templates ?? []) {
      for (const item of template.items) {
        if (item.libraryFileId) ids.add(item.libraryFileId)
      }
      for (const variant of template.variants) {
        for (const item of variant.items) {
          if (item.libraryFileId) ids.add(item.libraryFileId)
        }
      }
    }
    for (const order of ordersQuery.data?.orders ?? []) {
      for (const print of order.prints) {
        if (print.libraryFileId) ids.add(print.libraryFileId)
      }
    }
    return [...ids].sort()
  }, [templatesQuery.data, ordersQuery.data])
  // Key on the content (stable joined string), not the array identity, so the
  // query only refetches when the referenced set actually changes.
  const referencedFileIdsKey = referencedFileIds.join(',')
  const filesQuery = useQuery<{ files: LibraryFile[] }>({
    queryKey: ['library-files', 'by-ids', referencedFileIdsKey],
    queryFn: ({ signal }) => apiFetch<{ files: LibraryFile[] }>(`/api/library?ids=${encodeURIComponent(referencedFileIdsKey)}`, { signal }),
    enabled: authBootstrapQuery.isSuccess ? (canManageOrders && canViewLibrary && referencedFileIds.length > 0) : false
  })
  const printersQuery = useQuery<{ printers: Printer[] }>({
    queryKey: ['printers'],
    queryFn: ({ signal }) => apiFetch<{ printers: Printer[] }>('/api/printers', { signal }),
    enabled: authBootstrapQuery.isSuccess ? canStartOrderPrint : false
  })
  const slicingCapabilitiesQuery = useQuery({
    queryKey: ['slicing-capabilities'],
    queryFn: ({ signal }) => apiFetch<SlicingCapabilities>('/api/slicing/capabilities', { signal }),
    enabled: authBootstrapQuery.isSuccess ? (canStartOrderPrint && canSliceFiles) : false
  })
  // Warm the slicer profile catalogue before an order's start-print flow opens the slice dialog.
  const slicingCapabilitiesData = slicingCapabilitiesQuery.data
  useEffect(() => {
    prefetchSlicingProfiles(queryClient, slicingCapabilitiesData)
  }, [queryClient, slicingCapabilitiesData])
  const workspaceScopeKey = readCurrentWorkspaceScopeKey()
  const printerStatusQuery = useQuery<Record<string, PrinterStatus>>({
    queryKey: workspaceQueryKeys.printerStatus(workspaceScopeKey),
    queryFn: () => Promise.resolve({}),
    initialData: {},
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false
  })

  const invalidateOrders = () => {
    void queryClient.invalidateQueries({ queryKey: ['orders'] })
    void queryClient.invalidateQueries({ queryKey: ['orders', 'templates'] })
  }

  // Sliced gcode files print directly; unsliced project 3MFs are sliced when a
  // print is started, so both count as order-usable files.
  const printableFiles = useMemo(
    () => (filesQuery.data?.files ?? []).filter((file) => isDirectPrintableFileName(file.name) || isUnslicedThreeMfFile(file)),
    [filesQuery.data]
  )
  const filesById = useMemo(
    () => new Map(printableFiles.map((file) => [file.id, file] as const)),
    [printableFiles]
  )

  // Route an order item's "start print" by file type: unsliced 3MFs go through
  // the slice-then-print flow, printer-ready files open the print dialog.
  const launchOrderPrint: OrderListPrintLauncher = (orderId, file, printId, plate, projectFilamentOverrides) => {
    if (isUnslicedThreeMfFile(file)) {
      if (!canSliceFiles) {
        toast.error('This order item needs slicing first, which requires the library upload permission.')
        return
      }
      setSliceTarget({ orderId, printId, file, plate, projectFilamentOverrides })
      return
    }
    setPrintTarget({ orderId, file, printId, plate, projectFilamentOverrides })
  }

  const startSlicingJob = useMutation({
    mutationFn: async (input: {
      orderTarget: PrintTargetState
      action: SliceFlowSubmitAction
    } & SliceFlowSubmitInput) => {
      const body = buildCreateSlicingJobBody(input, {
        sourceFileId: input.orderTarget.file.id,
        outputFolderId: null,
        hiddenOutput: true
      })
      return await apiFetch<SlicingJobResponse>('/api/slicing/jobs', { method: 'POST', body })
    },
    onSuccess: async (response, variables) => {
      // Keep the slice dialog mounted beneath the print flow so its "Back" returns to
      // slice settings; abandoning the print tears both down together.
      await queryClient.invalidateQueries({ queryKey: ['slicing-jobs'] })
      setSliceThenPrintTarget({
        orderId: variables.orderTarget.orderId,
        printId: variables.orderTarget.printId,
        sourceFile: variables.orderTarget.file,
        jobId: response.job.id
      })
    }
  })

  const deleteTemplate = useMutation({
    mutationFn: (templateId: string) => apiFetch(`/api/plugins/orders/templates/${templateId}`, { method: 'DELETE' }),
    onSuccess: invalidateOrders
  })
  const deleteOrder = useMutation({
    mutationFn: (orderId: string) => apiFetch(`/api/plugins/orders/orders/${orderId}`, { method: 'DELETE' }),
    onSuccess: invalidateOrders
  })
  const saveOrder = useMutation({
    mutationFn: ({ orderId, body }: { orderId: string; body: OrderUpdateInput }) =>
      apiFetch(`/api/plugins/orders/orders/${orderId}`, { method: 'PATCH', body }),
    onSuccess: invalidateOrders
  })
  const updateOrder = useMutation({
    mutationFn: ({ orderId, body }: { orderId: string; body: { status?: 'active' | 'completed' } }) =>
      apiFetch(`/api/plugins/orders/orders/${orderId}`, { method: 'PATCH', body }),
    onSuccess: invalidateOrders
  })
  const confirmPrint = useMutation({
    mutationFn: ({ orderId, printId }: { orderId: string; printId: string }) =>
      apiFetch(`/api/plugins/orders/orders/${orderId}/prints/${printId}/confirm`, { method: 'POST' }),
    onSuccess: invalidateOrders
  })
  const manualCompletePrint = useMutation({
    mutationFn: ({ orderId, printId }: { orderId: string; printId: string }) =>
      apiFetch(`/api/plugins/orders/orders/${orderId}/prints/${printId}/manual-complete`, { method: 'POST' }),
    onSuccess: invalidateOrders
  })
  const reopenPrint = useMutation({
    mutationFn: ({ orderId, printId }: { orderId: string; printId: string }) =>
      apiFetch(`/api/plugins/orders/orders/${orderId}/prints/${printId}/reopen`, { method: 'POST' }),
    onSuccess: invalidateOrders
  })

  const pageError = (authBootstrapQuery.error as Error | undefined)
    ?? (templatesQuery.error as Error | undefined)
    ?? (ordersQuery.error as Error | undefined)
    ?? (filesQuery.error as Error | undefined)
    ?? (printersQuery.error as Error | undefined)

  const templates = useMemo(() => templatesQuery.data?.templates ?? [], [templatesQuery.data?.templates])
  const filteredTemplates = useMemo(
    () => templates.filter((template) => matchesTemplateSearch(template, templateSearch)),
    [templateSearch, templates]
  )
  const orders = useMemo(() => ordersQuery.data?.orders ?? [], [ordersQuery.data?.orders])
  const openOrders = useMemo(
    () => orders.filter((order) => order.status !== 'completed'),
    [orders]
  )
  const completedOrders = useMemo(
    () => orders.filter((order) => order.status === 'completed'),
    [orders]
  )
  const filteredOpenOrders = useMemo(
    () => openOrders
      .filter((order) => matchesOrderSearch(order, activeOrderSearch))
      .slice()
      .sort((left, right) => (
        compareOrderDates(left, right, activeOrderSortValue, activeOrderSortDirection)
      )),
    [activeOrderSearch, activeOrderSortDirection, activeOrderSortValue, openOrders]
  )
  const filteredCompletedOrders = useMemo(
    () => completedOrders
      .filter((order) => matchesOrderSearch(order, completedOrderSearch))
      .slice()
      .sort((left, right) => (
        compareOrderDates(left, right, completedOrderSortValue, completedOrderSortDirection)
      )),
    [completedOrderSearch, completedOrderSortDirection, completedOrderSortValue, completedOrders]
  )
  const templatesPageCount = Math.max(1, Math.ceil(filteredTemplates.length / templatesPageSize))
  const activeOrdersPageCount = Math.max(1, Math.ceil(filteredOpenOrders.length / activeOrdersPageSize))
  const completedOrdersPageCount = Math.max(1, Math.ceil(filteredCompletedOrders.length / completedOrdersPageSize))
  const safeTemplatesPage = Math.min(templatesPage, templatesPageCount - 1)
  const safeActiveOrdersPage = Math.min(activeOrdersPage, activeOrdersPageCount - 1)
  const safeCompletedOrdersPage = Math.min(completedOrdersPage, completedOrdersPageCount - 1)
  const visibleTemplates = useMemo(() => {
    const start = safeTemplatesPage * templatesPageSize
    return filteredTemplates.slice(start, start + templatesPageSize)
  }, [filteredTemplates, safeTemplatesPage, templatesPageSize])
  const visibleOpenOrders = useMemo(() => {
    const start = safeActiveOrdersPage * activeOrdersPageSize
    return filteredOpenOrders.slice(start, start + activeOrdersPageSize)
  }, [activeOrdersPageSize, filteredOpenOrders, safeActiveOrdersPage])
  const visibleCompletedOrders = useMemo(() => {
    const start = safeCompletedOrdersPage * completedOrdersPageSize
    return filteredCompletedOrders.slice(start, start + completedOrdersPageSize)
  }, [completedOrdersPageSize, filteredCompletedOrders, safeCompletedOrdersPage])

  useEffect(() => {
    setTemplatesPage((current) => Math.min(current, Math.max(0, Math.ceil(filteredTemplates.length / templatesPageSize) - 1)))
  }, [filteredTemplates.length, templatesPageSize])

  useEffect(() => {
    setActiveOrdersPage((current) => Math.min(current, Math.max(0, Math.ceil(filteredOpenOrders.length / activeOrdersPageSize) - 1)))
  }, [activeOrdersPageSize, filteredOpenOrders.length])

  useEffect(() => {
    setCompletedOrdersPage((current) => Math.min(current, Math.max(0, Math.ceil(filteredCompletedOrders.length / completedOrdersPageSize) - 1)))
  }, [completedOrdersPageSize, filteredCompletedOrders.length])

  const workspacePath = parseWorkspacePathname(location.pathname)
  const ordersPathname = workspacePath.appPathname
  const ordersRoute = (path: string) => workspacePath.tenantSlug
    ? buildTenantWorkspacePath(workspacePath.tenantSlug, path)
    : path
  const currentSection: 'orders' | 'templates' = ordersPathname.includes('/templates') ? 'templates' : 'orders'
  const showingOrderDetail = /^\/orders\/(?!templates\/?$)[^/]+\/?$/.test(ordersPathname)
  const currentOrderRouteId = showingOrderDetail
    ? (ordersPathname.match(/^\/orders\/([^/]+)\/?$/)?.[1] ?? null)
    : null
  const pendingConfirmPrintId = confirmPrint.isPending ? confirmPrint.variables?.printId ?? null : null
  const pendingManualPrintId = manualCompletePrint.isPending ? manualCompletePrint.variables?.printId ?? null : null
  const pendingReopenPrintId = reopenPrint.isPending ? reopenPrint.variables?.printId ?? null : null
  const pendingDeleteTemplateId = deleteTemplate.isPending ? deleteTemplate.variables ?? null : null
  const pendingDeleteOrderId = deleteOrder.isPending ? deleteOrder.variables ?? null : null
  const pendingEditOrderId = saveOrder.isPending ? saveOrder.variables?.orderId ?? null : null
  const pendingOrderId = updateOrder.isPending ? updateOrder.variables?.orderId ?? null : null

  if (authBootstrapQuery.isLoading) {
    return <Typography level="body-sm" textColor="text.tertiary">Loading orders…</Typography>
  }

  return (
    <Stack spacing={2.5}>
      {pageError && <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>{pageError.message}</Alert>}
      {!pageError && !canReadOrdersPage && (
        <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
          Orders access requires both job visibility and library visibility permissions.
        </Alert>
      )}
      {!pageError && canReadOrdersPage && !canManageOrders && (
        <Alert color="neutral" variant="soft" startDecorator={<InfoOutlinedIcon />}>
          This view is read-only. Print dispatch permission is required to create, edit, or complete orders.
        </Alert>
      )}

      {!showingOrderDetail && (
        <Stack direction={{ xs: 'column', lg: 'row' }} spacing={1.5} justifyContent="space-between" alignItems={{ xs: 'stretch', lg: 'center' }}>
          <Stack spacing={0.5}>
            <Typography level="h3" startDecorator={<ChecklistRoundedIcon />}>Orders</Typography>
          </Stack>
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
            <Button
              size="sm"
              variant={currentSection === 'orders' ? 'solid' : 'soft'}
              onClick={() => navigate(ordersRoute('/orders'))}
            >
              Orders
            </Button>
            <Button
              size="sm"
              variant={currentSection === 'templates' ? 'solid' : 'soft'}
              onClick={() => navigate(ordersRoute('/orders/templates'))}
            >
              Templates
            </Button>
          </Stack>
        </Stack>
      )}

      <Routes>
        <Route
          index
          element={(
            <OrdersListRoute
              orders={orders}
              openOrders={openOrders}
              completedOrders={completedOrders}
              filteredOpenOrders={filteredOpenOrders}
              visibleOpenOrders={visibleOpenOrders}
              safeActiveOrdersPage={safeActiveOrdersPage}
              activeOrdersPageCount={activeOrdersPageCount}
              activeOrdersPageSize={activeOrdersPageSize}
              activeOrderSearch={activeOrderSearch}
              onActiveOrderSearchChange={(value) => {
                setActiveOrdersPage(0)
                setActiveOrderSearch(value)
              }}
              onActiveOrdersPageChange={setActiveOrdersPage}
              onActiveOrdersPageSizeChange={(value) => {
                setActiveOrdersPage(0)
                setActiveOrdersPageSize(value)
              }}
              activeSortDirection={activeOrderSortDirection}
              activeSortValue={activeOrderSortValue}
              onActiveSortDirectionChange={setActiveOrderSortDirection}
              onActiveSortValueChange={setActiveOrderSortValue}
              filteredCompletedOrders={filteredCompletedOrders}
              visibleCompletedOrders={visibleCompletedOrders}
              safeCompletedOrdersPage={safeCompletedOrdersPage}
              completedOrdersPageCount={completedOrdersPageCount}
              completedOrdersPageSize={completedOrdersPageSize}
              completedOrderSearch={completedOrderSearch}
              onCompletedOrderSearchChange={(value) => {
                setCompletedOrdersPage(0)
                setCompletedOrderSearch(value)
              }}
              onCompletedOrdersPageChange={setCompletedOrdersPage}
              onCompletedOrdersPageSizeChange={(value) => {
                setCompletedOrdersPage(0)
                setCompletedOrdersPageSize(value)
              }}
              completedSortDirection={completedOrderSortDirection}
              completedSortValue={completedOrderSortValue}
              onCompletedSortDirectionChange={setCompletedOrderSortDirection}
              onCompletedSortValueChange={setCompletedOrderSortValue}
              filesById={filesById}
              onOpenOrder={(orderId) => navigate(ordersRoute(`/orders/${orderId}`))}
              onStartPrint={launchOrderPrint}
              onManualComplete={(orderId, printId) => manualCompletePrint.mutate({ orderId, printId })}
              onEditOrder={(order) => setEditingOrder(order)}
              onDeleteOrder={(orderId) => {
                const order = orders.find((entry) => entry.id === orderId) ?? null
                if (order) setDeleteOrderTarget(order)
              }}
              onToggleOrderStatus={(orderId, status) => updateOrder.mutate({ orderId, body: { status } })}
              pendingManualPrintId={pendingManualPrintId}
              pendingDeleteOrderId={pendingDeleteOrderId}
              pendingEditOrderId={pendingEditOrderId}
              pendingOrderId={pendingOrderId}
              templatesAvailable={templates.length > 0}
              onCreateOrder={() => setCreatingOrderFor(templates[0] ?? null)}
              canManageOrders={canManageOrders}
              canStartOrderPrint={canStartOrderPrint}
              loading={ordersQuery.isLoading}
            />
          )}
        />
        <Route
          path=":orderId"
          element={(
            <OrderDetailRoute
              orders={orders}
              filesById={filesById}
              onBack={() => navigate(ordersRoute('/orders'))}
              onStartPrint={launchOrderPrint}
              onConfirmPrint={(orderId, printId) => confirmPrint.mutate({ orderId, printId })}
              onManualComplete={(orderId, printId) => manualCompletePrint.mutate({ orderId, printId })}
              onReopenPrint={(orderId, printId) => reopenPrint.mutate({ orderId, printId })}
              onEditOrder={setEditingOrder}
              onToggleOrderStatus={(orderId, status) => updateOrder.mutate({ orderId, body: { status } })}
              onDeleteOrder={(orderId) => {
                const order = orders.find((entry) => entry.id === orderId) ?? null
                if (order) setDeleteOrderTarget(order)
              }}
              pendingConfirmPrintId={pendingConfirmPrintId}
              pendingManualPrintId={pendingManualPrintId}
              pendingReopenPrintId={pendingReopenPrintId}
              pendingDeleteOrderId={pendingDeleteOrderId}
              pendingEditOrderId={pendingEditOrderId}
              pendingOrderId={pendingOrderId}
              canManageOrders={canManageOrders}
              canStartOrderPrint={canStartOrderPrint}
              loading={ordersQuery.isLoading}
            />
          )}
        />
        <Route
          path="templates"
          element={(
            <TemplatesListRoute
              templates={templates}
              filteredTemplates={filteredTemplates}
              visibleTemplates={visibleTemplates}
              safeTemplatesPage={safeTemplatesPage}
              templatesPageCount={templatesPageCount}
              templatesPageSize={templatesPageSize}
              templateSearch={templateSearch}
              onTemplateSearchChange={(value) => {
                setTemplatesPage(0)
                setTemplateSearch(value)
              }}
              onTemplatesPageChange={setTemplatesPage}
              onTemplatesPageSizeChange={(value) => {
                setTemplatesPage(0)
                setTemplatesPageSize(value)
              }}
              onCreateTemplate={() => setCreatingTemplate(true)}
              onCreateOrder={(template) => setCreatingOrderFor(template)}
              onEditTemplate={setEditingTemplate}
              onDeleteTemplate={(templateId) => {
                const template = templates.find((entry) => entry.id === templateId) ?? null
                if (template) setDeleteTemplateTarget(template)
              }}
              pendingDeleteTemplateId={pendingDeleteTemplateId}
              canManageOrders={canManageOrders}
              loading={templatesQuery.isLoading}
            />
          )}
        />
        <Route path="templates/:templateId" element={<Navigate to={ordersRoute('/orders/templates')} replace />} />
        <Route path="*" element={<Navigate to={ordersRoute('/orders')} replace />} />
      </Routes>

      {canManageOrders && (creatingTemplate || editingTemplate) && (
        <TemplateDialog
          files={filesQuery.data?.files ?? []}
          template={editingTemplate}
          onClose={() => {
            setCreatingTemplate(false)
            setEditingTemplate(null)
          }}
          onSaved={() => {
            setCreatingTemplate(false)
            setEditingTemplate(null)
            invalidateOrders()
          }}
        />
      )}

      {canManageOrders && creatingOrderFor && (
        <OrderDialog
          templates={templatesQuery.data?.templates ?? []}
          initialTemplateId={creatingOrderFor.id}
          onClose={() => setCreatingOrderFor(null)}
          onSaved={() => {
            setCreatingOrderFor(null)
            invalidateOrders()
          }}
        />
      )}

      {canManageOrders && editingOrder && (
        <EditOrderDialog
          order={editingOrder}
          onClose={() => setEditingOrder(null)}
          onSaved={(body) => saveOrder.mutate(
            { orderId: editingOrder.id, body },
            {
              onSuccess: () => {
                setEditingOrder(null)
              }
            }
          )}
          pending={saveOrder.isPending}
        />
      )}

      {canStartOrderPrint && printTarget && printersQuery.data && (
        <PrintModal
          file={printTarget.file}
          printers={printersQuery.data.printers}
          defaultPlate={printTarget.plate}
          projectFilamentOverrides={printTarget.projectFilamentOverrides ?? undefined}
          selectionMode="single"
          submitPrint={({ printerId, body }) => apiFetch(`/api/plugins/orders/orders/${printTarget.orderId}/prints/${printTarget.printId}/start`, {
            method: 'POST',
            body: {
              printerId,
              ...body
            }
          }).then(() => {
            invalidateOrders()
            void queryClient.invalidateQueries({ queryKey: ['print-dispatch'] })
          })}
          onClose={() => setPrintTarget(null)}
        />
      )}

      {canStartOrderPrint && sliceTarget && printersQuery.data && (
        <SliceFileModal
          // Re-mount per file: the dialog's per-file state (materials, one-shot default
          // seeding) must not survive a target swap. See LibraryView's mount.
          key={sliceTarget.file.id}
          file={sliceTarget.file}
          printers={printersQuery.data.printers}
          printerStatuses={printerStatusQuery.data ?? {}}
          capabilities={slicingCapabilitiesQuery.data ?? null}
          capabilitiesLoading={slicingCapabilitiesQuery.isLoading && !slicingCapabilitiesQuery.data}
          capabilitiesError={slicingCapabilitiesQuery.error instanceof Error ? slicingCapabilitiesQuery.error.message : null}
          submitting={startSlicingJob.isPending}
          submitAction={startSlicingJob.variables?.action ?? null}
          submitError={startSlicingJob.error instanceof Error ? startSlicingJob.error.message : null}
          flow="print"
          defaultPlateNumber={sliceTarget.plate}
          onClose={() => setSliceTarget(null)}
          onSubmit={(input, action) => startSlicingJob.mutate({ orderTarget: sliceTarget, action, ...input })}
        />
      )}

      {canStartOrderPrint && sliceThenPrintTarget && printersQuery.data && (
        <SliceThenPrintModal
          sourceFile={sliceThenPrintTarget.sourceFile}
          jobId={sliceThenPrintTarget.jobId}
          printers={printersQuery.data.printers}
          submitPrint={async ({ printerId, body, outputFile }) => {
            // Dispatch the sliced output against the order item; the API records
            // the started print under the sliced file's name.
            await apiFetch(`/api/plugins/orders/orders/${sliceThenPrintTarget.orderId}/prints/${sliceThenPrintTarget.printId}/start`, {
              method: 'POST',
              body: {
                printerId,
                ...body,
                slicedFileId: outputFile.id
              }
            })
            invalidateOrders()
            void queryClient.invalidateQueries({ queryKey: ['print-dispatch'] })
          }}
          // Back returns to the still-open slice settings; Cancel abandons the whole flow.
          onBack={() => setSliceThenPrintTarget(null)}
          onClose={() => {
            setSliceThenPrintTarget(null)
            setSliceTarget(null)
          }}
        />
      )}

      <ConfirmActionDialog
        open={deleteOrderTarget != null}
        title="Delete order?"
        description={deleteOrderTarget ? `Delete the order "${deleteOrderTarget.name}"? This removes the order and all of its tracked print items.` : ''}
        confirmLabel="Delete order"
        pending={deleteOrder.isPending && deleteOrder.variables === deleteOrderTarget?.id}
        onClose={() => setDeleteOrderTarget(null)}
        onConfirm={() => {
          if (!deleteOrderTarget) return
          const deletedOrderId = deleteOrderTarget.id
          deleteOrder.mutate(deletedOrderId, {
            onSuccess: () => {
              if (currentOrderRouteId === deletedOrderId) {
                navigate(ordersRoute('/orders'), { replace: true })
              }
            },
            onSettled: () => setDeleteOrderTarget(null)
          })
        }}
      />

      <ConfirmActionDialog
        open={deleteTemplateTarget != null}
        title="Delete template?"
        description={deleteTemplateTarget ? `Delete the template "${deleteTemplateTarget.name}"? Existing orders stay intact, but this template will no longer be available for new orders.` : ''}
        confirmLabel="Delete template"
        pending={deleteTemplate.isPending && deleteTemplate.variables === deleteTemplateTarget?.id}
        onClose={() => setDeleteTemplateTarget(null)}
        onConfirm={() => {
          if (!deleteTemplateTarget) return
          deleteTemplate.mutate(deleteTemplateTarget.id, {
            onSettled: () => setDeleteTemplateTarget(null)
          })
        }}
      />

      {/* Always-mounted host for the order-item "Add to queue" action (print-queue plugin);
          renders nothing until an action fires, and nothing when no plugin is present. */}
      <PluginSlot name="orders.overlays" context={{}} />
    </Stack>
  )
}
