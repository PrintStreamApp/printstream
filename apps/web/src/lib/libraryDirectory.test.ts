import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LibraryFile, LibraryFolder } from '@printstream/shared'
import { filterLibraryEntries, filterLibraryFilesByMetadata, groupLibraryFiles, paginateLibraryEntries, sortLibraryEntries } from './libraryDirectory'

const folders: LibraryFolder[] = [
  { id: 'folder-alpha', name: 'Alpha Models', parentId: null },
  { id: 'folder-beta', name: 'Beta Parts', parentId: null },
  { id: 'folder-gamma', name: 'Gamma Plates', parentId: null }
]

const files: LibraryFile[] = [
  {
    id: 'file-1',
    name: 'alpha-benchy.gcode.3mf',
    sizeBytes: 100,
    uploadedAt: '2026-05-01T00:00:00.000Z',
    kind: 'gcode',
    thumbnailPath: null,
    folderId: null,
    compatiblePrinterModels: [],
    plateTypeChips: [],
    nozzleSizeChips: [],
    projectFilamentChips: [],
    favorite: false,
    printCount: 5,
    lastPrintedAt: '2026-06-01T00:00:00.000Z'
  },
  {
    id: 'file-2',
    name: 'plate-adapter.stl',
    sizeBytes: 200,
    uploadedAt: '2026-05-02T00:00:00.000Z',
    kind: 'stl',
    thumbnailPath: null,
    folderId: null,
    compatiblePrinterModels: [],
    plateTypeChips: [],
    nozzleSizeChips: [],
    projectFilamentChips: [],
    favorite: true,
    printCount: 0,
    lastPrintedAt: null
  },
  {
    id: 'file-3',
    name: 'gamma-guide.3mf',
    sizeBytes: 300,
    uploadedAt: '2026-05-03T00:00:00.000Z',
    kind: '3mf',
    thumbnailPath: null,
    folderId: null,
    compatiblePrinterModels: [],
    plateTypeChips: [],
    nozzleSizeChips: [],
    projectFilamentChips: [],
    favorite: false,
    printCount: 2,
    lastPrintedAt: '2026-06-10T00:00:00.000Z'
  }
]

test('filterLibraryEntries matches folder names and formatted file names', () => {
  const filtered = filterLibraryEntries(folders, files, 'alpha-benchy')

  assert.deepEqual(filtered.folders, [])
  assert.deepEqual(filtered.files.map((file) => file.id), ['file-1'])
})

test('filterLibraryEntries matches file kind labels', () => {
  const filtered = filterLibraryEntries(folders, files, 'stl')

  assert.deepEqual(filtered.files.map((file) => file.id), ['file-2'])
})

test('filterLibraryFilesByMetadata filters by file type label', () => {
  const gcodeThreeMf = filterLibraryFilesByMetadata(files, {
    printerModels: [],
    nozzleSizes: [],
    plateTypes: [],
    fileTypes: ['3MF GCODE']
  })
  const plainThreeMf = filterLibraryFilesByMetadata(files, {
    printerModels: [],
    nozzleSizes: [],
    plateTypes: [],
    fileTypes: ['3MF']
  })

  assert.deepEqual(gcodeThreeMf.map((file) => file.id), ['file-1'])
  assert.deepEqual(plainThreeMf.map((file) => file.id), ['file-3'])
})

test('filterLibraryFilesByMetadata treats multiple selected values within a facet as OR', () => {
  const eitherThreeMf = filterLibraryFilesByMetadata(files, {
    printerModels: [],
    nozzleSizes: [],
    plateTypes: [],
    fileTypes: ['3MF GCODE', '3MF']
  })

  assert.deepEqual(eitherThreeMf.map((file) => file.id), ['file-1', 'file-3'])
})

test('filterLibraryFilesByMetadata with all empty facets returns every file', () => {
  const all = filterLibraryFilesByMetadata(files, {
    printerModels: [],
    nozzleSizes: [],
    plateTypes: [],
    fileTypes: []
  })

  assert.deepEqual(all.map((file) => file.id), files.map((file) => file.id))
})

