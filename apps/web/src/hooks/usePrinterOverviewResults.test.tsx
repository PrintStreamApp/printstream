import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { Printer } from '@printstream/shared'
import type { PrinterViewContent } from '../lib/printerViewDraft'
import { installJsdomGlobals } from '../test-utils/jsdom'

const dom = installJsdomGlobals()
const React = (await import('react')).default
const { cleanup, renderHook } = await import('@testing-library/react')
const { usePrinterOverviewResults } = await import('./usePrinterOverviewResults')

afterEach(cleanup)
after(() => dom.window.close())

test('overview results preserve sort order and clamp a page after tag search narrows it', () => {
  const printers = ['Alpha', 'Beta', 'Charlie'].map((name, position) => ({
    id: name.toLowerCase(), name, model: 'X1C', host: '192.0.2.1', position
  })) as Printer[]
  const view: PrinterViewContent = {
    sort: { key: 'name', direction: 'asc' }, group: 'none', stateFilter: 'all',
    modelFilter: [], nozzleDiameterFilter: [], plateTypeFilter: [], printerIds: []
  }
  const matchesTags = () => true
  const tagSearchText = (id: string) => id === 'charlie' ? 'Workshop' : ''
  const resolveBridgeName = () => 'Bridge'

  const { result, rerender } = renderHook(({ search }: { search: string }) => {
    const [page, setPage] = React.useState(1)
    const results = usePrinterOverviewResults({
      printers, statuses: {}, search, matchesTags, tagSearchText, view,
      page, setPage, pageSize: 2, resolveBridgeName
    })
    return { page, ...results }
  }, { initialProps: { search: '' } })

  assert.deepEqual(result.current.filteredPrinters.map((printer) => printer.id), ['alpha', 'beta', 'charlie'])
  assert.equal(result.current.overviewPageCount, 2)
  assert.deepEqual(result.current.printerGroups[0]?.printers.map((printer) => printer.id), ['charlie'])

  rerender({ search: 'workshop' })
  assert.deepEqual(result.current.filteredPrinters.map((printer) => printer.id), ['charlie'])
  assert.equal(result.current.page, 0)
  assert.equal(result.current.safeOverviewPage, 0)
  assert.equal(result.current.overviewPageCount, 1)
})
