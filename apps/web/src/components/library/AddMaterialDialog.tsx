/**
 * Add-material dialog — picks what a new material slot WILL be, before the slot exists.
 *
 * OWNS the pending type/preset/colour for a slot that has not been created yet, which is the whole
 * reason it is separate from `MaterialEditDialog`'s live-apply path: there is no slot to apply to.
 * On confirm it hands the caller a complete `AddedMaterialChoice`; on cancel nothing is created.
 *
 * The contract this enforces: a material slot never exists without the user having said what it is.
 * Adding first and asking after seeded slots from a machine default preset plus a default colour,
 * which the filament identity resolver then presented as a specific real product the user had never
 * chosen. Counterpart: `useMaterialSlots.handleAddFilament`, which refuses to default anything.
 */
import { useState } from 'react'
import { MaterialEditDialog } from './MaterialEditDialog'
import {
  narrowMaterialOptions,
  normalizeSliceFilamentColor,
  resolveMaterialTypeOptions,
  type SliceMaterialOption
} from '../../lib/slicingPresetMatching'
import type { AddedMaterialChoice } from './useMaterialSlots'

/** Neutral starting colour. Unlike the old seed this is only ever a STARTING point — the user sees
 *  and confirms it, so a resulting Bambu colour name reflects a real choice. */
const ADD_MATERIAL_START_COLOR = '#FFFFFF'

export function AddMaterialDialog({
  filamentIndex,
  materialOptions,
  onAdd,
  onCancel
}: {
  /** Position the new slot will take, so the dialog can number it like its siblings. */
  filamentIndex: number
  /** The full option list; narrowing by the chosen type happens here. */
  materialOptions: SliceMaterialOption[]
  onAdd: (choice: AddedMaterialChoice) => void
  onCancel: () => void
}) {
  const [typeFilter, setTypeFilter] = useState('')
  const [selectedOption, setSelectedOption] = useState<SliceMaterialOption | null>(null)
  const [color, setColor] = useState(ADD_MATERIAL_START_COLOR)

  return (
    <MaterialEditDialog
      mode="add"
      filamentIndex={filamentIndex}
      // No slot yet, so no project label to fall back on; the type filter names the colour family.
      filamentLabel={typeFilter || 'PLA'}
      typeFilter={typeFilter}
      typeOptions={resolveMaterialTypeOptions(materialOptions)}
      onTypeFilterChange={setTypeFilter}
      materialOptions={narrowMaterialOptions(materialOptions, typeFilter, selectedOption?.id)}
      selectedOption={selectedOption}
      onMaterialOptionChange={setSelectedOption}
      color={color}
      onColorChange={(next) => setColor(normalizeSliceFilamentColor(next))}
      onClose={(outcome) => {
        // The dialog disables its confirm button without a preset, so this is belt-and-braces
        // against a slot with no resolved profile (which bakes a null filament_settings_id).
        if (outcome !== 'done' || !selectedOption) {
          onCancel()
          return
        }
        onAdd({
          optionId: selectedOption.id,
          color,
          label: selectedOption.materialType || selectedOption.material || 'PLA'
        })
      }}
    />
  )
}
