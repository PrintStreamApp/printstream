import assert from 'node:assert/strict'
import { test } from 'node:test'
import { libraryTagWhere, parseLibraryTagIds } from './library-tag-filters.js'

test('tag facets and text search compose as independent database predicates', () => {
  const where = libraryTagWhere('w1', 'Workshop', ['t1', 't2'])
  assert.deepEqual(where.AND, ['t1', 't2'].map((id) => ({ tags: { some: { entityKind: 'file', workspaceId: 'w1', id } } })))
  assert.equal(where.OR?.length, 2)
  assert.deepEqual(where.OR?.[1], { tags: { some: { entityKind: 'file', workspaceId: 'w1', OR: [{ name: { contains: 'Workshop', mode: 'insensitive' } }, { group: { contains: 'Workshop', mode: 'insensitive' } }] } } })
  assert.deepEqual(libraryTagWhere('w1', '', []), {})
})

test('browse tag IDs are bounded, deduplicated, and reject malformed query values', () => {
  assert.deepEqual(parseLibraryTagIds('a,b,a'), ['a', 'b'])
  assert.deepEqual(parseLibraryTagIds(undefined), [])
  assert.throws(() => parseLibraryTagIds(['a']), /Invalid/)
  assert.throws(() => parseLibraryTagIds('a,,b'), /Invalid/)
  assert.throws(() => parseLibraryTagIds(Array(101).fill('a').join(',')), /Invalid/)
})
