/**
 * Resolves the layer heights used by the editor's height tools.
 * BambuStudio discards an entire variable-height profile outside the machine band,
 * so every generator and edit needs the same validated bounds and first-layer seed.
 */

type ProcessOverrides = Record<string, string | string[]> | null | undefined

function positiveProcessNumber(overrides: ProcessOverrides, key: string): number | null {
  const raw = overrides?.[key]
  const value = Number.parseFloat(Array.isArray(raw) ? raw[0] ?? '' : raw ?? '')
  return Number.isFinite(value) && value > 0 ? value : null
}

/** Use the process's nominal height to seed a new range, else BambuStudio's 0.2 mm default. */
export function defaultEditorLayerHeightMm(overrides: ProcessOverrides): number {
  return positiveProcessNumber(overrides, 'layer_height') ?? 0.2
}

/** Start a variable-height profile at the machine's exact first-layer height. */
export function firstEditorLayerHeightMm(overrides: ProcessOverrides, nominalHeight: number): number {
  return positiveProcessNumber(overrides, 'initial_layer_print_height') ?? nominalHeight
}

/** Prefer the project's machine limits; otherwise apply BambuStudio's nozzle-based band. */
export function editorLayerHeightBounds(
  stated: { min: number; max: number } | null | undefined,
  nozzleDiameter: string | number | null | undefined
): { min: number; max: number } {
  if (stated && Number.isFinite(stated.min) && Number.isFinite(stated.max)
    && stated.min > 0 && stated.max > stated.min) return stated

  const parsedNozzle = Number.parseFloat(String(nozzleDiameter ?? ''))
  const nozzle = Number.isFinite(parsedNozzle) && parsedNozzle > 0 ? parsedNozzle : 0.4
  const min = 0.07
  return { min, max: Math.max(min, 0.75 * nozzle) }
}
