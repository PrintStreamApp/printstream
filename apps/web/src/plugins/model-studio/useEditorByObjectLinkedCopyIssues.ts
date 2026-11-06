/**
 * The active plate's by-object linked-copy problems, for the editor's viewport issue sheet.
 *
 * Owns working out the plate's EFFECTIVE print sequence, which lives in three places in priority
 * order: the plate's own override, the session's project-wide process override (the Process
 * settings dialog, which is where a user most often switches to "by object"), and the resolved
 * process preset. The prediction itself is `lib/editorByObjectLinkedCopies.ts` over the shared rule.
 *
 * The preset is resolved only when it can change the answer: the plate holds linked copies, the
 * selected engine is a verified-affected build, and neither override already decides the sequence.
 * Everywhere else the hook costs nothing, which is almost every session.
 */
import { useMemo } from 'react'
import type { ProcessConfigValue } from '@printstream/shared'
import { engineHasByObjectLinkedCopyDefect } from '@printstream/shared/three-mf'
import type { ProcessConfigResolver } from '../../components/ProcessSettingsDialog'
import type { SliceSettingsController } from '../../components/library/SliceSettingsPanel'
import type { EditorPlate } from './lib/editorModel'
import {
  assessEditorPlateByObjectLinkedCopies,
  plateHasLinkedCopies,
  selectedSliceEngine,
  type EditorByObjectLinkedCopyIssue
} from './lib/editorByObjectLinkedCopies'
import { useResolvedProcessConfig } from './lib/useResolvedProcessConfig'

const NO_ISSUES: EditorByObjectLinkedCopyIssue[] = []

interface ByObjectLinkedCopyIssuesInput {
  plate: EditorPlate | null
  sliceConfig: SliceSettingsController | undefined
  /** Must be stable; see `useResolvedProcessConfig`. */
  resolveProcessConfig: ProcessConfigResolver | undefined
}

/** Return the active plate's linked-copy issues, empty while unknown or when it prints correctly. */
export function useEditorByObjectLinkedCopyIssues(input: ByObjectLinkedCopyIssuesInput): EditorByObjectLinkedCopyIssue[] {
  const { plate, sliceConfig, resolveProcessConfig } = input
  const perObject = sliceConfig?.perObjectSettings ?? null

  const engine = selectedSliceEngine(sliceConfig)
  const engineAffected = engineHasByObjectLinkedCopyDefect(engine, 'printsTogether')
    || engineHasByObjectLinkedCopyDefect(engine, 'copiesDropped')
  const hasLinkedCopies = plate != null && plateHasLinkedCopies(plate)
  const overrideSequence = readPrintSequence(perObject?.globalOverrides.print_sequence)

  // Only reach for the preset when neither override has already decided the sequence.
  const needsPreset = engineAffected && hasLinkedCopies && plate?.printSequence == null && overrideSequence == null
  const { config } = useResolvedProcessConfig({
    enabled: needsPreset && perObject != null,
    slicerTargetId: perObject?.slicerTargetId ?? '',
    processProfileId: perObject?.processProfileId ?? '',
    sourceFileId: perObject?.sourceFileId ?? null,
    ...(resolveProcessConfig ? { resolveConfig: resolveProcessConfig } : {})
  })

  const printSequence = plate?.printSequence ?? overrideSequence ?? readPrintSequence(config?.print_sequence)

  // Recomputed every render rather than memoised on `plate`: transform edits mutate instances in
  // place, so a rotated copy keeps the same plate object. The gates above make this a no-op for
  // nearly every plate, and the signature keeps the returned array stable while nothing changed.
  const issues = plate && engineAffected && hasLinkedCopies && printSequence === 'by object'
    ? assessEditorPlateByObjectLinkedCopies({ plate, engine, printSequence })
    : NO_ISSUES
  const signature = issues === NO_ISSUES ? '' : JSON.stringify(issues)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the signature IS the content of `issues`
  return useMemo(() => issues, [signature])
}

/** A process value as a print sequence, null when absent. Vector-shaped values carry it first. */
function readPrintSequence(value: ProcessConfigValue | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed ? trimmed : null
}
