/**
 * Per-plate layer G-code sections — "Filament changes" (whole-plate material swaps at a
 * print height) and "Pauses" (stop-and-resume at a print height) — plus the material
 * option row + `FilamentOption` shape their pickers share.
 *
 * Core-owned (not model-studio) because BOTH surfaces render them: the 3D editor's
 * sidebar (edits bake into the saved 3MF via `SceneEdit`) and the prepare-print dialog
 * (edits ride the slice request's `filamentChanges`/`pauses` and apply to that slice
 * only). Entries are keyed by print height in mm, not layer index, so they survive
 * layer-height changes (BambuStudio semantics; the slicer snaps to the nearest layer).
 */
import { type ReactNode } from 'react'
import {
  Box,
  Button,
  Dropdown,
  IconButton,
  Input,
  Menu,
  MenuButton,
  Option,
  Select,
  Sheet,
  Stack,
  Typography
} from '@mui/joy'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import HelpOutlineRoundedIcon from '@mui/icons-material/HelpOutlineRounded'

/** A selectable project material (1-based id) with its live colour + display labels. */
export type FilamentOption = { id: number; color: string | null; label: string | null; colorName: string | null }

/** One layer-based filament change: swap to `filamentId` at print height `z` (mm). */
export interface PlateFilamentChange {
  z: number
  filamentId: number
}

/** One layer pause: printing stops just before the layer whose top is `z` (mm). */
export interface PlatePause {
  z: number
}

/** Material number + swatch + label + colour name for filament pickers (options AND value). */
export function FilamentOptionContent({ option }: { option: FilamentOption }) {
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
      <Typography level="body-xs" textColor="text.tertiary" sx={{ flexShrink: 0, minWidth: '1.1em', textAlign: 'right' }}>
        {option.id}
      </Typography>
      <Box sx={{ width: 12, height: 12, borderRadius: '3px', flexShrink: 0, bgcolor: option.color || 'neutral.softBg', border: '1px solid rgba(255,255,255,0.18)' }} />
      <Typography level="body-sm" noWrap>{option.label}</Typography>
      {option.colorName || option.color ? (
        <Typography level="body-xs" textColor="text.tertiary" noWrap sx={{ flexShrink: 1, minWidth: 0 }}>
          {option.colorName ?? option.color}
        </Typography>
      ) : null}
    </Box>
  )
}

/**
 * Click-driven help popup for a section heading (not a hover Tooltip, so it also opens
 * on touch devices). Carries the section's explanatory copy so the heading row itself
 * stays compact.
 */
function SectionHelpPopup({ ariaLabel, title, children }: {
  ariaLabel: string
  title: string
  children: ReactNode
}) {
  return (
    <Dropdown>
      <MenuButton
        slots={{ root: IconButton }}
        slotProps={{ root: { size: 'sm', variant: 'plain', color: 'neutral', 'aria-label': ariaLabel } }}
      >
        <HelpOutlineRoundedIcon fontSize="small" />
      </MenuButton>
      <Menu placement="bottom-start" sx={{ zIndex: (theme) => theme.zIndex.tooltip, p: 1.25, maxWidth: 300 }}>
        <Typography level="title-sm" sx={{ mb: 0.75 }}>{title}</Typography>
        <Stack spacing={0.75}>{children}</Stack>
      </Menu>
    </Dropdown>
  )
}

/**
 * The per-plate "Pauses" section: layer pauses entered by print height (mm), mirroring
 * the filament-change rows. Renders like the settings sidebar's other sections (title
 * row + outlined container) with the Add action anchored right, below
 * {@link PlateFilamentChangesSection}.
 */
export function PlatePausesSection({ pauses, onChange }: {
  pauses: PlatePause[]
  onChange: (pauses: PlatePause[]) => void
}) {
  return (
    <Stack spacing={0.75} sx={{ minWidth: 0 }}>
      <Stack direction="row" spacing={0.25} alignItems="center">
        <Typography level="title-sm">Pauses</Typography>
        <SectionHelpPopup ariaLabel="About pauses" title="Pauses">
          <Typography level="body-xs">
            Stop the print at a height, e.g. to embed magnets or nuts, then resume from
            the printer screen.
          </Typography>
          <Typography level="body-xs">
            The printer stops just before it prints the layer that ends at the height you
            enter. With 0.2 mm layers, a pause at 5.0 mm stops once 4.8 mm has printed.
          </Typography>
          <Typography level="body-xs">
            Each pause shows as an amber line on the models, and the height keeps working
            if you change the layer height later.
          </Typography>
          <Typography level="body-xs">
            Need an exact layer? Slice the plate, scrub the G-code preview to the layer you
            want, and enter the height shown next to the layer number.
          </Typography>
        </SectionHelpPopup>
        <Button
          size="sm"
          variant="soft"
          startDecorator={<AddRoundedIcon />}
          onClick={() => {
            const lastZ = pauses[pauses.length - 1]?.z ?? 0
            onChange([...pauses, { z: Math.round((lastZ + 1) * 10) / 10 }])
          }}
          sx={{ ml: 'auto' }}
        >
          Add pause
        </Button>
      </Stack>
      <Sheet variant="outlined" sx={{ p: 1, borderRadius: 'sm' }}>
        <Stack spacing={0.75}>
          {pauses.length === 0 && (
            <Typography level="body-sm" textColor="text.tertiary">No pauses on this plate.</Typography>
          )}
          {pauses.map((pause, index) => (
            <Stack key={index} direction="row" spacing={0.75} alignItems="center">
              <Input
                size="sm"
                type="number"
                value={pause.z}
                endDecorator="mm"
                slotProps={{ input: { min: 0.2, step: 0.2, 'aria-label': 'Pause height' } }}
                onChange={(event) => {
                  const next = Number.parseFloat(event.target.value)
                  if (!Number.isFinite(next) || next <= 0) return
                  onChange(pauses.map((entry, i) => (i === index ? { z: next } : entry)))
                }}
                sx={{ flex: 1, minWidth: 84 }}
              />
              <IconButton
                size="sm"
                variant="plain"
                color="neutral"
                aria-label="Remove pause"
                onClick={() => onChange(pauses.filter((_, i) => i !== index))}
              >
                <CloseRoundedIcon />
              </IconButton>
            </Stack>
          ))}
        </Stack>
      </Sheet>
    </Stack>
  )
}

