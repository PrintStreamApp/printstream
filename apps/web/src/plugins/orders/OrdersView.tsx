import { useEffect, useMemo, useState, type ComponentProps } from 'react'
import {
  Accordion,
  AccordionDetails,
  AccordionGroup,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  Dropdown,
  Divider,
  FormControl,
  FormLabel,
  IconButton,
  Input,
  Menu,
  MenuButton,
  MenuItem,
  ModalDialog,
  Option,
  Select,
  Sheet,
  Stack,
  Textarea,
  Tooltip,
  Typography
} from '@mui/joy'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import EditRoundedIcon from '@mui/icons-material/EditRounded'
import FactCheckRoundedIcon from '@mui/icons-material/FactCheckRounded'
import FolderOpenRoundedIcon from '@mui/icons-material/FolderOpenRounded'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded'
import MoreVertIcon from '@mui/icons-material/MoreVert'
import PlaylistAddRoundedIcon from '@mui/icons-material/PlaylistAddRounded'
import PrintRoundedIcon from '@mui/icons-material/PrintRounded'
import TaskAltRoundedIcon from '@mui/icons-material/TaskAltRounded'
import UndoRoundedIcon from '@mui/icons-material/UndoRounded'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import type {
  LibraryBrowseResponse,
  LibraryFile,
  LibraryFolder,
  Order,
  OrderCreateInput,
  OrderList,
  OrderUpdateInput,
  Permission,
  OrderTemplate,
  OrderTemplateCreateInput,
  OrderTemplateList,
  OrderTemplateUpdateInput,
  Printer,
  PrinterStatus,
  SlicingCapabilities,
  SlicingJobResponse,
  ThreeMfProjectFilament,
  ThreeMfIndex
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
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'
import { apiFetch } from '../../lib/apiClient'
import { useAuthBootstrapQuery } from '../../lib/authQuery'
import { buildApiUrl } from '../../lib/apiUrl'
import { type DirectorySortDirection } from '../../components/DirectoryControls'
import { DirectoryPrimaryToolbar } from '../../components/DirectoryToolbar'
import { PaginatedSection } from '../../components/PaginationFooter'
import { NestedViewHeader } from '../../components/NestedViewHeader'
import { formatLibraryFileName } from '../../lib/libraryDisplay'
import { BackAwareModal as Modal } from '../../components/BackAwareModal'
import { ConfirmActionDialog } from '../../components/ConfirmActionDialog'
import { DialogSection } from '../../components/DialogSection'
import { EmptyState } from '../../components/EmptyState'
import { LibraryBreadcrumb } from '../../components/LibraryBreadcrumb'
import { OverflowTooltipText } from '../../components/OverflowTooltipText'
import { ScrollableDialogBody, ScrollableModalDialog } from '../../components/ScrollableDialog'
import { LibraryBrowser, LibraryFileRow, LibraryToolbar, type LibrarySort, type LibraryViewMode } from '../../components/LibraryBrowser'
import { LibraryPlatePreview } from '../../components/LibraryPlateSelect'
import { SquareMediaFrame } from '../../components/SquareMediaFrame'
import { PrintModal, SliceFileModal, SliceThenPrintModal } from '../../pages/LibraryView'
import { isUnslicedThreeMfFile } from '../../lib/libraryFileTags'
import { toast } from '../../lib/toast'
import { readCurrentWorkspaceScopeKey, workspaceQueryKeys } from '../../lib/workspaceScope'
import {
  COMMON_FILAMENT_COLOR_SWATCHES,
  commonFilamentColorName,
  resolveFilamentColorSwatches,
  resolveProjectFilamentColorName
} from '../../lib/filamentColor'
import { bambuMaterialFromPresetName, bambuMaterialFromType } from '../../data/bambuColors'
import { brandFromPresetName } from '../../data/bambuFilamentPresets'
import { buildLibraryBreadcrumb, fromBridgeFolderId, isBridgeFolderId, toBridgeFolderId } from '../../lib/libraryNavigation'
import { buildTenantWorkspacePath, parseWorkspacePathname } from '../../lib/workspaceRoute'
import {
  addTemplateDraftItemPlate,
  createEmptyTemplateDraftItem,
  createEmptyTemplateDraftVariant,
  flattenTemplateDraftVariants,
  getTemplateDraftItemQuantity,
  getTemplateDraftItemTotalQuantity,
  groupTemplateVariants,
  removeTemplateDraftItemPlate,
  renameTemplateDraftItemPlate,
  setTemplateDraftItemPlateQuantity,
  type TemplateDraftItem,
  type TemplateDraftVariant
} from './templateDraft'

interface PrintTargetState {
  orderId: string
  printId: string
  file: LibraryFile
  plate: number
  projectFilamentOverrides: Order['prints'][number]['projectFilamentOverrides']
}

type OrderPrintLauncher = (
  file: LibraryFile,
  printId: string,
  plate: number,
  projectFilamentOverrides: Order['prints'][number]['projectFilamentOverrides']
) => void

type OrderListPrintLauncher = (
  orderId: string,
  file: LibraryFile,
  printId: string,
  plate: number,
  projectFilamentOverrides: Order['prints'][number]['projectFilamentOverrides']
) => void

const LIST_PAGE_SIZE_OPTIONS = [5, 10, 25] as const
const ORDER_SORT_OPTIONS = [
  { value: 'updated', label: 'Updated' },
  { value: 'created', label: 'Created' }
] as const

type OrderSortValue = (typeof ORDER_SORT_OPTIONS)[number]['value']

type SliceFlowSubmitInput = Parameters<ComponentProps<typeof SliceFileModal>['onSubmit']>[0]
type SliceFlowSubmitAction = Parameters<ComponentProps<typeof SliceFileModal>['onSubmit']>[1]

/** A started slicing run for an unsliced-3MF order item, awaiting its print. */
interface SliceThenPrintState {
  orderId: string
  printId: string
  sourceFile: LibraryFile
  jobId: string
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
  const [activeOrderSortValue, setActiveOrderSortValue] = useState<OrderSortValue>('updated')
  const [activeOrderSortDirection, setActiveOrderSortDirection] = useState<DirectorySortDirection>('desc')
  const [completedOrderSortValue, setCompletedOrderSortValue] = useState<OrderSortValue>('updated')
  const [completedOrderSortDirection, setCompletedOrderSortDirection] = useState<DirectorySortDirection>('desc')
  const [templatesPageSize, setTemplatesPageSize] = useState<number>(LIST_PAGE_SIZE_OPTIONS[0])
  const [activeOrdersPageSize, setActiveOrdersPageSize] = useState<number>(10)
  const [completedOrdersPageSize, setCompletedOrdersPageSize] = useState<number>(10)
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
  const filesQuery = useQuery<{ files: LibraryFile[] }>({
    queryKey: ['library-files', 'all'],
    queryFn: ({ signal }) => apiFetch<{ files: LibraryFile[] }>('/api/library', { signal }),
    enabled: authBootstrapQuery.isSuccess ? canManageOrders && canViewLibrary : false
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
      const body = {
        sourceFileId: input.orderTarget.file.id,
        slicerTargetId: input.slicerTargetId,
        target: input.target.mode === 'realPrinter'
          ? {
              mode: 'realPrinter',
              printerId: input.target.printerId,
              printerProfileId: input.target.printerProfileId,
              plateType: input.target.plateType,
              nozzleDiameters: input.target.nozzleDiameters,
              toolheads: input.target.toolheads,
              processProfileId: input.target.processProfileId,
              processSettingOverrides: input.target.processSettingOverrides,
              filamentMappings: input.target.filamentMappings
            }
          : {
              mode: 'manualProfile',
              printerProfileId: input.target.printerProfileId,
              printerModel: input.target.printerModel ?? 'unknown',
              plateType: input.target.plateType,
              nozzleDiameters: input.target.nozzleDiameters,
              toolheads: input.target.toolheads,
              processProfileId: input.target.processProfileId,
              processSettingOverrides: input.target.processSettingOverrides,
              filamentMappings: input.target.filamentMappings
            },
        outputFileName: input.outputFileName,
        outputFolderId: null,
        hiddenOutput: true,
        plate: input.plate,
        selectedObjectIds: input.selectedObjectIds,
        objectProcessOverrides: input.objectProcessOverrides
      }
      return await apiFetch<SlicingJobResponse>('/api/slicing/jobs', { method: 'POST', body })
    },
    onSuccess: async (response, variables) => {
      setSliceTarget(null)
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
            <Typography level="h3">Orders</Typography>
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
          onClose={() => setSliceThenPrintTarget(null)}
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
    </Stack>
  )
}

function SectionHeading({
  title,
  subtitle,
  actions
}: {
  title: string
  subtitle: string
  actions?: React.ReactNode
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

function EmptyBlock({
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

function OrdersListRoute({
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

function TemplatesListRoute({
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

function OrderDetailRoute({
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

function OrdersTableSection({
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

function compareOrderDates(left: Order, right: Order, sortValue: OrderSortValue, sortDirection: DirectorySortDirection): number {
  const leftDate = sortValue === 'created' ? left.createdAt : left.updatedAt
  const rightDate = sortValue === 'created' ? right.createdAt : right.updatedAt
  return sortDirection === 'desc'
    ? rightDate.localeCompare(leftDate)
    : leftDate.localeCompare(rightDate)
}

function OrderListCard({
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

function OrderListPrintCard({
  group,
  file,
  orderIsActive,
  onStartPrint,
  onManualComplete,
  pendingManualPrintId,
  canManageOrders,
  canStartOrderPrint
}: {
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

function DetailHeader({
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

function DetailNotFound({ kind, loading, onBack }: { kind: 'order' | 'template'; loading: boolean; onBack: () => void }) {
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

function OrderProgressChips({ order, compact = false }: { order: Order; compact?: boolean }) {
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

function TemplateDetailCard({
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

function SectionEmptyState({ title, message }: { title: string; message: string }) {
  return (
    <EmptyState
      icon={<FactCheckRoundedIcon />}
      title={title}
      description={message}
      compact
    />
  )
}

function matchesTemplateSearch(template: OrderTemplate, search: string): boolean {
  const normalizedSearch = search.trim().toLowerCase()
  if (!normalizedSearch) return true

  const haystack = [
    template.name,
    template.code,
    template.description,
    template.notesTemplate,
    ...template.variants.map((variant) => variant.name),
    ...template.items.map((item) => [item.libraryFileName, item.notes].join(' '))
  ].filter(Boolean).join(' ').toLowerCase()

  return haystack.includes(normalizedSearch)
}

function matchesOrderSearch(order: Order, search: string): boolean {
  const normalizedSearch = search.trim().toLowerCase()
  if (!normalizedSearch) return true

  const haystack = [
    order.name,
    order.templateName,
    order.templateCode,
    order.templateDescription,
    order.notes,
    ...order.selectedVariants.map((variant) => variant.templateVariantName),
    ...order.prints.map((print) => [print.libraryFileName, print.notes, print.startedPrinterName].join(' '))
  ].filter(Boolean).join(' ').toLowerCase()

  return haystack.includes(normalizedSearch)
}

function countTemplateCopies(template: OrderTemplate): number {
  return template.items.reduce((sum, item) => sum + item.quantity, 0)
}

function countTemplateVariantCopies(variant: OrderTemplate['variants'][number]): number {
  return variant.items.reduce((sum, item) => sum + item.quantity, 0)
}

function countTemplateFiles(template: OrderTemplate): number {
  return new Set(template.items.map((item) => item.libraryFileName)).size
}

function OrderSelectedVariantChips({ order, compact = false }: { order: Order; compact?: boolean }) {
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

function getVisibleOrderSelectedVariants(order: Order): Order['selectedVariants'] {
  if (order.selectedVariants.length === 0) return []

  if (
    order.selectedVariants.length === 1
    && order.selectedVariants[0]?.quantity === 1
    && order.selectedVariants[0].templateVariantName === 'Default'
  ) {
    return []
  }

  return order.selectedVariants
}

function OrderRowMenu({
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

function stopEventPropagation(event: { stopPropagation(): void }): void {
  event.stopPropagation()
}

function TemplateItemSummary({ templateItem }: { templateItem: OrderTemplate['items'][number] }) {
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

function OrderCard({
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

function OrderPrintPlateThumb({
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

function OrderPrintPlateName({
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

function useLibraryPlateLabel(libraryFileId: string | null, plate: number, fileAvailable: boolean): string {
  const platesQuery = useQuery<ThreeMfIndex>({
    queryKey: ['library-plates', libraryFileId],
    queryFn: ({ signal }) => apiFetch<ThreeMfIndex>(`/api/library/${libraryFileId}/plates`, { signal }),
    enabled: Boolean(libraryFileId && fileAvailable),
    staleTime: 60_000
  })

  const resolvedPlate = platesQuery.data?.plates.find((entry) => entry.index === plate)
  return resolvedPlate?.name?.trim() || `Plate ${plate}`
}

interface OrderPrintGroup {
  key: string
  groupPosition: number
  libraryFileId: string | null
  libraryFileName: string
  plate: number
  notes: string | null
  projectFilamentOverrides: Order['prints'][number]['projectFilamentOverrides']
  total: number
  completed: number
  awaitingConfirmation: number
  active: number
  pending: number
  fileAvailable: boolean
  startablePrint: Order['prints'][number] | null
  confirmablePrint: Order['prints'][number] | null
  manuallyCompletablePrint: Order['prints'][number] | null
  reopenablePrint: Order['prints'][number] | null
  latestStartedPrinterName: string | null
  latestFinishedAt: string | null
}

function groupOrderPrints(prints: Order['prints']): OrderPrintGroup[] {
  const groups = new Map<string, Order['prints']>()

  for (const print of prints) {
    const key = [
      print.groupPosition,
      print.templatePrintId ?? '',
      print.libraryFileId ?? '',
      print.libraryFileName,
      print.plate,
      print.notes ?? ''
    ].join('\u0000')
    const existing = groups.get(key)
    if (existing) {
      existing.push(print)
      continue
    }
    groups.set(key, [print])
  }

  return Array.from(groups.entries(), ([key, groupedPrints]) => {
    const sorted = [...groupedPrints].sort((left, right) => left.sequenceNumber - right.sequenceNumber)
    const startablePrint = sorted.find((print) => (
      print.activityState === 'pending'
      || print.activityState === 'failed'
      || print.activityState === 'cancelled'
    )) ?? null
    const confirmablePrint = sorted.find((print) => print.activityState === 'awaiting-confirmation') ?? null
    const reopenablePrint = [...sorted].reverse().find((print) => print.status === 'completed') ?? null
    const latestActivityPrint = [...sorted].sort(compareOrderPrintRecency)[0] ?? null

    return {
      key,
      groupPosition: sorted[0]?.groupPosition ?? 0,
      libraryFileId: sorted[0]?.libraryFileId ?? null,
      libraryFileName: sorted[0]?.libraryFileName ?? '',
      plate: sorted[0]?.plate ?? 1,
      notes: sorted[0]?.notes ?? null,
      projectFilamentOverrides: sorted[0]?.projectFilamentOverrides ?? null,
      total: sorted.length,
      completed: sorted.filter((print) => print.status === 'completed').length,
      awaitingConfirmation: sorted.filter((print) => print.activityState === 'awaiting-confirmation').length,
      active: sorted.filter((print) => print.activityState === 'queued' || print.activityState === 'printing').length,
      pending: sorted.filter((print) => (
        print.activityState === 'pending'
        || print.activityState === 'failed'
        || print.activityState === 'cancelled'
      )).length,
      fileAvailable: sorted.some((print) => print.fileAvailable),
      startablePrint,
      confirmablePrint,
      manuallyCompletablePrint: startablePrint,
      reopenablePrint,
      latestStartedPrinterName: latestActivityPrint?.startedPrinterName ?? null,
      latestFinishedAt: latestActivityPrint?.lastPrintFinishedAt ?? null
    }
  }).sort((left, right) => left.groupPosition - right.groupPosition)
}

function compareOrderPrintRecency(left: Order['prints'][number], right: Order['prints'][number]): number {
  const leftTime = Date.parse(left.lastPrintFinishedAt ?? left.startedAt ?? '')
  const rightTime = Date.parse(right.lastPrintFinishedAt ?? right.startedAt ?? '')
  return (Number.isFinite(rightTime) ? rightTime : -Infinity) - (Number.isFinite(leftTime) ? leftTime : -Infinity)
}

function TemplateDialog({
  files,
  template,
  onClose,
  onSaved
}: {
  files: LibraryFile[]
  template: OrderTemplate | null
  onClose: () => void
  onSaved: () => void
}) {
  const isEditing = Boolean(template)
  const [name, setName] = useState(template?.name ?? '')
  const [code, setCode] = useState(template?.code ?? '')
  const [description, setDescription] = useState(template?.description ?? '')
  const [notesTemplate, setNotesTemplate] = useState(template?.notesTemplate ?? '')
  const [variants, setVariants] = useState<TemplateDraftVariant[]>(() => (
    template ? groupTemplateVariants(template.variants) : [createEmptyTemplateDraftVariant()]
  ))
  const [expandedVariantIndex, setExpandedVariantIndex] = useState<number | null>(0)
  const [error, setError] = useState<string | null>(null)
  const flattenedVariants = flattenTemplateDraftVariants(variants)
  const hasBlankVariantNames = variants.some((variant) => !variant.name.trim())
  const hasIncompleteItems = variants.some((variant) => variant.items.some((item) => !item.libraryFileId))
  const hasItemsWithoutQuantities = variants.some((variant) => variant.items.some((item) => item.libraryFileId && getTemplateDraftItemTotalQuantity(item) === 0))
  const hasEmptyVariants = flattenedVariants.some((variant) => variant.items.length === 0)

  const save = useMutation({
    mutationFn: (body: OrderTemplateCreateInput | OrderTemplateUpdateInput) => {
      if (template) {
        return apiFetch(`/api/plugins/orders/templates/${template.id}`, { method: 'PATCH', body })
      }
      return apiFetch('/api/plugins/orders/templates', { method: 'POST', body })
    },
    onSuccess: onSaved,
    onError: (mutationError) => setError((mutationError as Error).message)
  })

  const updateVariant = (index: number, next: Partial<TemplateDraftVariant>) => {
    setVariants((current) => current.map((variant, variantIndex) => (variantIndex === index ? { ...variant, ...next } : variant)))
  }

  const updateVariantItems = (variantIndex: number, nextItems: TemplateDraftItem[]) => {
    setVariants((current) => current.map((variant, currentIndex) => (
      currentIndex === variantIndex
        ? { ...variant, items: nextItems }
        : variant
    )))
  }

  return (
    <Modal open onClose={onClose}>
      <ScrollableModalDialog sx={{ width: { xs: '100%', md: 920 } }}>
        <Typography level="h4">{isEditing ? 'Edit template' : 'New template'}</Typography>
        <ScrollableDialogBody sx={{ mt: 1.5, p: 0 }}>
          <Stack spacing={2} sx={{ minWidth: 0 }}>
            <DialogSection title="Template details">
              <Stack spacing={1.25}>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25}>
                  <FormControl sx={{ flex: 1 }}>
                    <FormLabel>Name</FormLabel>
                    <Input value={name} onChange={(event) => setName(event.target.value)} />
                  </FormControl>
                  <FormControl sx={{ width: { xs: '100%', sm: 180 } }}>
                    <FormLabel>Code</FormLabel>
                    <Input value={code} onChange={(event) => setCode(event.target.value)} />
                  </FormControl>
                </Stack>

                <FormControl>
                  <FormLabel>Description</FormLabel>
                  <Textarea minRows={2} value={description} onChange={(event) => setDescription(event.target.value)} />
                </FormControl>

                <FormControl>
                  <FormLabel>Default order notes</FormLabel>
                  <Textarea minRows={3} value={notesTemplate} onChange={(event) => setNotesTemplate(event.target.value)} />
                </FormControl>
              </Stack>
            </DialogSection>

            <DialogSection title="Variants">
              <Stack spacing={1}>
                <AccordionGroup sx={{ gap: 1 }}>
                  {variants.map((variant, variantIndex) => {
                    const variantCopyCount = variant.items.reduce((sum, item) => sum + getTemplateDraftItemTotalQuantity(item), 0)
                    return (
                      <Accordion
                        key={`${template?.id ?? 'new'}:variant:${variantIndex}`}
                        expanded={expandedVariantIndex === variantIndex}
                        onChange={(_event, expanded) => setExpandedVariantIndex(expanded ? variantIndex : null)}
                      >
                        <AccordionSummary indicator={<KeyboardArrowDownRoundedIcon />}>
                          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }} sx={{ width: '100%', pr: 1 }}>
                            <Typography level="title-sm">{variant.name.trim() || `Variant ${variantIndex + 1}`}</Typography>
                            <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap' }}>
                              <Chip size="sm" variant="soft">{variant.items.length} print{variant.items.length === 1 ? '' : 's'}</Chip>
                              <Chip size="sm" variant="soft">{variantCopyCount} copies</Chip>
                            </Stack>
                          </Stack>
                        </AccordionSummary>
                        <AccordionDetails>
                          <Stack spacing={1.25}>
                            <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems={{ xs: 'stretch', md: 'flex-end' }}>
                              <FormControl sx={{ flex: 1 }}>
                                <FormLabel>Variant name</FormLabel>
                                <Input
                                  value={variant.name}
                                  onChange={(event) => updateVariant(variantIndex, { name: event.target.value })}
                                />
                              </FormControl>
                              <Box sx={{ display: 'flex', justifyContent: { xs: 'flex-end', md: 'flex-end' } }}>
                                <IconButton
                                  color="danger"
                                  variant="plain"
                                  disabled={variants.length <= 1}
                                  onClick={() => {
                                    setVariants((current) => current.filter((_value, index) => index !== variantIndex))
                                    setExpandedVariantIndex((current) => {
                                      if (current == null) return current
                                      if (current === variantIndex) return Math.max(0, variantIndex - 1)
                                      return current > variantIndex ? current - 1 : current
                                    })
                                  }}
                                >
                                  <DeleteRoundedIcon />
                                </IconButton>
                              </Box>
                            </Stack>

                            <Stack spacing={1}>
                              {variant.items.map((item, itemIndex) => (
                                <TemplateDraftItemEditor
                                  key={`${template?.id ?? 'new'}:${variantIndex}:${itemIndex}`}
                                  item={item}
                                  files={files}
                                  onChange={(next) => updateVariantItems(
                                    variantIndex,
                                    variant.items.map((currentItem, currentIndex) => (
                                      currentIndex === itemIndex
                                        ? { ...currentItem, ...next }
                                        : currentItem
                                    ))
                                  )}
                                  onRemove={() => updateVariantItems(
                                    variantIndex,
                                    variant.items.filter((_value, currentIndex) => currentIndex !== itemIndex)
                                  )}
                                  canRemove={variant.items.length > 1}
                                />
                              ))}

                              <Box sx={{ display: 'flex', justifyContent: 'flex-start' }}>
                                <Button
                                  size="sm"
                                  variant="soft"
                                  startDecorator={<AddRoundedIcon />}
                                  onClick={() => updateVariantItems(variantIndex, [...variant.items, createEmptyTemplateDraftItem()])}
                                >
                                  Add print
                                </Button>
                              </Box>
                            </Stack>
                          </Stack>
                        </AccordionDetails>
                      </Accordion>
                    )
                  })}
                </AccordionGroup>

                <Box sx={{ display: 'flex', justifyContent: 'flex-start' }}>
                  <Button
                    size="sm"
                    variant="soft"
                    startDecorator={<AddRoundedIcon />}
                    onClick={() => setVariants((current) => {
                      const next = [...current, createEmptyTemplateDraftVariant(`Variant ${current.length + 1}`)]
                      setExpandedVariantIndex(next.length - 1)
                      return next
                    })}
                  >
                    Add variant
                  </Button>
                </Box>
              </Stack>
            </DialogSection>

            {error && <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>{error}</Alert>}
          </Stack>
        </ScrollableDialogBody>

        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1 }}>
          <Button variant="plain" onClick={onClose}>Cancel</Button>
          <Button
            disabled={!name.trim() || hasBlankVariantNames || hasIncompleteItems || hasItemsWithoutQuantities || flattenedVariants.length === 0 || hasEmptyVariants}
            loading={save.isPending}
            onClick={() => save.mutate({
              name,
              code: code || null,
              description: description || null,
              notesTemplate: notesTemplate || null,
              variants: flattenedVariants
            })}
          >
            {isEditing ? 'Save template' : 'Create template'}
          </Button>
        </Stack>
      </ScrollableModalDialog>
    </Modal>
  )
}

function EditOrderDialog({
  order,
  onClose,
  onSaved,
  pending
}: {
  order: Order
  onClose: () => void
  onSaved: (body: OrderUpdateInput) => void
  pending: boolean
}) {
  const [name, setName] = useState(order.name)
  const [notes, setNotes] = useState(order.notes ?? '')

  return (
    <Modal open onClose={onClose}>
      <ModalDialog sx={{ maxWidth: 560, width: '100%' }}>
        <Typography level="h4">Edit order</Typography>
        <Stack spacing={1.5}>
          <FormControl>
            <FormLabel>Order name</FormLabel>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </FormControl>
          <FormControl>
            <FormLabel>Notes</FormLabel>
            <Textarea minRows={4} value={notes} onChange={(event) => setNotes(event.target.value)} />
          </FormControl>
        </Stack>

        <Stack direction="row" spacing={1} justifyContent="flex-end">
          <Button variant="plain" onClick={onClose}>Cancel</Button>
          <Button
            loading={pending}
            disabled={!name.trim()}
            onClick={() => onSaved({
              name,
              notes: notes || null
            })}
          >
            Save order
          </Button>
        </Stack>
      </ModalDialog>
    </Modal>
  )
}

function TemplateDraftItemEditor({
  item,
  files,
  onChange,
  onRemove,
  canRemove
}: {
  item: TemplateDraftItem
  files: LibraryFile[]
  onChange: (next: Partial<TemplateDraftItem>) => void
  onRemove: () => void
  canRemove: boolean
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const platesQuery = useQuery<ThreeMfIndex>({
    queryKey: ['library-plates', item.libraryFileId],
    queryFn: ({ signal }) => apiFetch<ThreeMfIndex>(`/api/library/${item.libraryFileId}/plates`, { signal }),
    enabled: Boolean(item.libraryFileId),
    staleTime: 60_000
  })

  const plates = useMemo(
    () => platesQuery.data?.plates ?? [],
    [platesQuery.data]
  )
  const selectedFile = item.libraryFileId
    ? files.find((file) => file.id === item.libraryFileId) ?? null
    : null
  const selectedFileLabel = item.libraryFileName
    ? formatLibraryFileName(item.libraryFileName)
    : 'No library file selected'
  const hasIndexedPlates = item.libraryFileId && plates.length > 0

  return (
    <>
      <Sheet variant="outlined" sx={{ p: 1.25, borderRadius: 'md', minWidth: 0, overflow: 'hidden' }}>
        <Stack spacing={1} sx={{ minWidth: 0 }}>
          <FormControl sx={{ flex: 1 }}>
            <FormLabel>Library file</FormLabel>
            {selectedFile ? (
              <Sheet variant="soft" sx={{ p: 1, borderRadius: 'md', minWidth: 0 }}>
                <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems={{ xs: 'stretch', md: 'center' }} sx={{ minWidth: 0 }}>
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <LibraryFileRow
                      file={selectedFile}
                      onClick={() => setPickerOpen(true)}
                      hideMetadataTags
                    />
                  </Box>
                  <Box sx={{ display: 'flex', justifyContent: { xs: 'flex-start', md: 'flex-end' }, flexShrink: 0 }}>
                    <Button size="sm" variant="soft" onClick={() => setPickerOpen(true)}>
                      Change file
                    </Button>
                  </Box>
                </Stack>
              </Sheet>
            ) : (
              <Sheet variant="soft" sx={{ p: 1.25, borderRadius: 'md' }}>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography level="body-sm">{selectedFileLabel}</Typography>
                    <Typography level="body-xs" textColor="text.tertiary">
                      {item.libraryFileName
                        ? 'This file is currently missing from the available library listing.'
                        : 'Browse the library to choose a printer-ready G-code or G-code 3MF file.'}
                    </Typography>
                  </Box>
                  <Button size="sm" variant="soft" onClick={() => setPickerOpen(true)}>
                    {item.libraryFileId ? 'Change file' : 'Browse library'}
                  </Button>
                </Stack>
              </Sheet>
            )}
          </FormControl>

          <Stack spacing={1} sx={{ minWidth: 0 }}>
            <FormControl sx={{ flex: 1, minWidth: 0 }}>
              {!item.libraryFileId ? (
                <>
                  <FormLabel>Plates</FormLabel>
                  <Sheet variant="soft" sx={{ p: 1.25, borderRadius: 'md' }}>
                    <Typography level="body-sm">Choose a library file first</Typography>
                    <Typography level="body-xs" textColor="text.tertiary">
                      Plate quantities appear after you pick a printer-ready file.
                    </Typography>
                      </Sheet>
                </>
              ) : hasIndexedPlates ? (
                <>
                  <FormLabel>Plates</FormLabel>
                  <Stack spacing={0.75}>
                    {plates.map((plate) => (
                      <Sheet key={plate.index} variant="soft" sx={{ p: 1, borderRadius: 'md' }}>
                        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'stretch', sm: 'center' }}>
                          <Box sx={{ flex: 1, minWidth: 0 }}>
                            <LibraryPlatePreview
                              fileId={item.libraryFileId}
                              plate={plate}
                              size={56}
                              noWrap={false}
                              subtitleFallback={formatTemplateDraftPlateSummary(plate)}
                            />
                          </Box>
                          <FormControl sx={{ width: { xs: '100%', sm: 180 }, alignSelf: { xs: 'stretch', sm: 'flex-end' } }}>
                            <FormLabel>Qty</FormLabel>
                            <Input
                              type="number"
                              value={String(getTemplateDraftItemQuantity(item, plate.index))}
                              onChange={(event) => onChange({
                                plateQuantities: setTemplateDraftItemPlateQuantity(
                                  item,
                                  plate.index,
                                  Number(event.target.value) || 0
                                ).plateQuantities
                              })}
                            />
                          </FormControl>
                        </Stack>
                      </Sheet>
                    ))}
                  </Stack>
                  <Typography level="body-xs" textColor="text.tertiary">
                    Set a quantity above zero for each plate you want this template to require.
                  </Typography>
                </>
              ) : (
                <>
                  <Stack direction="row" spacing={1} justifyContent="space-between" alignItems="center">
                    <FormLabel sx={{ mb: 0 }}>Plates</FormLabel>
                    <Button
                      size="sm"
                      variant="plain"
                      startDecorator={<AddRoundedIcon />}
                      onClick={() => onChange({ plateQuantities: addTemplateDraftItemPlate(item).plateQuantities })}
                    >
                      Add plate
                    </Button>
                  </Stack>
                  <Stack spacing={0.75}>
                    {item.plateQuantities.map((entry, entryIndex) => (
                      <Sheet key={`${entry.plate}:${entryIndex}`} variant="soft" sx={{ p: 1, borderRadius: 'md' }}>
                        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'stretch', sm: 'flex-end' }}>
                          <FormControl sx={{ flex: 1, minWidth: 0 }}>
                            <FormLabel>Plate</FormLabel>
                            <Input
                              type="number"
                              value={String(entry.plate)}
                              onChange={(event) => onChange({
                                plateQuantities: renameTemplateDraftItemPlate(
                                  item,
                                  entry.plate,
                                  Number(event.target.value) || 1
                                ).plateQuantities
                              })}
                            />
                          </FormControl>
                          <FormControl sx={{ width: { xs: '100%', sm: 180 }, alignSelf: { xs: 'stretch', sm: 'flex-end' } }}>
                            <FormLabel>Qty</FormLabel>
                            <Input
                              type="number"
                              value={String(entry.quantity)}
                              onChange={(event) => onChange({
                                plateQuantities: setTemplateDraftItemPlateQuantity(
                                  item,
                                  entry.plate,
                                  Number(event.target.value) || 0
                                ).plateQuantities
                              })}
                            />
                          </FormControl>
                          <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                            <IconButton
                              color="danger"
                              variant="plain"
                              disabled={item.plateQuantities.length <= 1}
                              onClick={() => onChange({
                                plateQuantities: removeTemplateDraftItemPlate(item, entry.plate).plateQuantities
                              })}
                            >
                              <DeleteRoundedIcon />
                            </IconButton>
                          </Box>
                        </Stack>
                      </Sheet>
                    ))}
                  </Stack>
                </>
              )}
            </FormControl>
          </Stack>

          <FormControl>
            <FormLabel>Notes</FormLabel>
            <Input value={item.notes} onChange={(event) => onChange({ notes: event.target.value })} />
          </FormControl>

          <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
            <IconButton color="danger" variant="plain" disabled={!canRemove} onClick={onRemove}>
              <DeleteRoundedIcon />
            </IconButton>
          </Box>
        </Stack>
      </Sheet>

      {pickerOpen && (
        <TemplateLibraryFilePickerDialog
          files={files}
          selectedFileId={item.libraryFileId}
          onClose={() => setPickerOpen(false)}
          onPick={(file) => {
            onChange({
              libraryFileId: file.id,
              libraryFileName: file.name,
              plateQuantities: createEmptyTemplateDraftItem().plateQuantities
            })
            setPickerOpen(false)
          }}
        />
      )}
    </>
  )
}

function formatTemplateDraftPlateSummary(plate: ThreeMfIndex['plates'][number]): string {
  const uniqueObjects = Array.from(new Set(plate.objects.map((object) => object.name.trim()).filter(Boolean)))
  if (uniqueObjects.length > 0) {
    return uniqueObjects.join(', ')
  }
  if (plate.filaments.length > 0) {
    return `${plate.filaments.length} filament${plate.filaments.length === 1 ? '' : 's'}`
  }
  return 'No indexed objects'
}

function TemplateLibraryFilePickerDialog({
  files,
  selectedFileId,
  onClose,
  onPick
}: {
  files: LibraryFile[]
  selectedFileId: string
  onClose: () => void
  onPick: (file: LibraryFile) => void
}) {
  const selectedFile = selectedFileId ? files.find((file) => file.id === selectedFileId) ?? null : null
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(selectedFile?.folderId ?? null)
  const [bridgeId, setBridgeId] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<LibraryViewMode>('list')
  const [sort, setSort] = useState<LibrarySort>({ key: 'name', dir: 'asc' })
  const browseQuery = useQuery<LibraryBrowseResponse>({
    queryKey: ['library-browse', 'orders-picker', currentFolderId ?? 'root', bridgeId ?? 'none'],
    queryFn: () => {
      const params = new URLSearchParams()
      if (currentFolderId) params.set('folderId', currentFolderId)
      if (bridgeId) params.set('bridgeId', bridgeId)
      const search = params.toString()
      return apiFetch<LibraryBrowseResponse>(`/api/library/browse${search ? `?${search}` : ''}`)
    },
    staleTime: 60_000
  })
  const browseData = browseQuery.data
  const resolvedBridgeId = browseData?.activeBridgeId ?? bridgeId
  const foldersQuery = useQuery<{ folders: LibraryFolder[] }>({
    queryKey: ['library-folders', 'orders-picker', resolvedBridgeId ?? 'none'],
    queryFn: () => {
      const params = new URLSearchParams()
      if (resolvedBridgeId) params.set('bridgeId', resolvedBridgeId)
      const search = params.toString()
      return apiFetch<{ folders: LibraryFolder[] }>(`/api/library/folders${search ? `?${search}` : ''}`)
    },
    staleTime: 60_000
  })
  const bridgeRootMode = browseData?.mode === 'bridge-root'
  const bridgeEntries = browseData?.bridgeEntries ?? []
  const bridgeFolders = bridgeEntries.map((bridge) => ({ id: toBridgeFolderId(bridge.id), name: bridge.name, parentId: null } satisfies LibraryFolder))

  const allFolders = useMemo(
    () => foldersQuery.data?.folders ?? [],
    [foldersQuery.data?.folders]
  )
  const childFolders = useMemo(
    () => bridgeRootMode ? bridgeFolders : (browseData?.folders ?? []),
    [bridgeFolders, bridgeRootMode, browseData?.folders]
  )
  const visibleFiles = useMemo(
    () => browseData?.files ?? [],
    [browseData?.files]
  )
  const activeBridgeName = resolvedBridgeId ? bridgeEntries.find((bridge) => bridge.id === resolvedBridgeId)?.name ?? null : null
  const breadcrumb = useMemo(
    () => buildLibraryBreadcrumb(allFolders, currentFolderId, resolvedBridgeId, activeBridgeName, {
      showRoot: bridgeEntries.length !== 1
    }),
    [activeBridgeName, allFolders, bridgeEntries.length, currentFolderId, resolvedBridgeId]
  )
  const pickerError = (browseQuery.error ?? foldersQuery.error) as Error | undefined

  return (
    <Modal open onClose={onClose}>
      <ScrollableModalDialog sx={{ width: { xs: '100%', md: 920 } }}>
        <Typography level="h4">Choose library file</Typography>
        <ScrollableDialogBody sx={{ mt: 1.5, p: 0 }}>
          <Stack spacing={2} sx={{ minHeight: 420, minWidth: 0 }}>
            <Typography level="body-sm" textColor="text.secondary">
              Browse folders and pick the printer-ready file this order template should require.
            </Typography>
            <DialogSection
              title="Location"
              description={selectedFile ? `Current selection: ${formatLibraryFileName(selectedFile.name)}` : undefined}
            >
              <Stack spacing={1.25}>
                {bridgeRootMode && (
                  <Alert color="neutral" variant="outlined" startDecorator={<InfoOutlinedIcon />}>
                    Select a library source to browse printable files.
                  </Alert>
                )}

                <LibraryBreadcrumb
                  crumbs={breadcrumb}
                  onNavigate={(folderEntryId) => {
                    if (folderEntryId === null) {
                      setCurrentFolderId(null)
                      setBridgeId(null)
                      return
                    }
                    if (folderEntryId && isBridgeFolderId(folderEntryId)) {
                      setBridgeId(fromBridgeFolderId(folderEntryId))
                      setCurrentFolderId(null)
                      return
                    }
                    setCurrentFolderId(folderEntryId)
                  }}
                />

                <LibraryToolbar
                  viewMode={viewMode}
                  onViewModeChange={setViewMode}
                  sort={sort}
                  onSortChange={setSort}
                />

                {pickerError && <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>{pickerError.message}</Alert>}
              </Stack>
            </DialogSection>

            <DialogSection title="Files">
              <LibraryBrowser
                folders={childFolders}
                files={visibleFiles}
                viewMode={viewMode}
                sort={sort}
                surfaceStyle="dialog"
                onFolderOpen={(folder) => {
                  if (isBridgeFolderId(folder.id)) {
                    setBridgeId(fromBridgeFolderId(folder.id))
                    setCurrentFolderId(null)
                    return
                  }
                  setCurrentFolderId(folder.id)
                }}
                onFilePick={onPick}
                isFilePickable={(file) => isDirectPrintableFileName(file.name) || isUnslicedThreeMfFile(file)}
                getFileDisabledReason={(file) => (
                  isDirectPrintableFileName(file.name) || isUnslicedThreeMfFile(file)
                    ? null
                    : 'Only G-code, G-code 3MF, or project 3MF files can be added to orders.'
                )}
                emptyState={
                  <EmptyState
                    icon={<FolderOpenRoundedIcon />}
                    title={bridgeRootMode ? 'No bridges connected' : currentFolderId ? 'This folder is empty' : 'No files in the library yet'}
                    description={
                      bridgeRootMode
                        ? 'Connect a bridge to browse its files.'
                        : currentFolderId
                        ? 'Choose another folder or upload a printer-ready file here from the Library page.'
                        : 'Upload printer-ready files in the Library page, then add them to this template.'
                    }
                  />
                }
              />
            </DialogSection>
          </Stack>
        </ScrollableDialogBody>

        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1 }}>
          <Button variant="plain" onClick={onClose}>Cancel</Button>
        </Stack>
      </ScrollableModalDialog>
    </Modal>
  )
}

function OrderDialog({
  templates,
  initialTemplateId,
  onClose,
  onSaved
}: {
  templates: OrderTemplate[]
  initialTemplateId: string
  onClose: () => void
  onSaved: () => void
}) {
  const initialTemplate = templates.find((template) => template.id === initialTemplateId) ?? templates[0] ?? null
  const [templateId, setTemplateId] = useState(initialTemplate?.id ?? '')
  const [name, setName] = useState('')
  const [notes, setNotes] = useState(initialTemplate?.notesTemplate ?? '')
  const [variantQuantities, setVariantQuantities] = useState<Record<string, number>>(() => createInitialOrderVariantQuantities(initialTemplate))
  const [printFilamentOverrides, setPrintFilamentOverrides] = useState<Record<string, ThreeMfProjectFilament[]>>({})
  const [colorPickerTarget, setColorPickerTarget] = useState<{
    templatePrintId: string
    variantCopyIndex: number
    filamentId: number
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const selectedTemplate = templates.find((template) => template.id === templateId) ?? null
  const selectedVariants = buildSelectedOrderVariantSelections(selectedTemplate, variantQuantities)
  const requiresVariantSelection = (selectedTemplate?.variants.length ?? 0) > 1
  const selectedTemplatePrints = useMemo(
    () => buildSelectedTemplatePrints(selectedTemplate, variantQuantities),
    [selectedTemplate, variantQuantities]
  )
  const selectedTemplatePrintFileIds = useMemo(
    () => Array.from(new Set(
      selectedTemplatePrints.flatMap(({ item }) => item.libraryFileId && item.fileAvailable ? [item.libraryFileId] : [])
    )).sort(),
    [selectedTemplatePrints]
  )
  const templateFileIndexesQuery = useQuery<Record<string, ThreeMfIndex>>({
    queryKey: ['orders', 'template-filaments', selectedTemplate?.id ?? null, selectedTemplatePrintFileIds],
    queryFn: async ({ signal }) => Object.fromEntries(
      await Promise.all(
        selectedTemplatePrintFileIds.map(async (fileId) => [
          fileId,
          await apiFetch<ThreeMfIndex>(`/api/library/${fileId}/plates`, { signal })
        ] as const)
      )
    ),
    enabled: selectedTemplatePrintFileIds.length > 0,
    staleTime: 60_000
  })
  const selectedTemplatePrintFilaments = useMemo<SelectedTemplatePrintWithFilaments[]>(
    () => selectedTemplatePrints.map((templatePrint) => {
      const fileIndex = templatePrint.item.libraryFileId
        ? templateFileIndexesQuery.data?.[templatePrint.item.libraryFileId]
        : undefined

      return {
        ...templatePrint,
        plateInfo: fileIndex?.plates.find((entry) => entry.index === templatePrint.item.plate),
        projectFilaments: buildTemplatePrintProjectFilaments(templatePrint.item, fileIndex)
      }
    }).filter((templatePrint) => templatePrint.projectFilaments.length > 0),
    [selectedTemplatePrints, templateFileIndexesQuery.data]
  )
  const selectedOrderPrintFilamentOverrides = useMemo(
    () => buildOrderPrintFilamentOverrides(selectedTemplatePrintFilaments, printFilamentOverrides),
    [printFilamentOverrides, selectedTemplatePrintFilaments]
  )
  const isFilamentMappingLoading = selectedTemplatePrintFileIds.length > 0 && templateFileIndexesQuery.isLoading
  const filamentMappingError = templateFileIndexesQuery.error as Error | null

  useEffect(() => {
    setPrintFilamentOverrides((current) => {
      const next: Record<string, ThreeMfProjectFilament[]> = {}
      for (const templatePrint of selectedTemplatePrintFilaments) {
        for (let variantCopyIndex = 0; variantCopyIndex < templatePrint.variantQuantity; variantCopyIndex += 1) {
          const copyKey = buildTemplatePrintVariantCopyKey(templatePrint.item.id, variantCopyIndex)
          next[copyKey] = mergeProjectFilamentDrafts(
            templatePrint.projectFilaments,
            current[copyKey]
          )
        }
      }
      return next
    })
  }, [selectedTemplatePrintFilaments])

  const activeColorPickerTarget = useMemo(() => {
    if (!colorPickerTarget) return null
    const templatePrint = selectedTemplatePrintFilaments.find((entry) => entry.item.id === colorPickerTarget.templatePrintId)
    if (!templatePrint) return null
    const sourceFilament = templatePrint.projectFilaments.find((entry) => entry.id === colorPickerTarget.filamentId)
    if (!sourceFilament) return null
    const copyKey = buildTemplatePrintVariantCopyKey(templatePrint.item.id, colorPickerTarget.variantCopyIndex)
    const selectedFilament = printFilamentOverrides[copyKey]?.find((entry) => entry.id === sourceFilament.id)
      ?? sourceFilament

    return {
      templatePrint,
      copyKey,
      variantCopyIndex: colorPickerTarget.variantCopyIndex,
      sourceFilament,
      selectedFilament
    }
  }, [colorPickerTarget, printFilamentOverrides, selectedTemplatePrintFilaments])

  const save = useMutation({
    mutationFn: (body: OrderCreateInput) => apiFetch('/api/plugins/orders/orders', { method: 'POST', body }),
    onSuccess: onSaved,
    onError: (mutationError) => setError((mutationError as Error).message)
  })

  return (
    <>
      <Modal open onClose={onClose}>
      <ScrollableModalDialog sx={{ width: { xs: '100%', sm: 560 } }}>
        <Typography level="h4">New order</Typography>
        <ScrollableDialogBody sx={{ mt: 1.5, p: 0 }}>
          <Stack spacing={2}>
          <DialogSection title="Order details">
            <Stack spacing={1.25}>
              <FormControl>
                <FormLabel>Template</FormLabel>
                <Select
                  value={templateId || null}
                  onChange={(_event, value) => {
                    const nextTemplate = templates.find((template) => template.id === value) ?? null
                    setTemplateId(value ?? '')
                    setNotes(nextTemplate?.notesTemplate ?? '')
                    setVariantQuantities(createInitialOrderVariantQuantities(nextTemplate))
                    setPrintFilamentOverrides({})
                    setColorPickerTarget(null)
                  }}
                >
                  {templates.map((template) => (
                    <Option key={template.id} value={template.id}>{template.name}</Option>
                  ))}
                </Select>
              </FormControl>
              <FormControl>
                <FormLabel>Order name</FormLabel>
                <Input value={name} onChange={(event) => setName(event.target.value)} />
              </FormControl>
              <FormControl>
                <FormLabel>Notes</FormLabel>
                <Textarea minRows={4} value={notes} onChange={(event) => setNotes(event.target.value)} />
              </FormControl>
            </Stack>
          </DialogSection>

          {requiresVariantSelection && selectedTemplate && (
            <DialogSection
              title="Variants"
              description="Choose one or more variants and how many of each this order should include."
            >
              <Stack spacing={1}>
                {selectedTemplate.variants.map((variant) => {
                  const quantity = variantQuantities[variant.id] ?? 0
                  const selected = quantity > 0
                  return (
                    <Sheet key={variant.id} variant="outlined" sx={{ p: 1.25, borderRadius: 'md' }}>
                      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25} alignItems={{ xs: 'stretch', sm: 'center' }}>
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Checkbox
                              checked={selected}
                              onChange={(_event) => setVariantQuantities((current) => {
                                const currentQuantity = current[variant.id] ?? 0
                                return {
                                  ...current,
                                  [variant.id]: currentQuantity > 0 ? 0 : 1
                                }
                              })}
                            />
                            <Box sx={{ minWidth: 0 }}>
                              <Typography level="title-sm">{variant.name}</Typography>
                              <Typography level="body-xs" textColor="text.tertiary">
                                {variant.items.length} plate group{variant.items.length === 1 ? '' : 's'} · {countTemplateVariantCopies(variant)} copies per selection
                              </Typography>
                            </Box>
                          </Stack>
                        </Box>
                        <FormControl sx={{ width: { xs: '100%', sm: 120 } }}>
                          <FormLabel>Qty</FormLabel>
                          <Input
                            type="number"
                            disabled={!selected}
                            value={selected ? String(quantity) : ''}
                            onChange={(event) => setVariantQuantities((current) => ({
                              ...current,
                              [variant.id]: Math.max(0, Math.trunc(Number(event.target.value) || 0))
                            }))}
                          />
                        </FormControl>
                      </Stack>
                    </Sheet>
                  )
                })}
              </Stack>
            </DialogSection>
          )}

          {selectedTemplatePrints.length > 0 && (
            <DialogSection
              title="Color mapping"
              description="Keep each model's material the same and choose the color you want shown later when assigning AMS trays."
            >
              <Stack spacing={1}>
                {isFilamentMappingLoading && (
                  <Typography level="body-sm" textColor="text.tertiary">
                    Loading model materials...
                  </Typography>
                )}

                {!isFilamentMappingLoading && filamentMappingError && (
                  <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
                    {filamentMappingError.message}
                  </Alert>
                )}

                {!isFilamentMappingLoading && !filamentMappingError && selectedTemplatePrintFilaments.length === 0 && (
                  <Typography level="body-sm" textColor="text.tertiary">
                    No filament metadata is available for the selected prints.
                  </Typography>
                )}

                {!isFilamentMappingLoading && !filamentMappingError && selectedTemplatePrintFilaments.map((templatePrint) => (
                  <Sheet key={templatePrint.item.id} variant="outlined" sx={{ p: 1.25, borderRadius: 'md' }}>
                    <Stack spacing={1.25} sx={{ minWidth: 0 }}>
                      <Box sx={{ minWidth: 0 }}>
                        {templatePrint.item.libraryFileId ? (
                          <LibraryPlatePreview
                            fileId={templatePrint.item.libraryFileId}
                            plate={templatePrint.plateInfo}
                            size={56}
                            subtitleFallback={`${templatePrint.item.quantity * templatePrint.variantQuantity} cop${templatePrint.item.quantity * templatePrint.variantQuantity === 1 ? 'y' : 'ies'}`}
                            noWrap={false}
                          />
                        ) : (
                          <Stack spacing={0.25}>
                            <Typography level="title-sm">{formatLibraryFileName(templatePrint.item.libraryFileName)}</Typography>
                            <Typography level="body-xs" textColor="text.tertiary">Plate {templatePrint.item.plate}</Typography>
                          </Stack>
                        )}
                        <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.75 }}>
                          {templatePrint.variantName} · {templatePrint.item.quantity * templatePrint.variantQuantity} cop{templatePrint.item.quantity * templatePrint.variantQuantity === 1 ? 'y' : 'ies'}
                        </Typography>
                      </Box>

                      <Box
                        sx={{
                          display: 'grid',
                          gap: 1,
                          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
                          minWidth: 0
                        }}
                      >
                        {Array.from({ length: templatePrint.variantQuantity }, (_unused, variantCopyIndex) => {
                          const copyKey = buildTemplatePrintVariantCopyKey(templatePrint.item.id, variantCopyIndex)

                          return (
                            <Stack key={copyKey} spacing={0.75} sx={{ minWidth: 0 }}>
                              {templatePrint.variantQuantity > 1 && (
                                <Typography level="body-xs" textColor="text.tertiary">
                                  Copy {variantCopyIndex + 1}
                                </Typography>
                              )}

                              {templatePrint.projectFilaments.map((sourceFilament) => {
                                const selectedFilament = printFilamentOverrides[copyKey]?.find((filament) => filament.id === sourceFilament.id)
                                  ?? sourceFilament
                                const selectedColorLabel = formatProjectFilamentColorLabel(selectedFilament) ?? selectedFilament.color?.toUpperCase() ?? 'Choose color'
                                const hasCustomColor = (selectedFilament.color ?? null) !== (sourceFilament.color ?? null)

                                return (
                                  <Sheet key={`${copyKey}-${sourceFilament.id}`} variant="soft" sx={{ px: 1, py: 0.75, borderRadius: 'md' }}>
                                    <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" sx={{ minWidth: 0 }}>
                                      <OverflowTooltipText
                                        level="body-xs"
                                        textColor="text.tertiary"
                                        noWrap
                                        sx={{ flex: '1 1 0', minWidth: 0 }}
                                        text={sourceFilament.filamentName?.trim() || sourceFilament.filamentType?.trim() || `Filament #${sourceFilament.id}`}
                                      />
                                      <Button
                                        size="sm"
                                        variant={hasCustomColor ? 'soft' : 'outlined'}
                                        color={hasCustomColor ? 'primary' : 'neutral'}
                                        onClick={() => setColorPickerTarget({
                                          templatePrintId: templatePrint.item.id,
                                          variantCopyIndex,
                                          filamentId: sourceFilament.id
                                        })}
                                        sx={{ minWidth: { xs: 116, sm: 140 }, justifyContent: 'flex-start', flexShrink: 0 }}
                                        startDecorator={(
                                          <Box
                                            sx={{
                                              width: 14,
                                              height: 14,
                                              borderRadius: '50%',
                                              backgroundColor: selectedFilament.color ?? 'var(--joy-palette-neutral-700)',
                                              border: '1px solid var(--joy-palette-neutral-700)'
                                            }}
                                          />
                                        )}
                                      >
                                        {selectedColorLabel}
                                      </Button>
                                    </Stack>
                                  </Sheet>
                                )
                              })}
                            </Stack>
                          )
                        })}
                      </Box>
                    </Stack>
                  </Sheet>
                ))}
              </Stack>
            </DialogSection>
          )}

          {error && <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>{error}</Alert>}
          </Stack>
        </ScrollableDialogBody>

        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1 }}>
          <Button variant="plain" onClick={onClose}>Cancel</Button>
          <Button
            loading={save.isPending}
            disabled={
              !name.trim()
              || (requiresVariantSelection && selectedVariants.length === 0)
              || isFilamentMappingLoading
              || filamentMappingError != null
            }
            onClick={() => save.mutate({
              templateId,
              name,
              notes: notes || null,
              printFilamentOverrides: selectedOrderPrintFilamentOverrides.length > 0
                ? selectedOrderPrintFilamentOverrides
                : undefined,
              variants: selectedVariants.length > 0 ? selectedVariants : undefined
            })}
          >
            Create order
          </Button>
        </Stack>
      </ScrollableModalDialog>
      </Modal>

      {activeColorPickerTarget && (
        <OrderColorPickerModal
          templatePrint={activeColorPickerTarget.templatePrint}
          variantCopyIndex={activeColorPickerTarget.variantCopyIndex}
          sourceFilament={activeColorPickerTarget.sourceFilament}
          selectedFilament={activeColorPickerTarget.selectedFilament}
          onClose={() => setColorPickerTarget(null)}
          onPick={(hex) => setPrintFilamentOverrides((current) => ({
            ...current,
            [activeColorPickerTarget.copyKey]: updateProjectFilamentDraft(
              current[activeColorPickerTarget.copyKey] ?? activeColorPickerTarget.templatePrint.projectFilaments,
              activeColorPickerTarget.sourceFilament.id,
              (filament) => ({
                ...filament,
                color: hex
              })
            )
          }))}
          onReset={() => {
            setPrintFilamentOverrides((current) => ({
              ...current,
              [activeColorPickerTarget.copyKey]: updateProjectFilamentDraft(
                current[activeColorPickerTarget.copyKey] ?? activeColorPickerTarget.templatePrint.projectFilaments,
                activeColorPickerTarget.sourceFilament.id,
                () => normalizeProjectFilamentDraft(activeColorPickerTarget.sourceFilament)
              )
            }))
            setColorPickerTarget(null)
          }}
        />
      )}
    </>
  )
}

interface SelectedTemplatePrint {
  variantId: string
  variantName: string
  variantQuantity: number
  item: OrderTemplate['variants'][number]['items'][number]
}

interface SelectedTemplatePrintWithFilaments extends SelectedTemplatePrint {
  plateInfo: ThreeMfIndex['plates'][number] | undefined
  projectFilaments: ThreeMfProjectFilament[]
}

function createInitialOrderVariantQuantities(template: OrderTemplate | null): Record<string, number> {
  if (!template || template.variants.length <= 1) return {}

  return Object.fromEntries(template.variants.map((variant) => [variant.id, 0]))
}

function buildSelectedOrderVariantSelections(
  template: OrderTemplate | null,
  variantQuantities: Record<string, number>
): NonNullable<OrderCreateInput['variants']> {
  if (!template) return []

  return template.variants.flatMap((variant) => {
    const quantity = Math.max(0, Math.trunc(variantQuantities[variant.id] ?? 0))
    return quantity > 0
      ? [{ variantId: variant.id, quantity }]
      : []
  })
}

function buildSelectedTemplatePrints(
  template: OrderTemplate | null,
  variantQuantities: Record<string, number>
): SelectedTemplatePrint[] {
  if (!template) return []

  return template.variants.flatMap((variant) => {
    const variantQuantity = template.variants.length <= 1
      ? 1
      : Math.max(0, Math.trunc(variantQuantities[variant.id] ?? 0))
    if (variantQuantity <= 0) return []

    return variant.items.map((item) => ({
      variantId: variant.id,
      variantName: variant.name,
      variantQuantity,
      item
    }))
  })
}

function buildTemplatePrintVariantCopyKey(templatePrintId: string, variantCopyIndex: number): string {
  return `${templatePrintId}:${variantCopyIndex}`
}

function buildTemplatePrintProjectFilaments(
  item: OrderTemplate['variants'][number]['items'][number],
  fileIndex: ThreeMfIndex | undefined
): ThreeMfProjectFilament[] {
  if (!fileIndex) return []
  const plate = fileIndex.plates.find((entry) => entry.index === item.plate)

  if (fileIndex.projectFilaments.length > 0) {
    const plateFilamentIds = new Set((plate?.filaments ?? []).map((filament) => filament.id))
    const relevantProjectFilaments = plateFilamentIds.size > 0
      ? fileIndex.projectFilaments.filter((filament) => plateFilamentIds.has(filament.id))
      : fileIndex.projectFilaments

    return relevantProjectFilaments.map(normalizeProjectFilamentDraft)
  }

  return (plate?.filaments ?? []).map((filament) => normalizeProjectFilamentDraft({
    id: filament.id,
    filamentType: filament.filamentType,
    filamentName: filament.filamentName,
    color: filament.color,
    nozzleId: filament.nozzleId ?? null,
    chamberTemperature: filament.chamberTemperature ?? null
  }))
}

function buildOrderPrintFilamentOverrides(
  selectedTemplatePrints: Array<SelectedTemplatePrint & { projectFilaments: ThreeMfProjectFilament[] }>,
  printFilamentOverrides: Record<string, ThreeMfProjectFilament[]>
): NonNullable<OrderCreateInput['printFilamentOverrides']> {
  return selectedTemplatePrints.flatMap((templatePrint) => (
    Array.from({ length: templatePrint.variantQuantity }, (_unused, variantCopyIndex) => {
      const projectFilaments = printFilamentOverrides[
        buildTemplatePrintVariantCopyKey(templatePrint.item.id, variantCopyIndex)
      ]
      return projectFilaments && projectFilaments.length > 0
        ? [{
          templatePrintId: templatePrint.item.id,
          variantCopyIndex,
          projectFilaments: projectFilaments.map(normalizeProjectFilamentDraft)
        }]
        : []
    })
  )).flat()
}

function mergeProjectFilamentDrafts(
  sourceProjectFilaments: readonly ThreeMfProjectFilament[],
  existingProjectFilaments: readonly ThreeMfProjectFilament[] | undefined
): ThreeMfProjectFilament[] {
  const existingById = new Map((existingProjectFilaments ?? []).map((filament) => [filament.id, filament] as const))
  return sourceProjectFilaments.map((filament) => normalizeProjectFilamentDraft(existingById.get(filament.id) ?? filament))
}

function updateProjectFilamentDraft(
  filaments: readonly ThreeMfProjectFilament[],
  filamentId: number,
  update: (filament: ThreeMfProjectFilament) => ThreeMfProjectFilament
): ThreeMfProjectFilament[] {
  return filaments.map((filament) => filament.id === filamentId
    ? normalizeProjectFilamentDraft(update(filament))
    : normalizeProjectFilamentDraft(filament))
}

function normalizeProjectFilamentDraft(filament: ThreeMfProjectFilament): ThreeMfProjectFilament {
  return {
    id: filament.id,
    filamentType: filament.filamentType?.trim() || null,
    filamentName: filament.filamentName?.trim() || null,
    color: filament.color?.trim() || null,
    nozzleId: filament.nozzleId ?? null,
    chamberTemperature: filament.chamberTemperature ?? null
  }
}

function resolveProjectFilamentColorOptions(filament: Pick<ThreeMfProjectFilament, 'filamentName' | 'filamentType'>) {
  const presetBrand = filament.filamentName?.trim()
    ? brandFromPresetName(filament.filamentName.trim())
    : null
  const material = bambuMaterialFromPresetName(filament.filamentName?.trim() ?? '')
    ?? (filament.filamentType ? bambuMaterialFromType(filament.filamentType) : null)
    ?? filament.filamentType

  return resolveFilamentColorSwatches(material, { presetBrand })
}

function describeProjectFilamentColorOptions(filament: Pick<ThreeMfProjectFilament, 'filamentName' | 'filamentType'>): string {
  const presetBrand = filament.filamentName?.trim()
    ? brandFromPresetName(filament.filamentName.trim())
    : null
  const material = bambuMaterialFromPresetName(filament.filamentName?.trim() ?? '')
    ?? (filament.filamentType ? bambuMaterialFromType(filament.filamentType) : null)
    ?? filament.filamentType
    ?? 'filament'
  const { usesCommonFallback } = resolveProjectFilamentColorOptions(filament)

  return !usesCommonFallback && presetBrand === 'Bambu'
    ? `Bambu ${material} colors`
    : `${material} color suggestions`
}

function formatProjectFilamentLabel(filament: ThreeMfProjectFilament): string {
  const name = filament.filamentName?.trim() || filament.filamentType?.trim() || `Filament #${filament.id}`
  const color = formatProjectFilamentColorLabel(filament)
  return [name, color].filter(Boolean).join(' · ')
}

function formatProjectFilamentColorLabel(filament: Pick<ThreeMfProjectFilament, 'color' | 'filamentName' | 'filamentType'>): string | null {
  return resolveProjectFilamentColorName(filament)
    ?? commonFilamentColorName(filament.color)
    ?? filament.color?.toUpperCase()
    ?? null
}

function toColorPickerValue(color: string | null | undefined): string {
  return /^#[0-9a-fA-F]{6}$/.test(color ?? '')
    ? (color ?? '').toUpperCase()
    : '#808080'
}

function OrderColorSwatchPicker({
  title,
  swatches,
  selectedHex,
  onPick
}: {
  title: string
  swatches: typeof COMMON_FILAMENT_COLOR_SWATCHES
  selectedHex: string
  onPick: (hex: string) => void
}) {
  return (
    <Box>
      <Typography level="body-xs" textColor="text.tertiary" sx={{ mb: 0.5 }}>
        {title}
      </Typography>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(28px, 1fr))',
          gap: 0.75
        }}
      >
        {swatches.map((swatch) => {
          const isSelected = swatch.hex.toUpperCase() === selectedHex
          return (
            <Box
              key={`${swatch.name}-${swatch.hex}`}
              component="button"
              type="button"
              onClick={() => onPick(swatch.hex)}
              title={`${swatch.name} (${swatch.hex})`}
              aria-label={`${swatch.name} ${swatch.hex}`}
              sx={{
                appearance: 'none',
                p: 0,
                width: '100%',
                aspectRatio: '1 / 1',
                borderRadius: '50%',
                cursor: 'pointer',
                background: swatch.hex,
                border: (theme) =>
                  isSelected
                    ? `2px solid ${theme.vars.palette.primary.solidBg}`
                    : `1px solid ${theme.vars.palette.divider}`,
                boxShadow: isSelected
                  ? '0 0 0 2px rgba(255,255,255,0.15) inset'
                  : 'none',
                transition: 'transform 80ms ease',
                '&:hover': { transform: 'scale(1.08)' },
                '&:focus-visible': {
                  outline: (theme) => `2px solid ${theme.vars.palette.focusVisible}`,
                  outlineOffset: 2
                }
              }}
            />
          )
        })}
      </Box>
    </Box>
  )
}

function OrderColorPickerModal({
  templatePrint,
  variantCopyIndex,
  sourceFilament,
  selectedFilament,
  onClose,
  onPick,
  onReset
}: {
  templatePrint: SelectedTemplatePrintWithFilaments
  variantCopyIndex: number
  sourceFilament: ThreeMfProjectFilament
  selectedFilament: ThreeMfProjectFilament
  onClose: () => void
  onPick: (hex: string) => void
  onReset: () => void
}) {
  const swatches = resolveProjectFilamentColorOptions(selectedFilament).swatches
  const selectedHex = toColorPickerValue(selectedFilament.color)
  const sourceColorLabel = formatProjectFilamentColorLabel(sourceFilament) ?? sourceFilament.color?.toUpperCase() ?? 'Unspecified'
  const selectedColorLabel = formatProjectFilamentColorLabel(selectedFilament) ?? selectedFilament.color?.toUpperCase() ?? 'Choose color'

  return (
    <Modal open onClose={onClose}>
      <ScrollableModalDialog sx={{ width: { xs: '100%', sm: 420 } }}>
        <Typography level="h4">Choose color</Typography>
        <Typography level="body-sm" textColor="text.tertiary">
          {templatePrint.item.libraryFileName} · Plate {templatePrint.item.plate}
          {templatePrint.variantQuantity > 1 ? ` · Copy ${variantCopyIndex + 1}` : ''}
        </Typography>

        <ScrollableDialogBody sx={{ mt: 1.5, p: 0 }}>
          <Stack spacing={1.25}>
            <Sheet variant="soft" sx={{ p: 1.25, borderRadius: 'md' }}>
              <Stack spacing={0.75}>
                <Typography level="body-xs" textColor="text.tertiary">
                  {sourceFilament.filamentName?.trim() || sourceFilament.filamentType?.trim() || `Filament #${sourceFilament.id}`}
                </Typography>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
                  <Stack direction="row" spacing={0.75} alignItems="center" sx={{ flex: '1 1 0', minWidth: 0 }}>
                    <Box
                      sx={{
                        width: 18,
                        height: 18,
                        borderRadius: '50%',
                        backgroundColor: sourceFilament.color ?? 'var(--joy-palette-neutral-700)',
                        border: '1px solid var(--joy-palette-neutral-700)',
                        flexShrink: 0
                      }}
                    />
                    <Typography level="body-sm" noWrap>{sourceColorLabel}</Typography>
                  </Stack>
                  <Typography level="body-xs" textColor="text.tertiary">to</Typography>
                  <Stack direction="row" spacing={0.75} alignItems="center" sx={{ flex: '1 1 0', minWidth: 0, justifyContent: 'flex-end' }}>
                    <Box
                      sx={{
                        width: 18,
                        height: 18,
                        borderRadius: '50%',
                        backgroundColor: selectedFilament.color ?? 'var(--joy-palette-neutral-700)',
                        border: '1px solid var(--joy-palette-neutral-700)',
                        flexShrink: 0
                      }}
                    />
                    <Typography level="body-sm" noWrap>{selectedColorLabel}</Typography>
                  </Stack>
                </Stack>
              </Stack>
            </Sheet>

            <Stack direction="row" spacing={1} alignItems="center">
              <Input
                size="sm"
                type="color"
                value={selectedHex}
                onChange={(event) => onPick(event.target.value)}
                sx={{ width: 56, '--Input-paddingInline': '0.25rem' }}
              />
              <Input
                size="sm"
                value={selectedFilament.color ?? ''}
                placeholder="#RRGGBB"
                onChange={(event) => onPick(event.target.value)}
                sx={{ flex: 1 }}
              />
            </Stack>

            <OrderColorSwatchPicker
              title={describeProjectFilamentColorOptions(selectedFilament)}
              swatches={swatches}
              selectedHex={selectedHex}
              onPick={onPick}
            />
          </Stack>
        </ScrollableDialogBody>

        <Stack direction="row" spacing={1} justifyContent="space-between" sx={{ pt: 1 }}>
          <Button variant="plain" color="neutral" onClick={onReset}>Use model color</Button>
          <Stack direction="row" spacing={1}>
            <Button variant="plain" onClick={onClose}>Done</Button>
          </Stack>
        </Stack>
      </ScrollableModalDialog>
    </Modal>
  )
}

function formatDateTime(value: string): string {
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) return value
  return parsed.toLocaleString()
}

