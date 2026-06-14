type SliceProfileKind = {
  kind: 'machine' | 'process' | 'filament'
}

export function selectCliProfileFiles<T extends SliceProfileKind>(
  profileFiles: readonly T[],
  input: {
    rewroteProjectSettings: boolean
    useEstimateModeMachineSwitch: boolean
  }
): T[] {
  if (!input.rewroteProjectSettings || input.useEstimateModeMachineSwitch) {
    return [...profileFiles]
  }

  return profileFiles.filter((profile) => profile.kind !== 'machine')
}