import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { LibraryFile, PrintJob, Printer } from '@printstream/shared'
import { installJsdomGlobals } from '../test-utils/jsdom'

const dom = installJsdomGlobals()
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { usePrinterPrintFlow } = await import('./usePrinterPrintFlow')

afterEach(cleanup)
after(() => dom.window.close())

test('print flow keeps its picker on Back and clears stacked dialogs on Close', () => {
  const printer = { id: 'printer-1' } as Printer
  const file = { id: 'file-1' } as LibraryFile
  const resliceJob = { id: 'job-1' } as PrintJob
  const { result, rerender } = renderHook(({ demoMode }) => usePrinterPrintFlow(demoMode), {
    initialProps: { demoMode: false }
  })
  const cardPrint = result.current.handleCardPrint

  act(() => {
    result.current.handleCardPrint(printer)
    result.current.setPrintTarget({ file, printerId: printer.id })
    result.current.setSliceTarget({ file, preferredPrinterId: printer.id })
    result.current.setSliceThenPrintTarget({ sourceFile: file, jobId: 'slice-1', preferredPrinterId: printer.id })
    result.current.setPageLibraryPickerOpen(true)
    result.current.setPageLocalPrinterPickerOpen(true)
    result.current.setLocalFileForPrinter(printer)
    result.current.setResliceJob(resliceJob)
  })

  act(() => result.current.goBackFromPrintFlow())
  assert.equal(result.current.printTarget, null)
  assert.equal(result.current.pickerForPrinter, printer)
  assert.equal(result.current.pageLibraryPickerOpen, true)
  assert.equal(result.current.sliceTarget?.file, file)

  act(() => result.current.closePrintFlow())
  assert.equal(result.current.printTarget, null)
  assert.equal(result.current.sliceTarget, null)
  assert.equal(result.current.sliceThenPrintTarget, null)
  assert.equal(result.current.pickerForPrinter, null)
  assert.equal(result.current.pageLibraryPickerOpen, false)
  // These separate flows retain their original lifetime when Print closes.
  assert.equal(result.current.pageLocalPrinterPickerOpen, true)
  assert.equal(result.current.localFileForPrinter, printer)
  assert.equal(result.current.resliceJob, resliceJob)

  rerender({ demoMode: false })
  assert.equal(result.current.handleCardPrint, cardPrint)
})
