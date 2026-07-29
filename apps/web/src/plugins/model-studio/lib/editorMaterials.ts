/**
 * The materials seam: everything the 3MF editor needs to know about a project's filaments, and
 * nothing else.
 *
 * The editor used to read materials straight off `SliceSettingsController` — a ~90-field object
 * built inline inside `SliceFileModal` and welded to `/api/printers` and `/api/slicing/*`. Since
 * every add-object path, material swatch, colour-paint overlay, save, and 3MF export keys on those
 * filaments, that one dependency made the editor unmountable anywhere the slice dialog could not
 * also be constructed. This narrows it to two fields, so a host can supply materials from whatever
 * it actually has:
 *
 *  - the library host derives them from the live slice controller ({@link editorMaterialsFromSliceConfig}),
 *    so a material the user edits mid-session retitles and recolours immediately;
 *  - a host with only a file derives them from the project's own filament list
 *    ({@link editorMaterialsFromProjectFilaments}) — which the shared 3MF index parser already
 *    produces, in the browser, with no server involved.
 *
 * Slot ids are BambuStudio's 1-based project filament ids. They are the same numbers colour-paint
 * codes and `extruder` metadata use, so they must never be re-indexed here.
 */
import type { BridgeLibraryThreeMfProjectFilament } from '@printstream/shared'
import { resolveProjectFilamentColorName } from '../../../lib/filamentColor'
import type { FilamentOption } from '../../../components/library/PlateGcodeSections'

export interface EditorMaterials {
  /** Pickable materials in slot order; `id` is the 1-based project filament id. */
  options: FilamentOption[]
  /**
   * Live colour per project filament id. Separate from `options` because the paint overlays read it
   * on every rebuild through a ref and must see a session recolour without the options array
   * changing identity.
   */
  colorById: Record<number, string>
}

/** No materials at all — a project whose filament list has not resolved yet. */
export const EMPTY_EDITOR_MATERIALS: EditorMaterials = { options: [], colorById: {} }

/** The subset of the slice controller this seam consumes. */
export interface SliceConfigMaterialsSource {
  projectFilaments?: Array<{ projectFilamentId: number; label: string; color: string | null }>
  filamentColors?: Record<number, string>
  filamentMaterialOptionIds?: Record<number, string>
  materialOptions?: Array<{ id: string; label: string; materialType?: string | null }>
}

/**
 * Materials as the library host sees them: the project's filaments, retitled and recoloured by
 * whatever the user has selected in the slice dialog this session.
 *
 * The label deliberately tracks the CURRENT selection rather than the project's baked label, so a
 * material the user just changed reads correctly in the editor's pickers instead of showing the
 * value the file was saved with.
 */
export function editorMaterialsFromSliceConfig(sliceConfig: SliceConfigMaterialsSource | undefined): EditorMaterials {
  const filaments = sliceConfig?.projectFilaments ?? []
  if (filaments.length === 0) return EMPTY_EDITOR_MATERIALS
  const options = filaments.map((filament) => {
    const optionId = sliceConfig?.filamentMaterialOptionIds?.[filament.projectFilamentId]
    const option = optionId ? sliceConfig?.materialOptions?.find((entry) => entry.id === optionId) ?? null : null
    const color = sliceConfig?.filamentColors?.[filament.projectFilamentId] ?? filament.color
    return {
      id: filament.projectFilamentId,
      color,
      label: option?.materialType ?? option?.label ?? filament.label,
      colorName: resolveProjectFilamentColorName({
        color,
        filamentName: option?.label ?? filament.label,
        filamentType: option?.materialType ?? null
      })
    }
  })
  return { options, colorById: sliceConfig?.filamentColors ?? colorMapFrom(options) }
}

/**
 * Materials read straight off a parsed 3MF, for a host with no slice controller — the public
 * editor, where the file was opened from the user's disk and never uploaded.
 *
 * There is no live selection to layer on, so the project's own labels and colours ARE the answer.
 */
export function editorMaterialsFromProjectFilaments(
  filaments: ReadonlyArray<Pick<BridgeLibraryThreeMfProjectFilament, 'id' | 'filamentName' | 'color' | 'filamentType'>>
): EditorMaterials {
  const options = filaments.map((filament) => ({
    id: filament.id,
    color: filament.color,
    // The project's own type is the label the editor shows (`PLA`, `PETG`), matching what the
    // library host surfaces once a material option is selected.
    label: filament.filamentType ?? filament.filamentName,
    colorName: resolveProjectFilamentColorName({
      color: filament.color,
      filamentName: filament.filamentName,
      filamentType: filament.filamentType
    })
  }))
  return { options, colorById: colorMapFrom(options) }
}

function colorMapFrom(options: ReadonlyArray<FilamentOption>): Record<number, string> {
  const colors: Record<number, string> = {}
  for (const option of options) if (option.color) colors[option.id] = option.color
  return colors
}
