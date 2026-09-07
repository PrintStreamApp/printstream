/**
 * The SVG tool's panel: pick artwork, size it in millimetres, and add it.
 *
 * Sibling of {@link TextToolPanel}, and deliberately the same chrome, because they are the same
 * gesture with a different 2D source. The differences are only what SVG genuinely needs: a file to
 * read, a width in mm (artwork has no font size), and a height READOUT, since the aspect comes from
 * the file rather than from anything the user can set.
 *
 * Unlike the text tool this one commits on an explicit Add rather than live-editing what it has
 * already placed: artwork has no equivalent of typing another letter, so there is nothing to
 * rebuild on each keystroke.
 *
 * A saved part CARRIES what it was made from (`@printstream/shared/three-mf` `svg-shape.ts`: a
 * `<printstream_svg/>` naming a `3D/<name>.svg` archive entry, plus BambuStudio's own
 * `<BambuStudioShape/>` when the import produced one part), and opening the tool on such a part
 * REOPENS it: the record fills this panel and the artwork is re-read from that archive entry.
 *
 * Committing then replaces every piece of the artwork still in the project, not just the mark that
 * happened to be selected, because width and thickness describe the whole drawing. That is why the
 * commit button counts what it is about to change instead of saying "Update", and why the file
 * button offers to REPLACE the artwork rather than to choose another one.
 *
 * The file never leaves the tab: it is read here and extruded in `lib/svgGeometry.ts`, like every
 * other model the editor opens.
 */
import { Button, Checkbox, FormControl, FormLabel, Option, Select, Stack, Typography } from '@mui/joy'
import ImageRoundedIcon from '@mui/icons-material/ImageRounded'
import type { SceneEditPartSubtype } from '@printstream/shared'
import { TOOL_PANEL_ANCHOR } from './editorPanels'
import { TOOL_PANEL_Z_INDEX } from './editorLayers'
import { ADDED_PART_SUBTYPES, addedPartLabel } from './lib/addedParts'
import { NumberField } from './NumberField'

export interface SvgToolValue {
  /** Artwork width on the plate, mm. Height follows the file's aspect. */
  widthMm: number
  /** Extrusion depth, mm. */
  thickness: number
  /** Join / cut / modifier, exactly as an added part. Ignored when there is no host. */
  operation: SceneEditPartSubtype
  /**
   * Whether to bring in a shape that spans the whole artwork.
   *
   * Off by default, and only offered when one is found. A backdrop becomes the imported object's
   * BODY, and a body cannot be deleted without deleting the object and every part with it, so
   * importing one you did not want is not a one-click mistake to undo.
   */
  includeBackground: boolean
}

export interface SvgToolPanelProps {
  value: SvgToolValue
  onChange: (next: SvgToolValue) => void
  /** The chosen file's name, or null when nothing has been picked yet. */
  fileName: string | null
  /** Height the artwork will occupy at the current width, mm. Zero when nothing is loaded. */
  heightMm: number
  /** True once artwork with at least one FILLED outline is loaded. */
  hasArtwork: boolean
  /** Set when a file was read but had nothing fillable in it, so the panel can say why. */
  emptyReason: string | null
  busy: boolean
  /** Whether it will be added to the selected model rather than as its own object. */
  hasHost: boolean
  /** True when the artwork has a shape spanning the whole of it, so the toggle is worth offering. */
  hasBackground: boolean
  onChooseFile: () => void
  onAdd: () => void
  onClose: () => void
  /**
   * How many parts a commit will REPLACE, when the tool was opened on artwork already in the
   * project. Zero means this is a fresh import.
   *
   * The count is the honest part of the label: the panel's width and thickness describe the whole
   * artwork, not the one mark that happened to be selected, so committing re-extrudes every piece
   * still in the project. Saying "Update" alone would hide that a click changes several rows.
   */
  replacingParts?: number
}

