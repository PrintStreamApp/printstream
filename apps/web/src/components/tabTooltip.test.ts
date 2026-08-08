/**
 * The tab tooltip rule, which two rows of the shell share.
 *
 * Both cases have been wrong at some point: every tab once carried a tooltip
 * that just repeated the label under the pointer, and the fix for that briefly
 * left the icon-only tabs — the ones with no visible text at all — as the only
 * tabs a tooltip would have helped.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { tabTooltip } from './tabTooltip'

test('an icon-only tab is named, because nothing else names it', () => {
  assert.equal(tabTooltip({ label: 'Settings', iconOnly: true }), 'Settings')
  assert.equal(
    tabTooltip({ label: 'Workspaces', ariaLabel: 'Switch context', iconOnly: true }),
    'Switch context'
  )
})

test('a readable tab shows its description, never its own label back', () => {
  assert.equal(
    tabTooltip({ label: 'Printers', description: 'Live status for every printer.' }),
    'Live status for every printer.'
  )
})

test('a readable tab with nothing to add gets no tooltip', () => {
  assert.equal(tabTooltip({ label: 'Jobs' }), '')
})

test('a tab the ROW has collapsed to an icon is named, like an icon-only one', () => {
  // The tab is unchanged -- only the row it sits in ran out of width. Without
  // this the density ladder would hide the labels and leave the descriptions
  // describing something the reader can no longer see the name of.
  assert.equal(
    tabTooltip({ label: 'Customers', description: 'Everyone paying for something.' }, { labelHidden: true }),
    'Customers. Everyone paying for something.'
  )
  assert.equal(tabTooltip({ label: 'Overview' }, { labelHidden: true }), 'Overview')
})

test('a described icon-only tab says both, since it has room to', () => {
  assert.equal(
    tabTooltip({ label: 'Messages', description: 'Your conversations with us.', iconOnly: true }),
    'Messages. Your conversations with us.'
  )
})
