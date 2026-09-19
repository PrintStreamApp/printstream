/* PageSectionHeading DOM-validity test.
 *
 * The count badge sits in the title Typography's `endDecorator`, and Typography
 * renders as a `<p>` at every level this component takes. Joy's Chip defaults to
 * a `<div>` root, so the badge used to nest a block element inside a paragraph:
 * React logged a validateDOMNesting error on every page with a non-zero section
 * count, and the HTML parser is entitled to close the paragraph early and
 * reparent the chip. Asserting on the rendered TAGS rather than on the absence of
 * a console warning keeps this honest: the warning is dev-only and deduped, so a
 * console spy would pass for the wrong reason once another test tripped it first.
 *
 * The `icon` prop takes a plain span here on purpose: under the node runner's CJS
 * interop an @mui/icons-material icon's `default` is itself `{ default: fn }`, so
 * rendering one fails with "Element type is invalid" and blames this component.
 */
import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals({ url: 'http://localhost/' })

const { CssVarsProvider } = await import('@mui/joy/styles')
const { cleanup, render } = await import('@testing-library/react')
const React = (await import('react')).default
const { PageSectionHeading } = await import('./PageSectionHeading')

afterEach(() => {
  cleanup()
})

after(() => {
  dom.window.close()
})

function renderHeading(props: { count?: number | null; description?: string; helpText?: string }) {
  return render(
    <CssVarsProvider>
      <PageSectionHeading
        icon={<span data-testid="icon" />}
        title="Print history"
        {...props}
      />
    </CssVarsProvider>
  )
}

/** Every `<p>` that contains a block-level descendant: the invalid-nesting set. */
function paragraphsContainingDivs(container: HTMLElement): string[] {
  return [...container.querySelectorAll('p')]
    .filter((paragraph) => paragraph.querySelector('div') != null)
    .map((paragraph) => paragraph.textContent ?? '')
}

test('the count badge does not nest a block element inside the title paragraph', () => {
  const view = renderHeading({ count: 8 })
  assert.equal(view.getByText('8').tagName, 'SPAN')
  assert.deepEqual(paragraphsContainingDivs(view.container), [])
})

test('a section with a description and a count stays valid', () => {
  const view = renderHeading({ count: 3, description: 'Finished prints on this printer.' })
  assert.deepEqual(paragraphsContainingDivs(view.container), [])
})

test('the count is hidden at zero and when absent', () => {
  const zero = renderHeading({ count: 0 })
  assert.equal(zero.queryByText('0'), null)
  cleanup()

  const absent = renderHeading({})
  assert.deepEqual(paragraphsContainingDivs(absent.container), [])
})

test('optional detail uses a labelled help affordance instead of visible subtext', () => {
  const view = renderHeading({ helpText: 'More detail about this section.' })

  assert.ok(view.getByRole('button', { name: 'About Print history' }))
  assert.equal(view.queryByText('More detail about this section.'), null)
})
