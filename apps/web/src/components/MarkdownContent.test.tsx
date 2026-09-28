import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { installJsdomGlobals } from '../test-utils/jsdom'

const dom = installJsdomGlobals()
const React = (await import('react')).default
const { fireEvent, render, cleanup } = await import('@testing-library/react')
const { default: MarkdownContent } = await import('./MarkdownContent')

after(() => {
  cleanup()
  dom.window.close()
})

test('a support attachment image opens with its resolved URL', () => {
  const opened: string[] = []
  const view = render(
    <MarkdownContent
      resolveUri={(uri) => uri === 'attachment:shot-1' ? '/api/support/attachments/shot-1' : null}
      onImageClick={(src) => opened.push(src)}
    >
      {'![Screen capture](attachment:shot-1)'}
    </MarkdownContent>
  )

  fireEvent.click(view.getByRole('button', { name: 'View Screen capture' }))
  assert.deepEqual(opened, ['/api/support/attachments/shot-1'])
})
