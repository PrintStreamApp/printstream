import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  addTemplateDraftItemPlate,
  createEmptyTemplateDraftItem,
  flattenTemplateDraftItems,
  getTemplateDraftItemTotalQuantity,
  groupTemplateItems,
  renameTemplateDraftItemPlate,
  setTemplateDraftItemPlateQuantity
} from './templateDraft.js'

test('groupTemplateItems combines template rows from the same file and notes into per-plate quantities', () => {
  const grouped = groupTemplateItems([
    {
      id: 'a',
      libraryFileId: 'file-1',
      libraryFileName: 'alpha.gcode.3mf',
      plate: 1,
      quantity: 2,
      notes: 'Front panel',
      position: 0,
      fileAvailable: true
    },
    {
      id: 'b',
      libraryFileId: 'file-1',
      libraryFileName: 'alpha.gcode.3mf',
      plate: 3,
      quantity: 1,
      notes: 'Front panel',
      position: 1,
      fileAvailable: true
    },
    {
      id: 'c',
      libraryFileId: 'file-1',
      libraryFileName: 'alpha.gcode.3mf',
      plate: 1,
      quantity: 4,
      notes: 'Front panel',
      position: 2,
      fileAvailable: true
    },
    {
      id: 'd',
      libraryFileId: 'file-1',
      libraryFileName: 'alpha.gcode.3mf',
      plate: 2,
      quantity: 1,
      notes: 'Back panel',
      position: 3,
      fileAvailable: true
    }
  ])

  // Each grouped item carries a stable client id (used as the React list key);
  // assert it exists, then compare the rest.
  assert.equal(grouped.every((item) => typeof item.id === 'string' && item.id.length > 0), true)
  assert.deepEqual(grouped.map(({ id: _id, ...rest }) => rest), [
    {
      libraryFileId: 'file-1',
      libraryFileName: 'alpha.gcode.3mf',
      notes: 'Front panel',
      plateQuantities: [
        { plate: 1, quantity: 6 },
        { plate: 3, quantity: 1 }
      ]
    },
    {
      libraryFileId: 'file-1',
      libraryFileName: 'alpha.gcode.3mf',
      notes: 'Back panel',
      plateQuantities: [{ plate: 2, quantity: 1 }]
    }
  ])
})

test('flattenTemplateDraftItems drops zero quantities and preserves shared notes per file group', () => {
  const flattened = flattenTemplateDraftItems([
    {
      id: 'item-1',
      libraryFileId: 'file-1',
      libraryFileName: 'alpha.gcode.3mf',
      notes: 'Front panel',
      plateQuantities: [
        { plate: 1, quantity: 3 },
        { plate: 2, quantity: 0 },
        { plate: 4, quantity: 1 }
      ]
    }
  ])

  assert.deepEqual(flattened, [
    {
      libraryFileId: 'file-1',
      plate: 1,
      quantity: 3,
      notes: 'Front panel'
    },
    {
      libraryFileId: 'file-1',
      plate: 4,
      quantity: 1,
      notes: 'Front panel'
    }
  ])
})

test('manual plate helpers keep the grouped draft consistent', () => {
  const initial = createEmptyTemplateDraftItem()
  const withAnotherPlate = addTemplateDraftItemPlate(initial)
  const updated = setTemplateDraftItemPlateQuantity(withAnotherPlate, 2, 5)
  const renamed = renameTemplateDraftItemPlate(updated, 2, 4)

  assert.deepEqual(renamed.plateQuantities, [
    { plate: 1, quantity: 1 },
    { plate: 4, quantity: 5 }
  ])
  assert.equal(getTemplateDraftItemTotalQuantity(renamed), 6)
})