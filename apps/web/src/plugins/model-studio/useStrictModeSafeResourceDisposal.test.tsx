import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()
const React = (await import('react')).default
const { cleanup, render } = await import('@testing-library/react')
const { useStrictModeSafeResourceDisposal } = await import('./useStrictModeSafeResourceDisposal')

afterEach(() => { cleanup() })
after(() => { dom.window.close() })

interface Resource { disposed: number }

function Harness({ resource }: { resource: Resource }) {
  useStrictModeSafeResourceDisposal(resource, true, (current) => { current.disposed += 1 })
  return null
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0))

test('ignores the StrictMode cleanup probe but disposes replacements and real unmounts', async () => {
  const first = { disposed: 0 }
  const second = { disposed: 0 }
  const view = render(React.createElement(React.StrictMode, null, React.createElement(Harness, { resource: first })))

  await nextTask()
  assert.equal(first.disposed, 0, 'the development cleanup probe must not abort a live resource')

  view.rerender(React.createElement(React.StrictMode, null, React.createElement(Harness, { resource: second })))
  await nextTask()
  assert.equal(first.disposed, 1, 'a replaced resource is released')
  assert.equal(second.disposed, 0)

  view.unmount()
  await nextTask()
  assert.equal(second.disposed, 1, 'a real unmount releases the active resource')
})
