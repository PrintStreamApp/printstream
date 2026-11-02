/**
 * Resolve a destination before committing a process switch, then transfer/discard the current
 * leaf diff or cancel. The loaded source survives engine changes. Missing source data disables
 * Keep, never Discard; late responses cannot mutate edits, undo state or a dismissed dialog.
 */
import { useEffect, useRef, useState } from 'react'
import { Button, Typography } from '@mui/joy'
import {
  applyProcessConfigDefaults,
  diffProcessConfig,
  type ProcessConfig,
  type ProcessSettingOverrides,
  type ResolveProcessConfigResponse,
  type SlicingPresetSummary
} from '@printstream/shared'
import { deriveProjectCarryOverrides } from '../../lib/processCarryOverrides'
import type { ProcessConfigResolver } from '../ProcessSettingsDialog'
import { resolveWorkspaceProcessConfig } from '../workspaceProcessResolver'
import { FormDialog } from '../FormDialog'
import { SlicingPresetAutocomplete } from './SlicingPresetAutocomplete'

type PendingSwitch = {
  id: string
  name: string
  overrides: ProcessSettingOverrides | null
  unknownBaseline: boolean
}

export function ProcessPresetPicker(props: {
  profiles: SlicingPresetSummary[]
  value: SlicingPresetSummary | null
  currentProfileId?: string
  targetId: string | null
  sourceFileId?: string | null
  overrides: ProcessSettingOverrides
  effectiveConfig?: ProcessConfig
  modified?: boolean
  disabled?: boolean
  resolveConfig?: ProcessConfigResolver
  onChange: (profileId: string, overrides: ProcessSettingOverrides) => void
}) {
  const sourceId = props.currentProfileId ?? props.value?.id
  const resolve: ProcessConfigResolver = props.resolveConfig ?? resolveWorkspaceProcessConfig
  const sourceFileId = props.sourceFileId ?? null
  const [pending, setPending] = useState<PendingSwitch | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const loadedSource = useRef<{
    id: string
    fileId: string | null
    targetId: string | null
    resolver: ProcessConfigResolver
    response: ResolveProcessConfigResponse
  } | null>(null)
  const scope = JSON.stringify([sourceId, props.targetId, sourceFileId, props.overrides, props.effectiveConfig])
  const scopeRef = useRef(scope)
  scopeRef.current = scope

  useEffect(() => {
    ++generation.current
    setPending(null)
    setBusy(false)
    // This is a request counter, not a DOM ref. Cleanup invalidates the latest pending request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { ++generation.current }
  }, [scope, resolve])

  // Load the source while its engine is available, without changing selection, dirty state or
  // history. The session resolver also retains it when this picker unmounts to open a dialog.
  useEffect(() => {
    if (!sourceId) return
    let active = true
    const request = { processProfileId: sourceId, targetId: props.targetId, sourceFileId }
    const warm = async () => {
      try {
        const response = await (resolve.resolveSource ?? resolve)(request)
        if (active) loadedSource.current = { id: sourceId, fileId: sourceFileId, targetId: props.targetId, resolver: resolve, response }
      } catch {
        // A missing source is recoverable through explicit Discard. Selection shows that choice;
        // this background warm-up must not block the editor or repeatedly report an idle failure.
      }
    }
    void warm()
    return () => { active = false }
  }, [sourceId, sourceFileId, props.targetId, resolve])

  /** Read the loaded source independently of destination availability, falling back to draft data. */
  const readSource = async (): Promise<ResolveProcessConfigResponse | null> => {
    if (!sourceId) return null
    // The containing dialog can finish activating its displayed engine after this picker's
    // warm-up. Prefer the session's active descriptor over that earlier local snapshot.
    const active = resolve.peekSource?.(sourceId)
    if (active) return active
    const saved = loadedSource.current
    if (saved?.id === sourceId && saved.fileId === sourceFileId && saved.targetId === props.targetId && saved.resolver === resolve) {
      return saved.response
    }
    try {
      return await (resolve.resolveSource ?? resolve)({ processProfileId: sourceId, targetId: props.targetId, sourceFileId })
    } catch {
      if (!props.effectiveConfig) return null
      return {
        config: props.effectiveConfig,
        baseConfig: props.effectiveConfig,
        baselineResolved: false,
        overriddenKeys: []
      }
    }
  }

  const select = async (profile: SlicingPresetSummary | null) => {
    if (!profile || profile.id === sourceId) return
    const requestGeneration = ++generation.current
    const requestScope = scope
    const isCurrent = () => generation.current === requestGeneration && scopeRef.current === requestScope
    setBusy(true)
    setError(null)
    setPending(null)
    try {
      const [source, destination] = await Promise.all([
        readSource(),
        resolve({ processProfileId: profile.id, targetId: props.targetId, sourceFileId })
      ])
      if (!isCurrent()) return
      if (destination.baselineOrigin?.kind === 'partial') {
        throw new Error('The selected preset parent is unavailable. Resolve it before switching presets.')
      }
      if (sourceId && !source) {
        setPending({ id: profile.id, name: profile.name, overrides: null, unknownBaseline: true })
        return
      }
      const changes = deriveProjectCarryOverrides(source, props.effectiveConfig ?? props.overrides)
      const effective = applyProcessConfigDefaults(destination.config)
      const overrides = diffProcessConfig(effective, { ...effective, ...changes })
      if (Object.keys(changes).length > 0) {
        setPending({ id: profile.id, name: profile.name, overrides, unknownBaseline: source?.baselineResolved === false })
      } else {
        props.onChange(profile.id, overrides)
      }
    } catch (err) {
      if (isCurrent()) setError(err instanceof Error ? err.message : 'Could not resolve the process preset')
    } finally {
      if (isCurrent()) setBusy(false)
    }
  }

  const commit = (keep: boolean) => {
    if (!pending || (keep && !pending.overrides)) return
    const next = pending
    setPending(null)
    props.onChange(next.id, keep ? next.overrides! : {})
  }

  const switchDescription = (): string => {
    if (!pending) return ''
    if (pending.overrides === null) {
      return `The previous preset settings could not be loaded. Discard changes uses ${pending.name}; Cancel keeps your current selection and edits.`
    }
    if (pending.unknownBaseline) {
      return `The original preset is unavailable. Keep changes retains the saved process settings when switching to ${pending.name}; Discard changes uses the new preset settings.`
    }
    return `Keep this project's setting changes when switching to ${pending.name}?`
  }

  return <>
    <SlicingPresetAutocomplete profiles={props.profiles} value={props.value}
      placeholder={busy ? 'Resolving preset...' : 'Choose a process preset'} ariaLabel="Preset"
      modified={props.modified} disabled={props.disabled || busy}
      onChange={(profile) => { void select(profile) }} />
    {error && <Typography color="danger" level="body-sm" role="alert">{error}</Typography>}
    {pending && <FormDialog title="Switch process preset?" submitLabel="Keep changes"
      submitDisabled={pending.overrides === null}
      onSubmit={() => commit(true)} onClose={() => setPending(null)}
      secondaryActions={<Button variant="outlined" color="neutral" onClick={() => commit(false)}>Discard changes</Button>}>
      <Typography>{switchDescription()}</Typography>
    </FormDialog>}
  </>
}
