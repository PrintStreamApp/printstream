import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LibraryFile, LibraryFolder } from '@printstream/shared'
import { filterLibraryEntries, filterLibraryFilesByMetadata, paginateLibraryEntries, sortLibraryEntries } from './libraryDirectory'

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
    projectFilamentChips: []
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
    projectFilamentChips: []
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
    projectFilamentChips: []
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
    printerModel: '__all__',
    nozzleSize: '__all__',
    plateType: '__all__',
    fileType: '3MF GCODE'
  })
  const plainThreeMf = filterLibraryFilesByMetadata(files, {
    printerModel: '__all__',
    nozzleSize: '__all__',
    plateType: '__all__',
    fileType: '3MF'
  })

  assert.deepEqual(gcodeThreeMf.map((file) => file.id), ['file-1'])
  assert.deepEqual(plainThreeMf.map((file) => file.id), ['file-3'])
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
