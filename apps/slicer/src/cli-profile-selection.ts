import type { SlicingProfileKind } from '@printstream/shared'

type SliceProfileKind = {
  kind: SlicingProfileKind
}

/**
 * Which profile files reach the CLI's `--load-settings`. Once the input 3MF's
 * project settings were rewritten (identity + any native machine retarget baked
 * in), the machine profile is dropped: the embedded 3MF already carries the
 * correct machine, and re-loading a machine preset alongside a project is what
 * the CLI's crash matrix punishes (see docs/slicer-cross-model-machine-switch.md).
 */
export function selectCliProfileFiles<T extends SliceProfileKind>(
  profileFiles: readonly T[],
  input: {
    rewroteProjectSettings: boolean
  }
): T[] {
  if (!input.rewroteProjectSettings) {
    return [...profileFiles]
  }

  return profileFiles.filter((profile) => profile.kind !== 'machine')
}
