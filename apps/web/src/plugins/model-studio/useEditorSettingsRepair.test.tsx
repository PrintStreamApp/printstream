import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { useRef, useState } from 'react'
import type { ThreeMfSettingsRepairReason } from '@printstream/shared'
import type { SliceSettingsController } from '../../components/library/SliceSettingsPanel'
import type { FilamentConfigResolver } from '../../components/library/FilamentSettingsDialog'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import type { EditorState } from './lib/editorModel'
import type { EditorProjectSource } from './lib/editorProjectSource'

const dom = installJsdomGlobals()
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { useEditorSettingsRepair } = await import('./useEditorSettingsRepair')

afterEach(cleanup)
after(() => dom.window.close())

const controller = {
  projectFilaments: [{ projectFilamentId: 1 }, { projectFilamentId: 2 }],
  filamentMaterialOptionIds: { 1: 'pla-option', 2: 'petg-option' },
  materialOptions: [
    { id: 'pla-option', profileId: 'pla-preset' },
    { id: 'petg-option', profileId: 'petg-preset' }
  ],
  desiredFilaments: [{ sourceIndex: 1 }, { sourceIndex: 0 }],
  selectedSlicerTargetId: 'target-1'
} as unknown as SliceSettingsController

test('a partial physics miss keeps byte repairs staged; retry records only one physics checkpoint', async () => {
  const requests: Array<{ filamentProfileId: string; projectFilamentId: number | null }> = []
  let petgAvailable = false
  const resolver: FilamentConfigResolver = async (request) => {
    requests.push({ filamentProfileId: request.filamentProfileId, projectFilamentId: request.projectFilamentId })
    if (request.filamentProfileId === 'petg-preset' && !petgAvailable) throw new Error('Preset unavailable')
    return {
      config: { nozzle_temperature: [request.filamentProfileId === 'pla-preset' ? '220' : '245'] },
      presetInherits: request.filamentProfileId === 'petg-preset' ? 'Generic PETG' : undefined,
      presetChangedKeys: []
    } as never
  }
  const projectSource = {} as EditorProjectSource
  const reasons: ThreeMfSettingsRepairReason[] = ['flushMatrix', 'filamentPhysics']
  let checkpointCount = 0

  function useHarness(source: EditorProjectSource) {
    const [state, setState] = useState<EditorState | null>({ plates: [] })
    const stateRef = useRef(state)
    stateRef.current = state
    const sliceConfigRef = useRef<SliceSettingsController | undefined>(controller)
    const recordHistoryRef = useRef(() => { checkpointCount += 1 })
    const repair = useEditorSettingsRepair({
      state,
      setState,
      stateRef,
      sliceConfigRef,
      resolveFilamentConfig: resolver,
      baseFileId: 'file-1',
      projectSource: source,
      settingsRepairReasons: reasons,
      recordHistoryRef
    })
    return { ...repair, state }
  }

  const { result, rerender } = renderHook(({ source }) => useHarness(source), {
    initialProps: { source: projectSource }
  })

  await act(async () => { await result.current.handleRepairInEditor() })
  assert.equal(checkpointCount, 1)
  assert.equal(result.current.state?.settingsRepairStaged, true)
  assert.equal(result.current.state?.repairedFilamentConfigs, undefined)
  assert.match(result.current.physicsRepairError ?? '', /Material 2.*other repairs are staged/)
  assert.deepEqual(requests.map((request) => request.projectFilamentId), [2, 1])

  petgAvailable = true
  await act(async () => { await result.current.handleRepairInEditor() })
  assert.equal(checkpointCount, 2)
  assert.equal(result.current.physicsRepairError, null)
  assert.deepEqual(Object.keys(result.current.state?.repairedFilamentConfigs ?? {}), ['1', '2'])
  const pinned = result.current.state?.repairedFilamentConfigs as EditorState['repairedFilamentConfigs']
  assert.equal(pinned?.[2]?.inherits, 'Generic PETG')

  // The public editor keeps its component mounted when another local project is chosen.
  rerender({ source: {} as EditorProjectSource })
  assert.equal(result.current.state?.settingsRepairStaged, undefined)
  assert.equal(result.current.state?.repairedFilamentConfigs, undefined)
})

test('an in-flight material repair cannot pin a previous local project into the next one', async () => {
  let releaseResolution!: (value: { config: { nozzle_temperature: string[] } }) => void
  const pendingResolution = new Promise<{ config: { nozzle_temperature: string[] } }>((resolve) => {
    releaseResolution = resolve
  })
  const resolver: FilamentConfigResolver = async () => (await pendingResolution) as never
  const firstSource = {} as EditorProjectSource
  let checkpointCount = 0

  function useHarness(source: EditorProjectSource) {
    const [state, setState] = useState<EditorState | null>({ plates: [] })
    const stateRef = useRef(state)
    stateRef.current = state
    const sliceConfigRef = useRef<SliceSettingsController | undefined>({
      ...controller,
      projectFilaments: [controller.projectFilaments[0]],
      desiredFilaments: [controller.desiredFilaments![0]]
    } as SliceSettingsController)
    const recordHistoryRef = useRef(() => { checkpointCount += 1 })
    const repair = useEditorSettingsRepair({
      state,
      setState,
      stateRef,
      sliceConfigRef,
      resolveFilamentConfig: resolver,
      baseFileId: null,
      projectSource: source,
      settingsRepairReasons: ['filamentPhysics'],
      recordHistoryRef
    })
    return { ...repair, state }
  }

  const { result, rerender } = renderHook(({ source }) => useHarness(source), {
    initialProps: { source: firstSource }
  })
  let repair!: Promise<void>
  act(() => { repair = result.current.handleRepairInEditor() })
  assert.equal(result.current.repairingPhysics, true)

  rerender({ source: {} as EditorProjectSource })
  releaseResolution({ config: { nozzle_temperature: ['220'] } })
  await act(async () => { await repair })
  assert.equal(result.current.repairingPhysics, false)
  assert.equal(result.current.state?.repairedFilamentConfigs, undefined)
  assert.equal(result.current.physicsRepairError, null)
  assert.equal(checkpointCount, 0)
})
