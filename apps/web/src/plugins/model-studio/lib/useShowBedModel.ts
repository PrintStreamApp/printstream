/**
 * The "3D build plate" viewport preference, shared by every surface that draws a plate: the
 * editor and the read-only previews (plated 3MF + sliced G-code).
 *
 * One hook rather than a `useLocalStorageState` call per surface so the key, the default, and the
 * parse all live in one place — a second copy would drift and leave the previews rendering a
 * different plate from the editor, which is exactly what this setting exists to prevent.
 *
 * On by default (it fades out when the camera drops below it, which was the reason it originally
 * shipped opt-in).
 *
 * Now a thin read-side alias over `lib/editorViewportSettings.ts`, which owns the two-tier
 * resolution every other app setting uses: a workspace-wide default plus an optional per-device
 * override. It stays as its own module so the surfaces that draw a plate keep importing one name
 * — the point of this hook was always that a second copy would drift and leave the previews
 * rendering a different plate from the editor. Both tiers are edited from the editor settings
 * dialog (`components/library/EditorSettingsDialog.tsx`).
 */
export { useEffectiveShowBedModel as useShowBedModel } from '../../../lib/editorViewportSettings'
