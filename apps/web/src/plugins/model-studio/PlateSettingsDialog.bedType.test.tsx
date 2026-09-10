/**
 * The bed-type control's LABELS and its value matching.
 *
 * Both failures here are about the same underlying fact: a plate type reaches this dialog in two
 * spellings. The printer's option list may carry code-form tokens (`cool_plate`), while the bake
 * canonicalises what it writes (`canonicalCurrBedType`), so a plate reopened from a saved file
 * carries the serialized form (`Cool Plate`). Neither spelling is wrong; treating them as different
 * values is.
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
type Draft = DialogProps['settings']

const INHERITED: Draft = {
  plateTypeOverride: null,
  printSequence: null,
  spiralMode: null,
  locked: false
}

/** The list as the controller really supplies it: code-form and serialized forms mixed. */
const MIXED_OPTIONS = ['cool_plate', 'engineering_plate', 'High Temp Plate', 'textured_pei_plate']

async function renderDialog(options: {
  plateTypeOverride?: string | null
  plateTypeOptions?: string[]
  globalPlateType?: string | null
}) {
  await act(async () => {
    render(
      <CssVarsProvider>
        <PlateSettingsDialog
          plateLabel="Plate 1"
          settings={{ ...INHERITED, plateTypeOverride: options.plateTypeOverride ?? null }}
          plateTypeOptions={options.plateTypeOptions ?? MIXED_OPTIONS}
          globalPlateType={options.globalPlateType ?? 'High Temp Plate'}
          processContext={null}
          globalProcessOverrides={{}}
          onApply={() => {}}
          onClose={() => {}}
        />
      </CssVarsProvider>
    )
  })
}

/** What the closed Select displays, which is the label of whichever option its value matched. */
function shownBedType(): string {
  const button = screen.getAllByRole('combobox')[0]
  assert.ok(button, 'expected the bed type select')
  return button.textContent ?? ''
}

test('a code-form option is shown as a friendly label, not as its identifier', async () => {
  // The reported symptom: the list read `cool_plate` / `engineering_plate` / `textured_pei_plate`
  // beside a correctly-spelled `High Temp Plate`, because the options were rendered raw while the
  // project-global selector next door put the same list through `formatPlateTypeLabel`.
  await renderDialog({ plateTypeOverride: 'cool_plate' })
  assert.match(shownBedType(), /Cool Plate/)
  assert.doesNotMatch(shownBedType(), /cool_plate/, 'no raw identifier may reach the label')
})

test('the inherit option names the global in the same friendly form', async () => {
  await renderDialog({ plateTypeOverride: null, globalPlateType: 'textured_pei_plate' })
  assert.match(shownBedType(), /Same as global \(Textured PEI Plate\)/)
})

test('a SAVED override matches its option despite the spelling differing', async () => {
  // The round trip: picking `cool_plate` saves `Cool Plate` (the bake canonicalises), and on reopen
  // that value matches no option by string equality. A Joy Select whose value is in no option
  // renders BLANK, so the plate looked as though it had lost its bed type.
  await renderDialog({ plateTypeOverride: 'Cool Plate' })
  assert.match(shownBedType(), /Cool Plate/)
  assert.doesNotMatch(shownBedType(), /Same as global/, 'a set override must not read as inheriting')
})

test('an override the printer does not offer is still shown rather than dropped', async () => {
  // Re-targeting to a printer without that sheet must not silently claim the plate inherits (a lie)
  // or render blank (hiding an override the file carries).
  await renderDialog({ plateTypeOverride: 'Supertack Plate', plateTypeOptions: ['cool_plate'] })
  assert.match(shownBedType(), /Supertack Plate/)
  assert.doesNotMatch(shownBedType(), /Same as global/)
})

test('an inheriting plate reads as "Same as global"', async () => {
  await renderDialog({ plateTypeOverride: null })
  assert.match(shownBedType(), /Same as global/)
})
