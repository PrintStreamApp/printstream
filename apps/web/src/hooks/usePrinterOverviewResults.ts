/**
 * Visible printer results for the overview directory.
 *
 * The caller owns toolbar drafts and persisted page size. This hook applies the
 * effective view, tag/search filters, sorting, pagination, and grouping in that
 * order, then clamps a page that became invalid after a filter or size change.
 */
import { useEffect, useMemo, type Dispatch, type SetStateAction } from 'react'
import type { Printer, PrinterStatus } from '@printstream/shared'
import type { PrinterViewContent } from '../lib/printerViewDraft'
import {
  filterPrintersForView,
  groupPrintersForOverview,
  matchesPrinterSearch,
  matchesPrinterStateFilter,
  matchesPrinterViewAttributeFilters,
  sortPrintersForView
} from '../lib/printersViewHelpers'

type Options = {
  printers: Printer[] | undefined
  statuses: Record<string, PrinterStatus> | undefined
  search: string
  matchesTags: (id: string) => boolean
  tagSearchText: (id: string) => string
  view: PrinterViewContent
  page: number
  setPage: Dispatch<SetStateAction<number>>
  pageSize: number
  resolveBridgeName: (bridgeId: string | null) => string
}

/** Return the rows and groups visible on the current safe page. */
export function usePrinterOverviewResults({
  printers,
  statuses,
  search,
  matchesTags,
  tagSearchText,
  view,
  page,
  setPage,
  pageSize,
  resolveBridgeName
}: Options) {
  const {
    sort,
    group,
    stateFilter,
    modelFilter,
    nozzleDiameterFilter,
    plateTypeFilter,
    printerIds
  } = view
  const filteredPrinters = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase()
    const attributeFiltered = (printers ?? []).filter((printer) => {
      const status = statuses?.[printer.id]
      return matchesTags(printer.id)
        && (matchesPrinterSearch(printer, search) || tagSearchText(printer.id).toLowerCase().includes(normalizedSearch))
        && matchesPrinterStateFilter(status, stateFilter)
        && matchesPrinterViewAttributeFilters(printer, status, {
          modelFilter,
          nozzleDiameterFilter,
          plateTypeFilter
        })
    })
    const viewFiltered = filterPrintersForView(attributeFiltered, printerIds)
    return sortPrintersForView(viewFiltered, statuses ?? {}, sort)
  }, [matchesTags, tagSearchText, search, stateFilter, modelFilter, nozzleDiameterFilter, plateTypeFilter, printerIds, sort, printers, statuses])

  const overviewPageCount = Math.max(1, Math.ceil(filteredPrinters.length / pageSize))
  const safeOverviewPage = Math.min(page, overviewPageCount - 1)
  const pagedPrinters = useMemo(() => {
    const start = safeOverviewPage * pageSize
    return filteredPrinters.slice(start, start + pageSize)
  }, [filteredPrinters, pageSize, safeOverviewPage])
  const printerGroups = useMemo(
    () => groupPrintersForOverview(pagedPrinters, statuses ?? {}, group, resolveBridgeName),
    [pagedPrinters, statuses, group, resolveBridgeName]
  )

  useEffect(() => {
    setPage((current) => Math.min(current, overviewPageCount - 1))
  }, [overviewPageCount, setPage])

  return { filteredPrinters, pagedPrinters, printerGroups, overviewPageCount, safeOverviewPage }
}
