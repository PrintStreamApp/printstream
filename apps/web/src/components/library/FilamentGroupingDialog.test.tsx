import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()
const animationFrameWindow = dom.window as unknown as {
  requestAnimationFrame: (callback: () => void) => number
  cancelAnimationFrame: (handle: number) => void
}
animationFrameWindow.requestAnimationFrame = (callback) => dom.window.setTimeout(callback, 0) as unknown as number
animationFrameWindow.cancelAnimationFrame = (handle) => dom.window.clearTimeout(handle)

afterEach(async () => {
  const { cleanup } = await import('@testing-library/react')
  cleanup()
})

after(() => dom.window.close())

test('automatic grouping applies only profile-printable nozzle assignments', async () => {
  const React = (await import('react')).default
  const { CssVarsProvider } = await import('@mui/joy/styles')
  const { fireEvent, render, waitFor } = await import('@testing-library/react')
  const { FilamentGroupingDialog } = await import('./FilamentGroupingDialog')

  const applied: Array<Record<number, string>> = []
  const view = render(React.createElement(CssVarsProvider, null, React.createElement(FilamentGroupingDialog, {
    open: true,
    filaments: [
      { id: 1, projectFilamentId: 1, label: 'Material 1: PLA', color: '#fff', profileId: 'one', loadedToolheadId: null, supportOnly: false, overrides: {} },
      { id: 2, projectFilamentId: 2, label: 'Material 2: PETG', color: '#000', profileId: 'two', loadedToolheadId: null, supportOnly: false, overrides: {} }
    ],
    toolheads: [
      { id: 'nozzle-1', label: 'Left nozzle', printableBitIndex: 0, nozzleFlow: 'standard', extruderType: 'direct', preferSupport: false },
      { id: 'nozzle-0', label: 'Right nozzle', printableBitIndex: 1, nozzleFlow: 'standard', extruderType: 'direct', preferSupport: false }
    ],
    initialAssignments: { 1: 'nozzle-0', 2: 'nozzle-1' },
    flushVolumes: [[0, 100], [100, 0]],
    slicerTargetId: 'target',
    sourceFileId: 'file',
    resolveConfig: async ({ filamentProfileId }) => ({
      config: { filament_printable: filamentProfileId === 'one' ? '1' : '2', filament_extruder_variant: ['Direct Drive Standard'] },
      baseConfig: {},
      overriddenKeys: []
    }),
    qualityAvailable: false,
    matchAvailable: false,
    dynamicMapping: false,
    onClose: () => {},
    onApply: (assignments: Record<number, string>) => applied.push(assignments)
  })))

  await waitFor(() => assert.ok(view.getByText('All valid groupings checked.')))
  fireEvent.click(view.getByRole('button', { name: 'Apply' }))
  assert.deepEqual(applied, [{ 1: 'nozzle-1', 2: 'nozzle-0' }])
})