export function SvgToolPanel({
  value, onChange, fileName, heightMm, hasArtwork, emptyReason, busy, hasHost, hasBackground,
  onChooseFile, onAdd, onClose, replacingParts = 0
}: SvgToolPanelProps) {
  const reediting = replacingParts > 0
  const set = <K extends keyof SvgToolValue>(key: K, next: SvgToolValue[K]) => onChange({ ...value, [key]: next })

  return (
    <Stack
      spacing={1}
      sx={{
        position: 'absolute', ...TOOL_PANEL_ANCHOR, zIndex: TOOL_PANEL_Z_INDEX,
        p: 1.25, borderRadius: 'sm', boxShadow: 'sm', bgcolor: 'background.level1',
        width: 'min(300px, calc(100% - 16px))', maxHeight: 'calc(100% - 16px)', overflowY: 'auto'
      }}
    >
      <Typography level="title-sm" startDecorator={<ImageRoundedIcon />}>SVG</Typography>
      <Typography level="body-xs" textColor="text.tertiary">
        {reediting
          ? 'Re-extrudes the artwork already on this model. Every piece of it still in the project is replaced.'
          : hasHost
            ? 'The artwork is added to the selected model as a part you can then move like any other.'
            : 'The artwork is added as its own model on the plate.'}
      </Typography>

      <Button size="sm" variant="outlined" color="neutral" onClick={onChooseFile} loading={busy}>
        {fileName ? (reediting ? 'Replace the artwork…' : 'Choose a different file…') : 'Choose an SVG…'}
      </Button>
      {fileName && (
        <Typography level="body-xs" noWrap title={fileName}>{fileName}</Typography>
      )}
      {emptyReason && (
        <Typography level="body-xs" color="warning">{emptyReason}</Typography>
      )}

      <NumberField
        label="Width (mm)"
        value={value.widthMm}
        limits={{ min: 1, max: 1000 }}
        step={1}
        onChange={(next) => set('widthMm', next)}
      />

      <Typography level="body-xs" textColor="text.tertiary">
        {/* The one dimension the user cannot set: it comes from the file, so show what they will get
            rather than making them work it out from the artwork's proportions. */}
        {hasArtwork ? `Height ${heightMm.toFixed(1)} mm, from the file's proportions` : 'Height follows the file'}
      </Typography>

      <NumberField
        label="Thickness (mm)"
        value={value.thickness}
        limits={{ min: 0.1, max: 100 }}
        onChange={(next) => set('thickness', next)}
      />

      {hasBackground && (
        <Checkbox
          size="sm"
          label="Include the background shape"
          checked={value.includeBackground}
          onChange={(event) => set('includeBackground', event.target.checked)}
          slotProps={{ label: { sx: { fontSize: 'sm' } } }}
        />
      )}
      {hasBackground && !value.includeBackground && (
        <Typography level="body-xs" textColor="text.tertiary">
          {/* Said plainly because the artwork will come in looking different from the file, and a
              silently dropped shape reads as the tool losing part of it. */}
          One shape spans the whole artwork and is treated as its background. It is left out.
        </Typography>
      )}

      {hasHost && (
        <FormControl size="sm">
          <FormLabel>Operation</FormLabel>
          <Select
            size="sm"
            value={value.operation}
            onChange={(_event, next) => { if (next) set('operation', next) }}
          >
            {ADDED_PART_SUBTYPES.map((subtype) => (
              <Option key={subtype} value={subtype}>{addedPartLabel(subtype)}</Option>
            ))}
          </Select>
        </FormControl>
      )}

      <Stack direction="row" spacing={1} justifyContent="flex-end">
        <Button size="sm" variant="plain" color="neutral" onClick={onClose}>Cancel</Button>
        <Button size="sm" onClick={onAdd} disabled={!hasArtwork} loading={busy}>
          {reediting ? (replacingParts === 1 ? 'Update part' : `Update ${replacingParts} parts`) : 'Add'}
        </Button>
      </Stack>
    </Stack>
  )
}
