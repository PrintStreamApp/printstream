import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import type { JSDOM } from 'jsdom'
import { installJsdomGlobals } from '../test-utils/jsdom'

let dom: JSDOM
let createElement: typeof import('react').createElement
let render: typeof import('@testing-library/react').render
let cleanup: typeof import('@testing-library/react').cleanup
let FooterUnreadButton: typeof import('./FooterUnreadButton').FooterUnreadButton

before(async () => {
  dom = installJsdomGlobals()
  createElement = (await import('react')).createElement
  const testing = await import('@testing-library/react')
  render = testing.render
  cleanup = testing.cleanup
  FooterUnreadButton = (await import('./FooterUnreadButton')).FooterUnreadButton
})

afterEach(() => cleanup())
after(() => dom.window.close())

test('shows a numeric badge while keeping the action neutral and announcing the count', () => {
  const view = render(createElement(FooterUnreadButton, {
    children: 'Announcements', unreadCount: 3, tooltip: 'View announcements',
    ariaLabel: 'View announcements', onClick: () => undefined
  }))
  const button = view.getByRole('button', { name: 'View announcements, 3 unread' })
  assert.ok(button.className.includes('MuiButton-variantPlain'))
  assert.ok(button.className.includes('MuiButton-colorNeutral'))
  assert.ok(button.querySelector('.MuiButton-endDecorator')?.contains(view.getByText('3')))
  assert.equal(view.container.querySelector('.MuiBadge-root'), null)
})

test('a read action hides its zero badge without changing the button label', () => {
  const view = render(createElement(FooterUnreadButton, {
    children: 'Announcements', unreadCount: 0, tooltip: 'View announcements',
    ariaLabel: 'View announcements', onClick: () => undefined
  }))
  assert.ok(view.getByRole('button', { name: 'View announcements' }))
  assert.equal(view.container.querySelector('.MuiChip-root'), null)
})
