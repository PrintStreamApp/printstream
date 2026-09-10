/**
 * BambuStudio's Text gizmo: type text, pick a face and size, and add it to the selected model as a
 * part that joins, cuts, or modifies.
 *
 * Presentational. It owns the form and reports a complete {@link TextToolValue} on every change;
 * the editor owns the geometry, the staging and the scene.
 *
 * **The text already exists while this is open.** BambuStudio creates it the moment the tool is
 * activated, centred on the host, and selects it; the panel then edits a LIVE part. There is no Add
 * button for that reason -- it would imply the model had not changed yet, when the thing being
 * described is already on it and already draggable.
 *
 * **Operation maps onto our existing part subtypes**, so text needs no concept of its own: Join is
 * a normal part, Cut is a negative volume, Modifier is a parameter modifier. That is why text can
 * ride the added-part seam the primitives already use.
 *
 * **Surface mode is the default**, as it is in BambuStudio: text follows the surface it sits on, so
 * text placed in a bore wraps around it rather than hovering flat above the rim.
 */
import { Alert, Button, Checkbox, FormControl, FormLabel, Input, Option, Select, Slider, Stack, Typography } from '@mui/joy'
import TextFieldsRoundedIcon from '@mui/icons-material/TextFieldsRounded'
import UploadFileRoundedIcon from '@mui/icons-material/UploadFileRounded'
import { useRef } from 'react'
import { TEXT_INFO_LIMITS, type TextSurfaceType } from '@printstream/shared/three-mf'
import type { SceneEditPartSubtype } from '@printstream/shared'
import type { TextToolValue } from './lib/textToolValue'
import { TOOL_PANEL_ANCHOR } from './editorPanels'
import { TOOL_PANEL_Z_INDEX } from './editorLayers'
import { hasBundledCut, type TextFontFace } from './lib/textFonts'
import { NumberField } from './NumberField'

/** Studio's Join / Cut / Modifier, as the part subtypes they already are here. */
const OPERATIONS: ReadonlyArray<{ value: SceneEditPartSubtype; label: string; hint: string }> = [
  { value: 'normal_part', label: 'Join', hint: 'Printed as part of the model' },
  { value: 'negative_part', label: 'Cut', hint: 'Engraved into the model, to the thickness above' },
  { value: 'modifier_part', label: 'Modifier', hint: 'Changes settings in this region' }
]

/**
 * The placement modes we OFFER. Studio's `TextInfo::TextType` has a fourth, `surfaceChar`, which is
 * deliberately absent: see the tool's development notes. The type keeps it, because `surface_type` is a
 * persisted index and files (ours and Studio's) carry it.
 */
const SURFACE_MODES: ReadonlyArray<{ value: TextSurfaceType; label: string; hint: string }> = [
  { value: 'horizontal', label: 'Flat', hint: 'One flat block of text, laid on the surface' },
  { value: 'surface', label: 'Follow surface', hint: 'Wraps along the surface, around a hole or a curve' },
  { value: 'surfaceHorizontal', label: 'Follow, upright', hint: 'Wraps, with a level baseline on a tilted or curved face' }
]

export interface TextToolPanelProps {
  value: TextToolValue
  /**
   * Whether this text has a model to sit on. False when nothing was selected, which makes the text
   * its own top-level object -- and a separate object has no surface to follow, so the surface modes
   * are not offered rather than being offered and doing nothing.
   */
  hasHost: boolean
  families: readonly string[]
  /** Faces the user loaded this session, offered alongside the bundled families. */
  userFaces: readonly TextFontFace[]
  busy: boolean
  onChange: (value: TextToolValue) => void
  onLoadFontFile: (file: File) => void
  /** Delete the text part being edited and leave the tool. */
  onRemove: () => void
  onClose: () => void
}