test('paginateLibraryEntries keeps folders before files across page boundaries', () => {
  const firstPage = paginateLibraryEntries(folders, files, 1, 4)
  const secondPage = paginateLibraryEntries(folders, files, 2, 4)

  assert.deepEqual(firstPage.folders.map((folder) => folder.id), ['folder-alpha', 'folder-beta', 'folder-gamma'])
  assert.deepEqual(firstPage.files.map((file) => file.id), ['file-1'])
  assert.deepEqual(secondPage.folders, [])
  assert.deepEqual(secondPage.files.map((file) => file.id), ['file-2', 'file-3'])
})
test('sortLibraryEntries orders files by name ascending regardless of upload order', () => {
  const sorted = sortLibraryEntries(folders, [...files].reverse(), { key: 'name', dir: 'asc' })

  assert.deepEqual(sorted.files.map((file) => file.id), ['file-1', 'file-3', 'file-2'])
  assert.deepEqual(sorted.folders.map((folder) => folder.id), ['folder-alpha', 'folder-beta', 'folder-gamma'])
})

test('sortLibraryEntries orders by most printed (descending)', () => {
  const sorted = sortLibraryEntries(folders, files, { key: 'mostPrinted', dir: 'desc' })
  assert.deepEqual(sorted.files.map((file) => file.id), ['file-1', 'file-3', 'file-2'])
})

test('sortLibraryEntries orders by last printed with never-printed files last in both directions', () => {
  const descending = sortLibraryEntries(folders, files, { key: 'lastPrinted', dir: 'desc' })
  assert.deepEqual(descending.files.map((file) => file.id), ['file-3', 'file-1', 'file-2'])

  const ascending = sortLibraryEntries(folders, files, { key: 'lastPrinted', dir: 'asc' })
  // file-2 has never been printed, so it stays last regardless of direction.
  assert.deepEqual(ascending.files.map((file) => file.id), ['file-1', 'file-3', 'file-2'])
})

test('sorting then paginating puts the first names on the first page', () => {
  // Regression: paginating the API's upload-date order and sorting only the
  // visible page made early alphabetical names start on page 2.
  const numbered: LibraryFile[] = ['03', '01', 'zz', '02'].map((name, index) => ({
    ...files[0]!,
    id: `file-${name}`,
    name: `${name}.stl`,
    uploadedAt: `2026-05-0${index + 1}T00:00:00.000Z`
  }))
  const sorted = sortLibraryEntries([], numbered, { key: 'name', dir: 'asc' })
  const firstPage = paginateLibraryEntries(sorted.folders, sorted.files, 1, 3)

  assert.deepEqual(firstPage.files.map((file) => file.name), ['01.stl', '02.stl', '03.stl'])
})

test('groupLibraryFiles returns a single group when grouping is off', () => {
  const groups = groupLibraryFiles(files, 'none')
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0]?.files.map((file) => file.id), ['file-1', 'file-2', 'file-3'])
})

test('groupLibraryFiles buckets by file type, ordered by label', () => {
  const groups = groupLibraryFiles(files, 'fileType')
  assert.deepEqual(groups.map((group) => `${group.label}:${group.files.length}`), ['3MF:1', '3MF GCODE:1', 'STL:1'])
})

test('groupLibraryFiles buckets by first letter A-Z', () => {
  const groups = groupLibraryFiles(files, 'letter')
  assert.deepEqual(groups.map((group) => group.label), ['A', 'G', 'P'])
})

test('groupLibraryFiles buckets by date added relative to now', () => {
  const now = Date.parse('2026-05-03T12:00:00.000Z')
  const groups = groupLibraryFiles(files, 'dateAdded', now)
  assert.deepEqual(groups.map((group) => `${group.label}:${group.files.length}`), ['Today:1', 'This week:2'])
})
