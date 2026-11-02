/** Resolve Update original against the active draft and the host's actual storage capability. */
export function canUpdateProcessPreset(input: {
  activeProfileId: string
  originalProfileId: string
  canEditOriginal?: boolean
  canUpdateProfile?: (profileId: string) => boolean
}): boolean {
  if (input.canUpdateProfile) return input.canUpdateProfile(input.activeProfileId)
  return input.activeProfileId === input.originalProfileId && input.canEditOriginal === true
}
