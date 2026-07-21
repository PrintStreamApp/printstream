/**
 * Floating panel for the added part volume currently holding the gizmo — BambuStudio's part
 * properties, reduced to what an added volume actually has: its type, its material (only when the
 * type carries one), per-volume process settings (modifiers), and remove.
 *
 * Presentational: `EditorView` owns the selection and every mutation. The type Select offers all
 * five subtypes, so a part added as a support blocker can become a printed part without being
 * removed and re-added — the same retype `ModelList`'s part rows offer for baked parts.
 */
import { Box, Button, Option, Select, Sheet, Stack, Typography } from '@mui/joy'
import { threeMfPartSubtypeCarriesFilament, type SceneEditPartSubtype } from '@printstream/shared'
import { ADDED_PART_SUBTYPES, addedPartLabel } from './lib/addedParts'
import { helperVolumeCssColor, helperVolumeSpec } from './lib/helperVolumes'
import type { EditorAddedPart } from './lib/editorModel'
import type { FilamentOption } from './EditorView'

/** Explains what the volume does. Only helper volumes have a rule worth stating. */
function subtypeHint(subtype: SceneEditPartSubtype): string {
  return helperVolumeSpec(subtype)?.hint ?? 'Printed as part of this model, in its own material.'
}

export interface AddedPartPanelProps {
  part: EditorAddedPart
  /** Live colour of the part's material, for the swatch. Null for a type that carries none. */
  filamentColor: string | null
  /** Project materials for the picker; empty hides it (a project with no materials yet). */
  filamentOptions: ReadonlyArray<FilamentOption>
  onChangeType: (partKey: string, subtype: SceneEditPartSubtype) => void
  onChangeFilament: (partKey: string, filamentId: number) => void
  /** Absent when the slice config has no per-object override support (no modifier settings). */
  onEditSettings?: (partKey: string) => void
  onRemove: () => void
  onDone: () => void
  /** Absolute-position anchor shared with the editor's other floating tool panels. */
  anchorSx: Record<string, unknown>
}

export function AddedPartPanel({
  part, filamentColor, filamentOptions, onChangeType, onChangeFilament, onEditSettings, onRemove, onDone, anchorSx
}: AddedPartPanelProps) {
  const helper = helperVolumeSpec(part.subtype)
  const carriesFilament = threeMfPartSubtypeCarriesFilament(part.subtype)
  const settingsCount = Object.keys(part.settings ?? {}).length
  return (
    <Sheet
      variant="soft"
      sx={{
        position: 'absolute', ...anchorSx, zIndex: (theme) => theme.zIndex.tooltip,
        p: 1.25, borderRadius: 'sm', boxShadow: 'sm',
        width: 'min(280px, calc(100% - 16px))',
        display: 'flex', flexDirection: 'column', gap: 0.75
      }}
    >
      <Stack direction="row" spacing={0.75} alignItems="center">
        {/* A helper volume shows its subtype colour; a printed part shows its material. */}
        <Box
          sx={{
            width: 12, height: 12, borderRadius: '3px', flexShrink: 0,
            bgcolor: helper ? helperVolumeCssColor(helper.color) : filamentColor || 'neutral.softBg',
            border: helper ? undefined : '1px solid rgba(255,255,255,0.18)'
          }}
        />
        <Typography level="title-sm" sx={{ flex: 1, minWidth: 0 }} noWrap>{part.name}</Typography>
        <Select
          size="sm"
          variant="plain"
          value={part.subtype}
          onChange={(_event, subtype) => { if (subtype) onChangeType(part.key, subtype) }}
          slotProps={{ button: { 'aria-label': 'Change part type' } }}
        >
          {ADDED_PART_SUBTYPES.map((subtype) => (
            <Option key={subtype} value={subtype}>{addedPartLabel(subtype)}</Option>
          ))}
        </Select>
      </Stack>
      {carriesFilament && filamentOptions.length > 0 && (
        <Select
          size="sm"
          variant="outlined"
          value={part.filamentId ?? null}
          placeholder="Material"
          onChange={(_event, filamentId) => { if (filamentId != null) onChangeFilament(part.key, filamentId) }}
          slotProps={{ button: { 'aria-label': 'Change part material' } }}
        >
          {filamentOptions.map((option) => (
            <Option key={option.id} value={option.id}>
              <Box
                sx={{
                  width: 12, height: 12, borderRadius: '3px', flexShrink: 0, mr: 0.75,
                  bgcolor: option.color || 'neutral.softBg', border: '1px solid rgba(255,255,255,0.18)'
                }}
              />
              Material {option.id}{option.label ? ` — ${option.label}` : ''}
            </Option>
          ))}
        </Select>
      )}
      <Typography level="body-xs" textColor="text.tertiary">
        {subtypeHint(part.subtype)} Move, rotate, or scale it with the gizmo; click the model body
        to go back to the whole object.
      </Typography>
      <Stack direction="row" spacing={0.75} justifyContent="space-between">
        <Button size="sm" variant="plain" color="danger" onClick={onRemove}>
          Remove part
        </Button>
        <Stack direction="row" spacing={0.75}>
          {part.subtype === 'modifier_part' && onEditSettings && (
            <Button size="sm" variant="soft" onClick={() => onEditSettings(part.key)}>
              Settings{settingsCount > 0 ? ` (${settingsCount})` : ''}
            </Button>
          )}
          <Button size="sm" onClick={onDone}>Done</Button>
        </Stack>
      </Stack>
    </Sheet>
  )
}
