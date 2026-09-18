import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareTags, matchesTagFilter, tagAssignmentInputSchema, tagInputSchema, tagSearchText } from './tags.js'

test('tag facet requires ALL tags and includes untagged items only when no tags are selected', () => {
  assert.equal(matchesTagFilter([], []), true)
  assert.equal(matchesTagFilter([], ['a']), false)
  assert.equal(matchesTagFilter(['a'], ['a', 'b']), false)
  assert.equal(matchesTagFilter(['a', 'b'], ['a', 'b']), true)
  assert.equal(matchesTagFilter(['c'], ['a', 'b']), false)
})

test('tag input trims names, rejects empty labels and unsafe colors', () => {
  assert.equal(tagInputSchema.parse({ name: ' Workshop ', color: '#123456' }).name, 'Workshop')
  assert.equal(tagInputSchema.safeParse({ name: ' ', color: '#123456' }).success, false)
  assert.equal(tagInputSchema.safeParse({ name: 'Tag', color: 'url(example)' }).success, false)
  assert.equal(tagAssignmentInputSchema.safeParse({ entityIds: [], add: ['a'] }).success, false)
  assert.equal(tagAssignmentInputSchema.safeParse({ entityIds: ['p'], add: ['a'], remove: ['a'] }).success, false)
})

test('tag search includes group labels but never opaque IDs', () => {
  assert.equal(tagSearchText([{ id: 'secret-id', name: 'Workshop', color: '#123456', group: 'Location' }]), 'Workshop Location')
})


test('tag ordering naturally compares group then name', () => {
  const tags = [['Group 10', 'Tag 1'], ['Group 2', 'Tag 10'], ['group 2', 'Tag 2']].map(([group, name], id) => ({ id: String(id), group, name, color: '#123456' }))
  assert.deepEqual([...tags].sort(compareTags).map(({ id }) => id), ['2', '1', '0'])
  assert.deepEqual(tags.map(({ id }) => id), ['0', '1', '2'])
})
