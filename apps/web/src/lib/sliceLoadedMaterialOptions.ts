type LoadedMaterialOptionLike = {
  source: 'ams' | 'externalSpool' | 'manual'
  nozzleId: number | null
}

export function prioritizeLoadedMaterialOptionsForFilament<T extends LoadedMaterialOptionLike>(
  options: readonly T[],
  _preferredNozzleId: number | null
): T[] {
  const loadedOptions = options.filter((option) => option.source === 'ams' || option.source === 'externalSpool')
  return loadedOptions
    .map((option, index) => ({ option, index, priority: loadedMaterialOptionPriority(option.nozzleId) }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(({ option }) => option)
}

function loadedMaterialOptionPriority(nozzleId: number | null): number {
  if (nozzleId === 1) return 0
  if (nozzleId === 0) return 1
  if (nozzleId == null) return 2
  return 3 + nozzleId
}