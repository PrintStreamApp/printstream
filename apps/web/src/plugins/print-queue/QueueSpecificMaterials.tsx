/**
 * Material mapping for a queue item pinned to a specific printer. Per required filament the user
 * keeps the loaded-AMS-slot mapper (the {@link PrinterMapping} the Print dialog uses) OR toggles to
 * "Material" and picks a Filament-library / Custom material instead — useful when the desired
 * material isn't loaded yet. A material-mode filament leaves its AMS slot at the `-1` auto sentinel;
 * the dispatch merge (`mergeAmsMapping`, API) resolves it to a matching loaded slot at start time.
 */
import { useEffect, useMemo, useState } from 'react'
import { Button, Stack, ToggleButtonGroup, Typography } from '@mui/joy'
import type { Printer, PrinterStatus, QueueRequiredFilament, ThreeMfProjectFilament } from '@printstream/shared'
import { PrinterMapping } from '../../components/library/PrinterMapping'
import { QueueMaterialRow } from './QueueMaterialRow'
import { materialKey, useFilamentLibrary } from './useFilamentLibrary'

type Mode = 'slot' | 'material'

function toRequiredFilament(filament: ThreeMfProjectFilament): QueueRequiredFilament {
  return { id: filament.id, filamentType: filament.filamentType, color: filament.color, filamentName: filament.filamentName }
}

export function QueueSpecificMaterials({
  printer,
  status,
  filaments,
  fileFilaments,
  usedGramsById,
  mapping,
  materials,
  onMappingChange,
  onMaterialsChange
}: {
  printer: Printer
  status: PrinterStatus | undefined
  /** The plate's filaments to map (project shape, for the slot mapper). */
  filaments: ThreeMfProjectFilament[]
  /** The sliced file's required filaments (the "file default" per row). */
  fileFilaments: QueueRequiredFilament[]
  usedGramsById: Map<number, number>
  /** Effective per-filament AMS slot mapping (computed default, or the user's override). */
  mapping: number[]
  /** Effective per-filament required materials. */
  materials: QueueRequiredFilament[]
  onMappingChange: (next: number[]) => void
  onMaterialsChange: (next: QueueRequiredFilament[]) => void
}) {
  const { materials: libraryMaterials } = useFilamentLibrary()
  const fileById = useMemo(() => new Map(fileFilaments.map((entry) => [entry.id, entry] as const)), [fileFilaments])
  const materialById = useMemo(() => new Map(materials.map((entry) => [entry.id, entry] as const)), [materials])

  const deriveMode = (id: number): Mode => {
    if ((mapping[id - 1] ?? -1) >= 0) return 'slot'
    const material = materialById.get(id)
    const file = fileById.get(id)
    const overridden = Boolean(material && file && materialKey(material.filamentType, material.color) !== materialKey(file.filamentType, file.color))
    return overridden ? 'material' : 'slot'
  }
  // Explicit per-filament mode so toggling to "Material" sticks even when its values equal the file
  // default. Re-seed when the plate's filaments change.
  const [modes, setModes] = useState<Record<number, Mode>>(() => Object.fromEntries(filaments.map((f) => [f.id, deriveMode(f.id)])))
  // Re-seed when the plate's filaments change (a plate switch re-seeds the rows to file defaults).
  const resetKey = fileFilaments.map((f) => `${f.id}:${f.filamentType ?? ''}:${f.color ?? ''}`).join('|')
  useEffect(() => {
    setModes(Object.fromEntries(filaments.map((f) => [f.id, deriveMode(f.id)])))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey])

  const setSlot = (filamentId: number, tray: number) => {
    const next = [...mapping]
    while (next.length < filamentId) next.push(-1)
    next[filamentId - 1] = tray
    onMappingChange(next)
  }

  const setMaterial = (id: number, value: QueueRequiredFilament) => {
    onMaterialsChange(fileFilaments.map((file) => (file.id === id ? value : materialById.get(file.id) ?? file)))
    const next = [...mapping]
    while (next.length < id) next.push(-1)
    next[id - 1] = -1 // material mode → auto-resolve a matching slot at dispatch
    onMappingChange(next)
  }

  const switchMode = (id: number, mode: Mode) => {
    setModes((prev) => ({ ...prev, [id]: mode }))
    if (mode === 'material') {
      // Seed the material to the sliced file default; clear the explicit slot.
      setMaterial(id, fileById.get(id) ?? materialById.get(id) ?? { id, filamentType: null, color: null, filamentName: null })
    } else {
      // Back to slot mapping: reset the requirement to the file default, leave the slot unset.
      const next = [...mapping]
      while (next.length < id) next.push(-1)
      next[id - 1] = -1
      onMappingChange(next)
      onMaterialsChange(fileFilaments.map((file) => (file.id === id ? file : materialById.get(file.id) ?? file)))
    }
  }

  if (filaments.length === 0) {
    return (
      <Typography level="body-xs" textColor="text.tertiary">
        This file reports no filaments to map.
      </Typography>
    )
  }

  return (
    <Stack spacing={1.5}>
      {filaments.map((filament) => {
        const mode = modes[filament.id] ?? 'slot'
        const file = fileById.get(filament.id) ?? toRequiredFilament(filament)
        const value = materialById.get(filament.id) ?? file
        return (
          <Stack key={filament.id} spacing={0.5}>
            <ToggleButtonGroup
              size="sm"
              value={mode}
              onChange={(_event, next) => next && switchMode(filament.id, next)}
              sx={{ alignSelf: 'flex-start' }}
            >
              <Button value="slot">Loaded slot</Button>
              <Button value="material">Material</Button>
            </ToggleButtonGroup>
            {mode === 'slot' ? (
              <PrinterMapping
                printer={printer}
                status={status}
                filaments={[filament]}
                usedGramsById={usedGramsById}
                mapping={mapping}
                issues={[]}
                onChange={(filamentId, tray) => setSlot(filamentId, tray)}
              />
            ) : (
              <QueueMaterialRow file={file} value={value} materials={libraryMaterials} requiredGrams={usedGramsById.get(filament.id)} onChange={(next) => setMaterial(filament.id, next)} />
            )}
          </Stack>
        )
      })}
    </Stack>
  )
}
