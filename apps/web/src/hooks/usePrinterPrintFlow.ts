/**
 * Print-flow targets for the printer dashboard.
 * The page renders the stacked dialogs; this hook keeps the targets and the
 * close/Back transitions that must leave earlier pickers mounted.
 */
import { useCallback, useState } from 'react'
import type {
  LibraryFile,
  PrintJob,
  PrintStartOptionSelection,
  Printer,
  StartOrderPrintInput
} from '@printstream/shared'
import { showDemoFileUploadNotice } from '../lib/printerViewConstants'

type PrintTarget = {
  file: LibraryFile
  printerId: string
  defaultPlate?: number
  defaultPrintOptions?: Partial<PrintStartOptionSelection> | null
  defaultAmsMapping?: number[] | null
  submitPrint?: (input: {
    printerId: string
    body: Omit<StartOrderPrintInput, 'printerId'>
  }) => Promise<void>
}

/** Keep each print step mounted until Close, and let Back remove only the print dialog. */
export function usePrinterPrintFlow(demoMode: boolean) {
  const [pickerForPrinter, setPickerForPrinter] = useState<Printer | null>(null)
  const [printTarget, setPrintTarget] = useState<PrintTarget | null>(null)
  const [sliceTarget, setSliceTarget] = useState<{ file: LibraryFile; preferredPrinterId: string } | null>(null)
  const [sliceThenPrintTarget, setSliceThenPrintTarget] = useState<{
    sourceFile: LibraryFile
    jobId: string
    preferredPrinterId: string
  } | null>(null)
  const [resliceJob, setResliceJob] = useState<PrintJob | null>(null)
  const [localFileForPrinter, setLocalFileForPrinter] = useState<Printer | null>(null)
  const [pageLibraryPickerOpen, setPageLibraryPickerOpen] = useState(false)
  const [pageLocalPrinterPickerOpen, setPageLocalPrinterPickerOpen] = useState(false)

  // PrinterCard is memoized, so one stable callback serves every card.
  const handleCardPrint = useCallback((printer: Printer) => setPickerForPrinter(printer), [])
  const handleCardPrintLocal = useCallback((printer: Printer) => {
    if (demoMode) showDemoFileUploadNotice()
    setLocalFileForPrinter(printer)
  }, [demoMode])

  const closePrintFlow = useCallback(() => {
    setPrintTarget(null)
    setSliceTarget(null)
    setSliceThenPrintTarget(null)
    setPickerForPrinter(null)
    setPageLibraryPickerOpen(false)
  }, [])

  const goBackFromPrintFlow = useCallback(() => setPrintTarget(null), [])

  return {
    pickerForPrinter, setPickerForPrinter,
    printTarget, setPrintTarget,
    sliceTarget, setSliceTarget,
    sliceThenPrintTarget, setSliceThenPrintTarget,
    resliceJob, setResliceJob,
    localFileForPrinter, setLocalFileForPrinter,
    pageLibraryPickerOpen, setPageLibraryPickerOpen,
    pageLocalPrinterPickerOpen, setPageLocalPrinterPickerOpen,
    handleCardPrint, handleCardPrintLocal,
    closePrintFlow, goBackFromPrintFlow
  }
}
