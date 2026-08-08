import type { WorkspaceSummary } from '@printstream/shared'

/**
 * Normalizes the access-scoped workspace list returned by auth bootstrap
 * so the UI does not show duplicate workspace entries.
 */
export function listAccessibleWorkspaces(workspaces: ReadonlyArray<WorkspaceSummary>): WorkspaceSummary[] {
  const seenWorkspaceIds = new Set<string>()
  const uniqueWorkspaces: WorkspaceSummary[] = []

  for (const workspace of workspaces) {
    if (seenWorkspaceIds.has(workspace.id)) {
      continue
    }

    seenWorkspaceIds.add(workspace.id)
    uniqueWorkspaces.push(workspace)
  }

  return uniqueWorkspaces.sort((left, right) => {
    const nameComparison = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
    if (nameComparison !== 0) return nameComparison

    const slugComparison = left.slug.localeCompare(right.slug, undefined, { sensitivity: 'base' })
    if (slugComparison !== 0) return slugComparison

    return left.id.localeCompare(right.id)
  })
}

export function countAccessibleWorkspaceChoices(input: {
  workspaces: ReadonlyArray<WorkspaceSummary>
  includePlatform: boolean
  customerCount?: number
}): number {
  return listAccessibleWorkspaces(input.workspaces).length
    + (input.includePlatform ? 1 : 0)
    + (input.customerCount ?? 0)
}

/**
 * How many places this user could switch TO -- which decides whether the
 * chooser is reachable at all.
 *
 * Counts billing accounts alongside workspaces because they are scopes in the
 * same sense: the chooser lists them together, and someone who registered for a
 * self-hosted licence has an account and no workspace. Counting workspaces
 * alone made the chooser unreachable for exactly that person, so their one
 * scope had no route to it and the page rendered empty.
 *
 * Unlike the platform entry, accounts count even with no workspace active: the
 * platform is somewhere you RETURN to (hence its `activeWorkspaceId` guard),
 * while an account is somewhere you may never have been.
 */
export function countSwitchableWorkspaceChoices(input: {
  workspaces: ReadonlyArray<WorkspaceSummary>
  includePlatform: boolean
  activeWorkspaceId: string | null
  customerCount?: number
}): number {
  const uniqueWorkspaces = listAccessibleWorkspaces(input.workspaces)
  const workspaceChoices = input.activeWorkspaceId == null
    ? uniqueWorkspaces.length
    : uniqueWorkspaces.filter((workspace) => workspace.id !== input.activeWorkspaceId).length
  const platformChoices = input.includePlatform && input.activeWorkspaceId != null ? 1 : 0

  return workspaceChoices + platformChoices + (input.customerCount ?? 0)
}