/**
 * The per-plate "Filament changes" section: layer-based whole-plate material swaps
 * entered by print height (mm). Renders like the settings sidebar's other sections
 * (title row + outlined container, above {@link PlatePausesSection}) with the Add
 * action anchored right and a compact swatch+id material select — the open listbox
 * still shows the full material names.
 */
export function PlateFilamentChangesSection({ changes, filamentOptions, onChange }: {
  changes: PlateFilamentChange[]
  filamentOptions: FilamentOption[]
  onChange: (changes: PlateFilamentChange[]) => void
}) {
  return (
    <Stack spacing={0.75} sx={{ minWidth: 0 }}>
      <Stack direction="row" spacing={0.25} alignItems="center">
        <Typography level="title-sm">Filament changes</Typography>
        <SectionHelpPopup ariaLabel="About filament changes" title="Filament changes">
          <Typography level="body-xs">
            Swap to another material at a print height. The whole plate changes colour
            from that layer up.
          </Typography>
          <Typography level="body-xs">
            Need an exact layer? Slice the plate, scrub the G-code preview to the layer you
            want, and enter the height shown next to the layer number.
          </Typography>
        </SectionHelpPopup>
        <Button
          size="sm"
          variant="soft"
          startDecorator={<AddRoundedIcon />}
          onClick={() => {
            const lastZ = changes[changes.length - 1]?.z ?? 0
            const lastFilament = changes[changes.length - 1]?.filamentId
            const nextOption = filamentOptions.find((option) => option.id !== (lastFilament ?? filamentOptions[0]?.id))
            onChange([
              ...changes,
              { z: Math.round((lastZ + 1) * 10) / 10, filamentId: nextOption?.id ?? filamentOptions[0]?.id ?? 1 }
            ])
          }}
          sx={{ ml: 'auto' }}
        >
          Add change
        </Button>
      </Stack>
      <Sheet variant="outlined" sx={{ p: 1, borderRadius: 'sm' }}>
        <Stack spacing={0.75}>
          {changes.length === 0 && (
            <Typography level="body-sm" textColor="text.tertiary">No filament changes on this plate.</Typography>
          )}
          {changes.map((change, index) => (
            <Stack key={index} direction="row" spacing={0.75} alignItems="center">
              <Input
                size="sm"
                type="number"
                value={change.z}
                endDecorator="mm"
                slotProps={{ input: { min: 0.2, step: 0.2, 'aria-label': 'Change height' } }}
                onChange={(event) => {
                  const next = Number.parseFloat(event.target.value)
                  if (!Number.isFinite(next) || next <= 0) return
                  onChange(changes.map((entry, i) => (i === index ? { ...entry, z: next } : entry)))
                }}
                sx={{ flex: 1, minWidth: 84 }}
              />
              <Select<number>
                size="sm"
                value={change.filamentId}
                onChange={(_event, value) => {
                  if (value == null) return
                  onChange(changes.map((entry, i) => (i === index ? { ...entry, filamentId: value } : entry)))
                }}
                renderValue={(selected) => {
                  const option = filamentOptions.find((entry) => entry.id === selected?.value)
                  if (!option) return null
                  return (
                    <Stack direction="row" spacing={0.5} alignItems="center">
                      <Box sx={{ width: 12, height: 12, borderRadius: '3px', flexShrink: 0, bgcolor: option.color || 'neutral.softBg', border: '1px solid rgba(255,255,255,0.18)' }} />
                      <span>{option.id}</span>
                    </Stack>
                  )
                }}
                slotProps={{ button: { 'aria-label': 'Change to material' } }}
                sx={{ minWidth: 64, flexShrink: 0 }}
              >
                {filamentOptions.map((option) => (
                  <Option key={option.id} value={option.id}>
                    <FilamentOptionContent option={option} />
                  </Option>
                ))}
              </Select>
              <IconButton
                size="sm"
                variant="plain"
                color="neutral"
                aria-label="Remove filament change"
                onClick={() => onChange(changes.filter((_, i) => i !== index))}
              >
                <CloseRoundedIcon />
              </IconButton>
            </Stack>
          ))}
        </Stack>
      </Sheet>
    </Stack>
  )
}
