/**
 * Owns the global process dialog transaction. Switching presets edits a draft; Apply commits both
 * selection and values once, while dismissal or a replaced host selection abandons the draft.
 * Per-object edits keep their explicit-key semantics in ProcessSettingsDialog.
 */
import { useEffect, useState } from 'react'
import type { ProcessSettingOverrides } from '@printstream/shared'

export function useProcessSettingsDraft(input: {
  open: boolean
  profileId: string
  overrides: ProcessSettingOverrides
  onProfileChange?: (id: string, overrides: ProcessSettingOverrides) => void
  onApply?: (overrides: ProcessSettingOverrides, meta: { clearedKeys: string[] }) => void
}) {
  const [draft, setDraft] = useState<{ id: string; overrides: ProcessSettingOverrides } | null>(null)
  useEffect(() => { setDraft(null) }, [input.open, input.profileId])
  return {
    profileId: draft?.id ?? input.profileId,
    overrides: draft?.overrides ?? input.overrides,
    chooseProfile: (id: string, overrides: ProcessSettingOverrides) => setDraft({ id, overrides }),
    apply: (overrides: ProcessSettingOverrides, meta: { clearedKeys: string[] }) => {
      if (draft && input.onProfileChange) input.onProfileChange(draft.id, overrides)
      else input.onApply?.(overrides, meta)
    }
  }
}
