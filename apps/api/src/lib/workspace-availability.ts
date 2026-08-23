/**
 * Platform-managed workspace availability helpers.
 *
 * Disabled workspaces remain in the directory for platform admins, but they
 * cannot be selected as an active workspace until re-enabled.
 *
 * A workspace can be unavailable for a reason core does not own: the cloud
 * module retires whole customer accounts, and every workspace under a retired
 * one is unusable. That arrives through {@link registerWorkspaceUnavailability}
 * rather than a `private/` import (core must never reach into that directory)
 * and rather than the cloud module copying `disabled` onto each workspace,
 * a copy could not tell, on restore, which of them had been disabled on their
 * own beforehand. Same registry shape as `printer-quota.ts`.
 */
import { rootPrisma, type AnyPrismaClient } from './prisma.js'
import { scopeSettingKeyForWorkspace } from './workspace-settings.js'

/**
 * Stored `Setting.key` for the disabled flag. Says `tenant` because the key is
 * PERSISTED: renaming it would orphan every existing flag and silently
 * re-enable workspaces an operator had disabled.
 */
export const WORKSPACE_DISABLED_SETTING_KEY = 'platform:workspaceDisabled'

type WorkspaceSummaryLike = {
  id: string
}

type SettingStore = Pick<AnyPrismaClient, 'setting'>

/** Answers "is this workspace unavailable for a reason outside core?". */
type WorkspaceUnavailability = {
  isUnavailable: (workspaceId: string) => Promise<boolean>
  /** The subset of these ids that are unavailable, for list-shaped callers. */
  filterUnavailable: (workspaceIds: readonly string[]) => Promise<Set<string>>
}

let unavailability: WorkspaceUnavailability | null = null

export function registerWorkspaceUnavailability(next: WorkspaceUnavailability): void {
  unavailability = next
}

export function clearWorkspaceUnavailability(): void {
  unavailability = null
}

export async function listDisabledWorkspaceIds(input: {
  workspaceIds: readonly string[]
  prismaClient?: SettingStore
}): Promise<Set<string>> {
  if (input.workspaceIds.length === 0) {
    return new Set<string>()
  }

  const prismaClient = input.prismaClient ?? rootPrisma
  const rows = await prismaClient.setting.findMany({
    where: {
      key: {
        in: input.workspaceIds.map((workspaceId) => workspaceDisabledSettingKey(workspaceId))
      },
      value: 'true'
    },
    select: { key: true }
  })

  const disabled = new Set(
    rows.map((row) => workspaceIdFromWorkspaceDisabledSettingKey(row.key))
      .filter((workspaceId): workspaceId is string => workspaceId != null)
  )
  for (const workspaceId of (await unavailability?.filterUnavailable(input.workspaceIds)) ?? []) {
    disabled.add(workspaceId)
  }
  return disabled
}

export async function isWorkspaceDisabled(input: {
  workspaceId: string
  prismaClient?: SettingStore
}): Promise<boolean> {
  const prismaClient = input.prismaClient ?? rootPrisma
  const row = await prismaClient.setting.findUnique({
    where: { key: workspaceDisabledSettingKey(input.workspaceId) },
    select: { value: true }
  })

  if (row?.value === 'true') return true
  // Checked second: the stored flag is the common case and answers without a
  // second query for every workspace an operator disabled directly.
  return (await unavailability?.isUnavailable(input.workspaceId)) ?? false
}

export async function setWorkspaceDisabled(input: {
  workspaceId: string
  disabled: boolean
  prismaClient?: SettingStore
}): Promise<void> {
  const prismaClient = input.prismaClient ?? rootPrisma
  await prismaClient.setting.upsert({
    where: { key: workspaceDisabledSettingKey(input.workspaceId) },
    update: { value: input.disabled ? 'true' : 'false' },
    create: {
      key: workspaceDisabledSettingKey(input.workspaceId),
      value: input.disabled ? 'true' : 'false'
    }
  })
}

export async function filterEnabledWorkspaces<TWorkspace extends WorkspaceSummaryLike>(input: {
  workspaces: readonly TWorkspace[]
  prismaClient?: SettingStore
}): Promise<TWorkspace[]> {
  const disabledIds = await listDisabledWorkspaceIds({
    workspaceIds: input.workspaces.map((workspace) => workspace.id),
    prismaClient: input.prismaClient
  })

  return input.workspaces.filter((workspace) => !disabledIds.has(workspace.id))
}

export function workspaceDisabledSettingKey(workspaceId: string): string {
  return scopeSettingKeyForWorkspace(workspaceId, WORKSPACE_DISABLED_SETTING_KEY)
}

function workspaceIdFromWorkspaceDisabledSettingKey(key: string): string | null {
  const prefix = 'workspace:'
  const suffix = `:${WORKSPACE_DISABLED_SETTING_KEY}`
  if (!key.startsWith(prefix) || !key.endsWith(suffix)) {
    return null
  }

  return key.slice(prefix.length, -suffix.length)
}