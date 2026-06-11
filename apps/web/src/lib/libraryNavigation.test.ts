import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildLibraryBreadcrumb, buildLibraryFolderRoute, toBridgeFolderId } from './libraryNavigation.js'

test('buildLibraryFolderRoute keeps library navigation inside the active workspace', () => {
  assert.equal(buildLibraryFolderRoute('Default', null, null), '/workspaces/default/library')
  assert.equal(buildLibraryFolderRoute('default', 'folder 1', null), '/workspaces/default/library/folder%201')
  assert.equal(
    buildLibraryFolderRoute('default', 'folder 1', 'bridge/main'),
    '/workspaces/default/library/folder%201?bridge=bridge%2Fmain'
  )
})

test('buildLibraryBreadcrumb collapses to the sole bridge when root is hidden', () => {
  assert.deepEqual(
    buildLibraryBreadcrumb([], null, 'bridge-1', 'Bridge One', { showRoot: false }),
    [
      {
        id: toBridgeFolderId('bridge-1'),
        name: 'Bridge One',
        navigable: true,
        dropTarget: 'bridge-root'
      }
    ]
  )
})

test('buildLibraryBreadcrumb keeps a read-only Root crumb when root is shown', () => {
  assert.deepEqual(
    buildLibraryBreadcrumb([], null, 'bridge-1', 'Bridge One', { showRoot: true }),
    [
      {
        id: null,
        name: 'Root',
        navigable: true,
        dropTarget: 'none'
      },
      {
        id: toBridgeFolderId('bridge-1'),
        name: 'Bridge One',
        navigable: true,
        dropTarget: 'bridge-root'
      }
    ]
  )
})

test('buildLibraryBreadcrumb can render a non-navigable root crumb for bridge-scoped dialogs', () => {
  assert.deepEqual(
    buildLibraryBreadcrumb([], null, 'bridge-1', 'Bridge One', { showRoot: true, rootNavigable: false }),
    [
      {
        id: null,
        name: 'Root',
        navigable: false,
        dropTarget: 'none'
      },
      {
        id: toBridgeFolderId('bridge-1'),
        name: 'Bridge One',
        navigable: true,
        dropTarget: 'bridge-root'
      }
    ]
  )
})

test('buildLibraryBreadcrumb keeps folder crumbs droppable beneath the bridge crumb', () => {
  assert.deepEqual(
    buildLibraryBreadcrumb([
      { id: 'folder-1', name: 'Models', parentId: null },
      { id: 'folder-2', name: 'Plate A', parentId: 'folder-1' }
    ], 'folder-2', 'bridge-1', 'Bridge One', { showRoot: false }),
    [
      {
        id: toBridgeFolderId('bridge-1'),
        name: 'Bridge One',
        navigable: true,
        dropTarget: 'bridge-root'
      },
      {
        id: 'folder-1',
        name: 'Models',
        navigable: true,
        dropTarget: 'folder'
      },
      {
        id: 'folder-2',
        name: 'Plate A',
        navigable: true,
        dropTarget: 'folder'
      }
    ]
  )
})