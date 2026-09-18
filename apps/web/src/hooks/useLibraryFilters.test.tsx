import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { LibraryFile, LibraryFolder } from '@printstream/shared'
import type { TagFilter } from './useTagFilter'
import { installJsdomGlobals } from '../test-utils/jsdom'

const dom = installJsdomGlobals({ url: 'http://localhost/workspaces/test/library' })
const { renderHook, cleanup } = await import('@testing-library/react')
const { useLibraryFilters } = await import('./useLibraryFilters')
afterEach(() => { cleanup(); dom.window.localStorage.clear() })
after(() => dom.window.close())

const tagFilter = {
  value: ['tag'], matches: (id: string) => id === 'tagged', searchText: () => 'Workshop'
} as unknown as TagFilter

function file(id: string): LibraryFile {
  return {
    id, name: `${id}.gcode`, sizeBytes: 100, kind: 'gcode', uploadedAt: '2026-09-01T00:00:00Z',
    thumbnailPath: null, folderId: null, compatiblePrinterModels: [], plateTypeChips: [],
    nozzleSizeChips: [], projectFilamentChips: [], favorite: false, printCount: 0, lastPrintedAt: null
  }
}

for (const bridgeRoot of [true, false]) {
  test(`selected tags retain ${bridgeRoot ? 'bridge-root' : 'nested-folder'} navigation`, () => {
    const childFolders: LibraryFolder[] = [
      { id: bridgeRoot ? 'bridge:one' : 'folder', name: 'Models', parentId: null }
    ]
    const { result } = renderHook(() => useLibraryFilters({
      tagFilter, childFolders, visibleFiles: bridgeRoot ? [] : [file('tagged'), file('untagged')],
      currentFolderId: null, requestedBridgeId: bridgeRoot ? null : 'one', deferredSearch: '',
      sort: { key: 'name', dir: 'asc' }, favoritesOnly: false
    }))
    assert.deepEqual(result.current.filteredFolders, childFolders)
    assert.deepEqual(result.current.pagedFolders, childFolders)
    assert.deepEqual(result.current.filteredFiles.map(({ id }) => id), bridgeRoot ? [] : ['tagged'])
  })
}
