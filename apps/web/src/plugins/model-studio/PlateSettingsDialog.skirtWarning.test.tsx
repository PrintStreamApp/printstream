/**
 * The skirt-collision warning's WIRING, as opposed to its rule.
 *
 * `plate-skirt-collision.test.ts` pins the rule itself. What only a render can catch is the three
 * things the dialog does around it, each of which fails by showing nothing at all: it must test the
 * LIVE draft rather than the saved settings, it must layer the session's project-wide overrides
 * over the resolved preset (a `print_sequence` or `skirt_height` changed this session is exactly
 * when the warning matters), and it must stay silent when the config will not resolve rather than
 * guessing.
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

/** A multi-layer skirt: the half of the condition that is about the skirt. */
const RISKY_SKIRT = { skirt_height: '3', skirt_loops: '2' }

const WARNING = /extruder hit the skirt/i

/**
 * Render the dialog and let the resolve effect settle.
 *
 * `resolveConfig` stands in for the workspace route. It is declared OUTSIDE the render so its
 * identity is stable, which the resolve hook requires of that prop.
 */
async function renderDialog(options: {
  settings?: Partial<Draft>
  presetConfig?: Record<string, string | string[]>
  globalProcessOverrides?: Record<string, string | string[]>
  plateTypeOptions?: string[]
  globalPlateType?: string
  resolveRejects?: boolean
}) {
  // Cast once: the real resolver returns the whole `ResolveProcessConfigResponse`, and the dialog
  // reads only `config`, so a full fixture would be noise that hides which field matters.
  const resolveConfig = (options.resolveRejects
    ? () => Promise.reject(new Error('no preset'))
    : () => Promise.resolve({ config: options.presetConfig ?? {} })) as unknown as NonNullable<DialogProps['processContext']>['resolveConfig']
  await act(async () => {
    render(
      <CssVarsProvider>
        <PlateSettingsDialog
          plateLabel="Plate 1"
          settings={{ ...INHERITED, ...options.settings }}
          plateTypeOptions={options.plateTypeOptions ?? ['Cool Plate']}
          globalPlateType={options.globalPlateType ?? 'Cool Plate'}
          processContext={{
            slicerTargetId: 'target-1',
            processProfileId: 'builtin:process:x',
            sourceFileId: null,
            resolveConfig
          }}
          globalProcessOverrides={options.globalProcessOverrides ?? {}}
          onApply={() => {}}
          onClose={() => {}}
        />
      </CssVarsProvider>
    )
  })
}

test('a by-object plate over a multi-layer skirt warns', () => renderDialog({
  settings: { printSequence: 'by object' },
  presetConfig: RISKY_SKIRT
}).then(() => {
  assert.ok(screen.queryByText(WARNING), 'expected the collision warning')
}))

test('a plate INHERITING a by-object project warns', () => renderDialog({
  // The plate says nothing; the project prints by object. Reading only the plate's own value would
  // miss this, and it is the commonest shape, since a plate inherits by default.
  settings: { printSequence: null },
  presetConfig: { ...RISKY_SKIRT, print_sequence: 'by object' }
}).then(() => {
  assert.ok(screen.queryByText(WARNING), 'expected the warning for an inherited by-object sequence')
}))

test('a sequence set as a SESSION override is seen, not just the preset', () => renderDialog({
  // The preset prints by layer; the user switched the project to by object this session. The
  // override has to be layered over the resolved preset or the warning never appears for what is
  // the most likely way to get into this state.
  settings: { printSequence: null },
  presetConfig: { ...RISKY_SKIRT, print_sequence: 'by layer' },
  globalProcessOverrides: { print_sequence: 'by object' }
}).then(() => {
  assert.ok(screen.queryByText(WARNING), 'a session override must beat the resolved preset')
}))

test('a by-layer plate over a by-object project does not warn', () => renderDialog({
  settings: { printSequence: 'by layer' },
  presetConfig: { ...RISKY_SKIRT, print_sequence: 'by object' }
}).then(() => {
  assert.equal(screen.queryByText(WARNING), null, 'the plate override wins in both directions')
}))

test('a single-layer skirt does not warn', () => renderDialog({
  settings: { printSequence: 'by object' },
  presetConfig: { skirt_height: '1', skirt_loops: '2' }
}).then(() => {
  assert.equal(screen.queryByText(WARNING), null)
}))

test('the inherit option names the global value for every control', () => renderDialog({
  // Bed type named its global from the start and the other two did not, so "Same as global" told
  // the user what they were inheriting on one row and gave them no way to find out on the others.
  presetConfig: { print_sequence: 'by object', spiral_mode: '1' }
}).then(() => {
  const shown = document.body.textContent ?? ''
  assert.match(shown, /Same as global \(By object\)/, 'print sequence names the project value')
  assert.match(shown, /Same as global \(On\)/, 'spiral vase names the project value')
}))

test('a session override is what the inherit option names, not the preset', () => renderDialog({
  // The label must describe what the plate ACTUALLY inherits, which is the resolved preset with the
  // session's project-wide overrides over it, exactly as the skirt warning reads it.
  presetConfig: { print_sequence: 'by layer' },
  globalProcessOverrides: { print_sequence: 'by object' }
}).then(() => {
  assert.match(document.body.textContent ?? '', /Same as global \(By object\)/)
}))

test('an unresolved config leaves the inherit option unqualified', () => renderDialog({
  // Unknown is never stated as fact: naming a value we have not read would claim the plate inherits
  // something it may not. The row falls back to a bare "Same as global".
  resolveRejects: true
}).then(() => {
  const shown = document.body.textContent ?? ''
  assert.match(shown, /Same as global/)
  assert.doesNotMatch(shown, /Same as global \(By /, 'no print sequence may be named')
}))

test('a config that will not resolve warns about nothing', () => renderDialog({
  // Unknown is never a warning. The process tab still raises (and fixes) the same condition, so
  // silence here loses nothing; a guessed warning on a dialog that cannot see the values would.
  settings: { printSequence: 'by object' },
  resolveRejects: true
}).then(() => {
  assert.equal(screen.queryByText(WARNING), null)
}))