export function TextToolPanel({
  value, hasHost, families, userFaces, busy, onChange, onLoadFontFile, onRemove, onClose
}: TextToolPanelProps) {
  const filePicker = useRef<HTMLInputElement | null>(null)
  const set = <K extends keyof TextToolValue>(key: K, next: TextToolValue[K]): void =>
    onChange({ ...value, [key]: next })

  const userFamily = userFaces.some((face) => face.family === value.family)
  // A user-loaded file is one cut; there is no bold/italic sibling to switch to.
  const boldAvailable = userFamily ? false : hasBundledCut(value.family, true, value.italic)
  const italicAvailable = userFamily ? false : hasBundledCut(value.family, value.bold, true)

  return (
    <Stack
      spacing={1}
      sx={{
        position: 'absolute', ...TOOL_PANEL_ANCHOR, zIndex: TOOL_PANEL_Z_INDEX,
        p: 1.25, borderRadius: 'sm', boxShadow: 'sm', bgcolor: 'background.level1',
        width: 'min(300px, calc(100% - 16px))', maxHeight: 'calc(100% - 16px)', overflowY: 'auto'
      }}
    >
      <Typography level="title-sm" startDecorator={<TextFieldsRoundedIcon />}>Text</Typography>
      <Typography level="body-xs" textColor="text.tertiary">
        {hasHost
          ? 'The text is on the model already; every change here updates it. Drag it across the model to move it, and it reshapes to the surface under your cursor.'
          : 'The text is added as its own model on the plate.'}
      </Typography>

      <Input
        size="sm"
        autoFocus
        value={value.text}
        onChange={(event) => set('text', event.target.value)}
        placeholder="Type something"
        slotProps={{ input: { 'aria-label': 'Text' } }}
      />

      <FormControl size="sm">
        <FormLabel>Font</FormLabel>
        <Select
          size="sm"
          value={value.family}
          onChange={(_event, next) => { if (next) set('family', next) }}
        >
          {families.map((family) => <Option key={family} value={family}>{family}</Option>)}
          {userFaces.map((face) => <Option key={face.id} value={face.family}>{face.family}</Option>)}
        </Select>
      </FormControl>

      <Stack direction="row" spacing={1} alignItems="center">
        <Checkbox
          size="sm" label="Bold" checked={value.bold} disabled={!boldAvailable}
          onChange={(event) => set('bold', event.target.checked)}
        />
        <Checkbox
          size="sm" label="Italic" checked={value.italic} disabled={!italicAvailable}
          onChange={(event) => set('italic', event.target.checked)}
        />
        <Button
          size="sm" variant="plain" startDecorator={<UploadFileRoundedIcon />}
          onClick={() => filePicker.current?.click()}
          sx={{ ml: 'auto' }}
        >
          Font file
        </Button>
        <input
          ref={filePicker}
          type="file"
          accept=".ttf,.otf,.woff,font/ttf,font/otf,font/woff"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            // Cleared so picking the SAME file twice still fires a change event.
            event.target.value = ''
            if (file) onLoadFontFile(file)
          }}
        />
      </Stack>

      {(!boldAvailable && value.bold) || (!italicAvailable && value.italic) ? (
        <Alert size="sm" color="neutral" variant="soft">
          <Typography level="body-xs">
            This font has no {!boldAvailable && value.bold ? 'bold' : 'italic'} cut, so the regular
            one is used. Faking one by thickening the outline distorts the letterforms.
          </Typography>
        </Alert>
      ) : null}

      <NumberField
        label="Size (mm)" value={value.fontSize} limits={TEXT_INFO_LIMITS.fontSize}
        onChange={(next) => set('fontSize', next)}
      />
      <NumberField
        label="Thickness (mm)" value={value.thickness} limits={TEXT_INFO_LIMITS.thickness}
        onChange={(next) => set('thickness', next)}
      />
      <NumberField
        label="Letter spacing (mm)" value={value.textGap} limits={TEXT_INFO_LIMITS.textGap}
        onChange={(next) => set('textGap', next)}
      />
      {/* Meaningless for Cut, whose whole depth is inside the model by construction, and for text
          standing on its own, which has no surface to sink into. */}
      {hasHost && value.operation !== 'negative_part' && (
        <NumberField
          label="Sink into surface (mm)" value={value.embeddedDepth} limits={TEXT_INFO_LIMITS.embeddedDepth}
          onChange={(next) => set('embeddedDepth', next)}
        />
      )}

      <Stack spacing={0.5}>
        <Typography level="body-xs" textColor="text.tertiary">Angle {value.rotateAngle}°</Typography>
        <Slider
          size="sm" min={TEXT_INFO_LIMITS.rotateAngle.min} max={TEXT_INFO_LIMITS.rotateAngle.max} step={1}
          value={value.rotateAngle}
          onChange={(_event, next) => set('rotateAngle', next as number)}
          aria-label="Angle"
        />
      </Stack>

      {/* Both of these describe the text's relationship to a HOST. Standing on its own it has
          neither a surface to follow nor anything to join or cut, so the pair is replaced by the one
          line that explains why. */}
      {hasHost ? (
        <>
          <FormControl size="sm">
            <FormLabel>Placement</FormLabel>
            <Select
              size="sm"
              value={value.surfaceMode}
              onChange={(_event, next) => { if (next) set('surfaceMode', next) }}
            >
              {SURFACE_MODES.map((mode) => <Option key={mode.value} value={mode.value}>{mode.label}</Option>)}
            </Select>
            <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
              {SURFACE_MODES.find((mode) => mode.value === value.surfaceMode)?.hint}
            </Typography>
          </FormControl>

          <FormControl size="sm">
            <FormLabel>Operation</FormLabel>
            <Select
              size="sm"
              value={value.operation}
              onChange={(_event, next) => { if (next) set('operation', next) }}
            >
              {OPERATIONS.map((operation) => (
                <Option key={operation.value} value={operation.value}>{operation.label}</Option>
              ))}
            </Select>
            <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
              {OPERATIONS.find((operation) => operation.value === value.operation)?.hint}
            </Typography>
          </FormControl>
        </>
      ) : (
        <Typography level="body-xs" textColor="text.tertiary">
          This text is its own model, so it stays flat. Select a model before adding text to have it
          follow a surface, or join and cut into it.
        </Typography>
      )}

      <Stack direction="row" spacing={0.75} justifyContent="space-between">
        <Button size="sm" variant="plain" color="danger" onClick={onRemove}>Remove</Button>
        <Button size="sm" loading={busy} onClick={onClose}>Done</Button>
      </Stack>
    </Stack>
  )
}

