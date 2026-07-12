/**
 * Constant tables and small notice helpers extracted from
 * `pages/PrintersView.tsx`.
 *
 * Owns the printers-dashboard module-level constants shared by the view and
 * its sub-components: localStorage preference keys, typed empty collections,
 * history pagination/sort options, the printer-settings label/description/
 * section tables, and the public-demo notices. These carry no React state;
 * keep new pure constant tables here rather than re-growing the view.
 */
import {
  type Printer,
  type PrinterCardContentSettings,
  type PrinterControllableLightNode,
  type PrinterModel,
  type PrinterPrintOptionKey,
  type PrinterSelectableAirductMode,
  type PrinterView,
  type PrintJob
} from '@printstream/shared'
import { toast } from './toast'

export const SUCCESS_COLOR = 'var(--joy-palette-success-500)'
export const FAILED_COLOR = 'var(--joy-palette-danger-500)'
export const CANCELLED_COLOR = 'var(--joy-palette-neutral-500)'
// Manually added usage (user-entered stats adjustments) in breakdown charts.
export const MANUAL_COLOR = 'var(--joy-palette-warning-500)'

export const LIBRARY_VIEW_MODE_KEY = 'bambu.library.viewMode'
export const LIBRARY_SORT_KEY = 'bambu.library.sort'
export const DUAL_NOZZLE_PRINTER_MODELS: PrinterModel[] = ['X2D', 'H2D', 'H2DPRO', 'H2C']

export const EMPTY_PRINTERS: Printer[] = []
export const EMPTY_PRINT_JOBS: PrintJob[] = []
export const EMPTY_PRINTER_VIEWS: PrinterView[] = []
export const HISTORY_PAGE_SIZE_OPTIONS = [10, 25, 50] as const
export const HISTORY_SORT_OPTIONS = [{ value: 'date', label: 'Date' }] as const
export const PRINTER_HISTORY_VIEW_MODE_KEY = 'printstream.printers.history.viewMode'
export const PRINTER_HISTORY_SORT_DIR_KEY = 'printstream.printers.history.sortDir'
export const PRINTER_HISTORY_RESULT_FILTER_KEY = 'printstream.printers.history.resultFilter'
export const PRINTER_HISTORY_PAGE_SIZE_KEY = 'printstream.printers.history.pageSize'

export const OVERVIEW_VIEW_OPTION_VALUE = '__overview__'
export const NEW_VIEW_OPTION_VALUE = '__new__'
export const PUBLIC_DEMO_PRINTER_MUTATION_NOTICE = 'This is a public demo. You can explore printer setup, but changes will not be saved.'
export const PUBLIC_DEMO_FILE_UPLOAD_NOTICE = 'This is a public demo. Local uploads stay private, are limited to 15 MB, and are removed within 12 hours. Curated demo library files remain read-only.'
export const DEMO_TEMP_UPLOAD_MAX_BYTES = 15 * 1024 * 1024
export const DISPATCHED_START_WARNING_TIMEOUT_MS = 60_000

export function showDemoPrinterMutationNotice(action: 'add' | 'edit' | 'delete'): void {
  const actionLabel = action === 'add'
    ? 'Adding printers'
    : action === 'edit'
      ? 'Editing printers'
      : 'Deleting printers'
  toast.info(`${actionLabel} is disabled in the public demo. ${PUBLIC_DEMO_PRINTER_MUTATION_NOTICE}`)
}

export function showDemoFileUploadNotice(): void {
  toast.info(PUBLIC_DEMO_FILE_UPLOAD_NOTICE)
}

/**
 * Starting card-content settings for the single-printer view, used as the
 * default of an overridable workspace preference (the "Edit view" dialog) — not
 * a hardcoded, non-editable layout. The single-printer card favors the
 * full-width camera over the thumbnail snapshot, so `fullWidthSnapshot` is on
 * and `cameraThumbnail` is off by default; every other block is shown.
 */
export const DEFAULT_SINGLE_PRINTER_CARD_CONTENT_SETTINGS: PrinterCardContentSettings = {
  nozzleTemperatures: true,
  bedTemperature: true,
  chamberTemperature: true,
  printSpeed: true,
  printStatus: true,
  hmsErrors: true,
  doorState: true,
  ductState: true,
  modelThumbnail: true,
  cameraThumbnail: false,
  fullWidthSnapshot: true,
  amsCards: true,
  footerControls: true
}

export const PRINTER_SETTINGS_LABELS: Record<PrinterPrintOptionKey, string> = {
  aiMonitoring: 'AI monitoring',
  spaghettiDetection: 'Spaghetti detection',
  purgeChutePileupDetection: 'Purge chute pileup detection',
  nozzleClumpingDetection: 'Nozzle clumping detection',
  airPrintingDetection: 'Air printing detection',
  firstLayerInspection: 'First-layer inspection',
  autoRecovery: 'Auto-recovery from step loss',
  promptSound: 'Notification sounds',
  filamentTangleDetection: 'Filament tangle detection'
}

export const PRINTER_SETTINGS_DESCRIPTIONS: Record<PrinterPrintOptionKey, string> = {
  aiMonitoring: 'Uses the printer camera to watch for print failures and stop according to the selected sensitivity.',
  spaghettiDetection: 'Detects spaghetti-like print failures with the camera-based detector.',
  purgeChutePileupDetection: 'Watches for purge waste piling up near the chute during material changes.',
  nozzleClumpingDetection: 'Detects blobs or clumps forming around the nozzle before they turn into a failed print.',
  airPrintingDetection: 'Looks for extrusion continuing without the printed part being formed underneath.',
  firstLayerInspection: 'Checks the first printed layer before the rest of the job continues.',
  autoRecovery: 'Attempts to recover automatically after skipped steps or motion loss events.',
  promptSound: 'Plays the printer notification sound for prompts and warnings.',
  filamentTangleDetection: 'Warns when the printer detects filament tangles or feed obstruction.'
}

export const PRINTER_SETTINGS_SECTIONS: Array<{ title: string; options: PrinterPrintOptionKey[] }> = [
  {
    title: 'AI monitoring',
    options: ['aiMonitoring', 'spaghettiDetection', 'purgeChutePileupDetection', 'nozzleClumpingDetection', 'airPrintingDetection']
  },
  {
    title: 'Protection',
    options: ['firstLayerInspection', 'autoRecovery', 'filamentTangleDetection', 'promptSound']
  }
]

export const AIR_MANAGEMENT_MODES: PrinterSelectableAirductMode[] = ['cooling', 'heating']
export const CONTROLLABLE_LIGHT_NODES: PrinterControllableLightNode[] = ['chamber', 'heatbed']
