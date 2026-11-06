/**
 * The linked-copy warning's WIRING in the plate dialog: the host's assessment is asked about the
 * plate's EFFECTIVE sequence (the draft's own pick, else the resolved project value with the
 * session's overrides), and whatever it returns is shown. The rule itself is pinned in
 * `by-object-linked-copies.test.ts` and `lib/editorByObjectLinkedCopies.test.ts`.
 */
import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()

const React = (await import('react')).default
const { CssVarsProvider } = await import('@mui/joy/styles')
const { act, cleanup, render, screen } = await import('@testing-library/react')
const { PlateSettingsDialog } = await import('./PlateSettingsDialog')

afterEach(() => cleanup())
after(() => dom.window.close())

type DialogProps = Parameters<typeof PlateSettingsDialog>[0]

const MESSAGE = 'Gutter: its 2 linked copies will print together layer by layer.'

/** Render with an assessment that warns only under "by object", recording what it was asked. */
async function renderDialog(options: {
  printSequence: 'by layer' | 'by object' | null
  presetConfig?: Record<string, string>
  globalProcessOverrides?: Record<string, string>
}) {
  const asked: Array<string | null> = []
  const resolveConfig = (() => Promise.resolve({ config: options.presetConfig ?? {} })) as unknown as NonNullable<DialogProps['processContext']>['resolveConfig']

  await act(async () => {
    render(
      <CssVarsProvider>
        <PlateSettingsDialog
          plateLabel="Plate 1"
          settings={{ plateTypeOverride: null, printSequence: options.printSequence, firstLayerFilamentSequence: null, otherLayerFilamentSequences: null, spiralMode: null, locked: false }}
          plateTypeOptions={['Cool Plate']}
          globalPlateType="Cool Plate"
          processContext={{ slicerTargetId: 'target-1', processProfileId: 'builtin:process:x', sourceFileId: null, resolveConfig }}
          globalProcessOverrides={options.globalProcessOverrides ?? {}}
          filaments={[]}
          hasMixedFilaments={false}
          linkedCopyWarnings={(sequence) => {
            asked.push(sequence)
            return sequence === 'by object' ? [MESSAGE] : []
          }}
          onApply={() => {}}
          onClose={() => {}}
        />
      </CssVarsProvider>
    )
  })

  return { asked }
}

test('a by-object plate shows the host assessment', async () => {
  await renderDialog({ printSequence: 'by object' })
  assert.ok(screen.queryByText(MESSAGE))
})

test('a plate inheriting a by-object session override is asked about "by object"', async () => {
  const { asked } = await renderDialog({ printSequence: null, presetConfig: { print_sequence: 'by layer' }, globalProcessOverrides: { print_sequence: 'by object' } })
  assert.equal(asked.at(-1), 'by object')
  assert.ok(screen.queryByText(MESSAGE))
})

test('a by-layer plate over a by-object project shows nothing', async () => {
  const { asked } = await renderDialog({ printSequence: 'by layer', presetConfig: { print_sequence: 'by object' } })
  assert.equal(asked.at(-1), 'by layer')
  assert.equal(screen.queryByText(MESSAGE), null)
})
