/**
 * Persist printer dashboard display and view defaults per workspace preference scope.
 * Overview filters write through locally; saved views stage their content separately.
 * The single-printer card setting remains independent of overview card settings.
 */
import type { PrinterCardContentSettings, PrinterModel, PrinterViewSort } from '@printstream/shared'
import { defaultPrinterViewSort } from '@printstream/shared'
import { useLocalStorageState } from './useLocalStorageState.js'
import {
  printerCardContentSettingsKeys,
  printerCardsPerRowKeys,
  printerModelFilterKeys,
  printerNozzleDiameterFilterKeys,
  printerOverviewGroupKeys,
  printerOverviewPageSizeKeys,
  printerPlateTypeFilterKeys,
  printerSingleCardContentSettingsKeys,
  printerStateFilterKeys,
  printerViewPrinterIdsKeys,
  printerViewSortKeys
} from '../lib/storageKeys'
import { useDefaultPrinterViewOverride, useSharedDefaultPrinterViewId } from '../lib/printerViewDefaults.js'
import { DEFAULT_SINGLE_PRINTER_CARD_CONTENT_SETTINGS } from '../lib/printerViewConstants.js'
import {
  DEFAULT_PRINTER_CARD_CONTENT_SETTINGS,
  encodePrinterViewSort,
  parseCardsPerRow,
  parsePrinterCardContentSettings,
  parsePrinterGroupBy,
  parsePrinterModelFilter,
  parsePrinterOverviewPageSize,
  parsePrinterStateFilter,
  parsePrinterViewSort,
  parseStoredStringArray,
  PRINTER_OVERVIEW_PAGE_SIZE_OPTIONS,
  type PrinterGroupBy,
  type PrinterStateFilter
} from '../lib/printersViewHelpers.js'

/** Return workspace-scoped dashboard preferences and their setters. */
export function usePrinterOverviewPreferences(workspacePreferenceScopeKey: string) {
  const [cardsPerRow, setCardsPerRow] = useLocalStorageState(
    printerCardsPerRowKeys.at(workspacePreferenceScopeKey),
    3,
    parseCardsPerRow,
    String
  )
  const [stateFilter, setStateFilter] = useLocalStorageState<PrinterStateFilter>(
    printerStateFilterKeys.at(workspacePreferenceScopeKey),
    'all',
    parsePrinterStateFilter,
    String
  )
  const [modelFilter, setModelFilter] = useLocalStorageState<PrinterModel[]>(
    printerModelFilterKeys.at(workspacePreferenceScopeKey),
    [],
    parsePrinterModelFilter,
    JSON.stringify
  )
  const [nozzleDiameterFilter, setNozzleDiameterFilter] = useLocalStorageState<string[]>(
    printerNozzleDiameterFilterKeys.at(workspacePreferenceScopeKey),
    [],
    parseStoredStringArray,
    JSON.stringify
  )
  const [plateTypeFilter, setPlateTypeFilter] = useLocalStorageState<string[]>(
    printerPlateTypeFilterKeys.at(workspacePreferenceScopeKey),
    [],
    parseStoredStringArray,
    JSON.stringify
  )
  const [printerCardContentSettings, setPrinterCardContentSettings] = useLocalStorageState<PrinterCardContentSettings>(
    printerCardContentSettingsKeys.at(workspacePreferenceScopeKey),
    DEFAULT_PRINTER_CARD_CONTENT_SETTINGS,
    parsePrinterCardContentSettings,
    JSON.stringify
  )
  // The single-printer view shows one full-detail card; its content toggles are
  // a workspace preference shared across every printer, independent of the
  // multi-printer Overview/saved-view settings above.
  const [singlePrinterCardContentSettings, setSinglePrinterCardContentSettings] = useLocalStorageState<PrinterCardContentSettings>(
    printerSingleCardContentSettingsKeys.at(workspacePreferenceScopeKey),
    DEFAULT_SINGLE_PRINTER_CARD_CONTENT_SETTINGS,
    parsePrinterCardContentSettings,
    JSON.stringify
  )
  const [defaultViewPrinterIds, setDefaultViewPrinterIds] = useLocalStorageState<string[]>(
    printerViewPrinterIdsKeys.at(workspacePreferenceScopeKey),
    [],
    parseStoredStringArray,
    JSON.stringify
  )
  const [defaultViewSort, setDefaultViewSort] = useLocalStorageState<PrinterViewSort>(
    printerViewSortKeys.at(workspacePreferenceScopeKey),
    defaultPrinterViewSort,
    parsePrinterViewSort,
    encodePrinterViewSort
  )
  // Two-tier default view: this device's override shadows the workspace-shared
  // default (see lib/printerViewDefaults.ts); both are edited from the View
  // settings dialog's Default view card.
  const [defaultViewOverride, setDefaultViewOverride] = useDefaultPrinterViewOverride()
  const sharedDefaultViewId = useSharedDefaultPrinterViewId()

  // Overview has no server row, so its grouping is a local pref; saved views store
  // grouping server-side on the view itself.
  const [overviewGroup, setOverviewGroup] = useLocalStorageState<PrinterGroupBy>(
    printerOverviewGroupKeys.at(workspacePreferenceScopeKey),
    'none',
    parsePrinterGroupBy,
    String
  )
  const [overviewPageSize, setOverviewPageSize] = useLocalStorageState<number>(
    printerOverviewPageSizeKeys.at(workspacePreferenceScopeKey),
    PRINTER_OVERVIEW_PAGE_SIZE_OPTIONS[1],
    parsePrinterOverviewPageSize,
    String
  )
  return {
    cardsPerRow,
    setCardsPerRow,
    stateFilter,
    setStateFilter,
    modelFilter,
    setModelFilter,
    nozzleDiameterFilter,
    setNozzleDiameterFilter,
    plateTypeFilter,
    setPlateTypeFilter,
    printerCardContentSettings,
    setPrinterCardContentSettings,
    singlePrinterCardContentSettings,
    setSinglePrinterCardContentSettings,
    defaultViewPrinterIds,
    setDefaultViewPrinterIds,
    defaultViewSort,
    setDefaultViewSort,
    defaultViewOverride,
    setDefaultViewOverride,
    sharedDefaultViewId,
    overviewGroup,
    setOverviewGroup,
    overviewPageSize,
    setOverviewPageSize
  }
}
