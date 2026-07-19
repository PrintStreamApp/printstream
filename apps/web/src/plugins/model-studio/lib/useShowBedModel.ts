/**
 * The "3D build plate" viewport preference, shared by every surface that draws a plate: the
 * editor and the read-only previews (plated 3MF + sliced G-code).
 *
 * One hook rather than a `useLocalStorageState` call per surface so the key, the default, and the
 * parse all live in one place — a second copy would drift and leave the previews rendering a
 * different plate from the editor, which is exactly what this setting exists to prevent.
 *
 * On by default (it fades out when the camera drops below it, which was the reason it originally
 * shipped opt-in). Stored per device; a device that explicitly turned it off keeps that choice.
 * Written from the editor settings dialog (`components/library/EditorSettingsDialog.tsx`).
 */
import { useLocalStorageState } from '../../../hooks/useLocalStorageState'

const SHOW_BED_MODEL_KEY = 'bambu.editor.bedModel3d'

/** Returns `useLocalStorageState`'s tuple: `[value, setValue, hydrated]`. */
export function useShowBedModel(): [boolean, (value: boolean) => void, boolean] {
  return useLocalStorageState(
    SHOW_BED_MODEL_KEY,
    true,
    (raw) => (raw === 'true' ? true : raw === 'false' ? false : null),
    String
  )
}
