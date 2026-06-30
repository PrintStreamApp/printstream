/**
 * Printer-agnostic material editor for the "any printer" queue target (also reused per-filament by
 * the specific-printer picker's "choose material" mode). Renders a {@link QueueMaterialRow} per
 * required filament: file default / Filament library / Custom. The resulting type + colour drive the
 * queue matcher at dispatch; brand/name is carried for display. The library is read over plain HTTP
 * (never importing the filament-manager plugin); when it's empty the file-default + Custom paths
 * still work.
 */
import { useMemo } from 'react'
import { Stack, Typography } from '@mui/joy'
import type { QueueRequiredFilament } from '@printstream/shared'
import { QueueMaterialRow } from './QueueMaterialRow'
import { useFilamentLibrary } from './useFilamentLibrary'

interface QueueMaterialEditorProps {
  /** The plate's own required filaments (the "file default" per row). */
  fileFilaments: QueueRequiredFilament[]
  /** Current edited values (one per file filament, matched by id). */
  value: QueueRequiredFilament[]
  /** Grams each filament needs on the plate (drives the remaining "enough?" indicator). */
  usedGramsById?: Map<number, number>
  onChange: (next: QueueRequiredFilament[]) => void
}

export function QueueMaterialEditor({ fileFilaments, value, usedGramsById, onChange }: QueueMaterialEditorProps) {
  const { materials } = useFilamentLibrary()
  const valueById = useMemo(() => new Map(value.map((entry) => [entry.id, entry] as const)), [value])

  const setFilament = (id: number, next: QueueRequiredFilament) => {
    onChange(fileFilaments.map((file) => (file.id === id ? next : valueById.get(file.id) ?? file)))
  }

  if (fileFilaments.length === 0) {
    return (
      <Typography level="body-xs" textColor="text.tertiary">
        This file reports no filaments to map — it will print on any connected printer.
      </Typography>
    )
  }

  return (
    <Stack spacing={1.5}>
      {fileFilaments.map((file) => (
        <QueueMaterialRow
          key={file.id}
          file={file}
          value={valueById.get(file.id) ?? file}
          materials={materials}
          requiredGrams={usedGramsById?.get(file.id)}
          onChange={(next) => setFilament(file.id, next)}
        />
      ))}
    </Stack>
  )
}
