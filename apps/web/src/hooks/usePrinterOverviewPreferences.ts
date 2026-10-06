/**
 * Persist printer dashboard display and view defaults per workspace preference scope.
 * Overview filters write through locally; saved views stage their content separately.
 * The single-printer card setting remains independent of overview card settings.
 */
import type { PrinterCardContentSettings, PrinterModel, PrinterViewSort } from '@printstream/shared'
import { defaultPrinterViewSort } from '@printstream/shared'
import { useLocalStorageState } from './useLocalStorageState.js'
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
    `bambu.printers.cardsPerRow.${workspacePreferenceScopeKey}`,
    3,
    parseCardsPerRow,
    String
  )
  const [stateFilter, setStateFilter] = useLocalStorageState<PrinterStateFilter>(
    `bambu.printers.stateFilter.${workspacePreferenceScopeKey}`,
    'all',
    parsePrinterStateFilter,
    String
  )
  const [modelFilter, setModelFilter] = useLocalStorageState<PrinterModel[]>(
    `bambu.printers.modelFilter.${workspacePreferenceScopeKey}`,
    [],
    parsePrinterModelFilter,
    JSON.stringify
  )
  const [nozzleDiameterFilter, setNozzleDiameterFilter] = useLocalStorageState<string[]>(
    `bambu.printers.nozzleDiameterFilter.${workspacePreferenceScopeKey}`,
    [],
    parseStoredStringArray,
    JSON.stringify
  )
  const [plateTypeFilter, setPlateTypeFilter] = useLocalStorageState<string[]>(
    `bambu.printers.plateTypeFilter.${workspacePreferenceScopeKey}`,
    [],
    parseStoredStringArray,
    JSON.stringify
  )
  const [printerCardContentSettings, setPrinterCardContentSettings] = useLocalStorageState<PrinterCardContentSettings>(
    `bambu.printers.cardContentSettings.${workspacePreferenceScopeKey}`,
    DEFAULT_PRINTER_CARD_CONTENT_SETTINGS,
    parsePrinterCardContentSettings,
    JSON.stringify
  )
  // The single-printer view shows one full-detail card; its content toggles are
  // a workspace preference shared across every printer, independent of the
  // multi-printer Overview/saved-view settings above.
  const [singlePrinterCardContentSettings, setSinglePrinterCardContentSettings] = useLocalStorageState<PrinterCardContentSettings>(
    `bambu.printers.singleCardContentSettings.${workspacePreferenceScopeKey}`,
    DEFAULT_SINGLE_PRINTER_CARD_CONTENT_SETTINGS,
    parsePrinterCardContentSettings,
    JSON.stringify
  )
  const [defaultViewPrinterIds, setDefaultViewPrinterIds] = useLocalStorageState<string[]>(
    `bambu.printers.viewPrinterIds.${workspacePreferenceScopeKey}`,
    [],
    parseStoredStringArray,
    JSON.stringify
  )
  const [defaultViewSort, setDefaultViewSort] = useLocalStorageState<PrinterViewSort>(
    `bambu.printers.viewSort.${workspacePreferenceScopeKey}`,
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
    `bambu.printers.overviewGroup.${workspacePreferenceScopeKey}`,
    'none',
    parsePrinterGroupBy,
    String
  )
  const [overviewPageSize, setOverviewPageSize] = useLocalStorageState<number>(
    `bambu.printers.overviewPageSize.${workspacePreferenceScopeKey}`,
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
