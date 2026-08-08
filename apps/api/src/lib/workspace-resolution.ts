/**
 * Shared workspace-list helpers for platform bootstrap flows, plus the wide-open
 * fallback workspace used by fresh self-hosted installs.
 */
import { authProviderRegistry } from './auth-registry.js'
import type { AnyPrismaClient } from './prisma.js'
import { rootPrisma } from './prisma.js'
import { isPublicDemoWorkspace } from './public-demo-policy.js'
import { isWorkspaceDisabled } from './workspace-availability.js'
import { REQUEST_WORKSPACE_SELECT, toRequestWorkspaceSummary, type RequestWorkspaceSummary } from './workspace-summary.js'
import { withWorkspaceRequestContext } from './workspace-context.js'
import { visibleWorkspaceScope } from './workspace-visibility.js'

export async function listWorkspaces(prisma: AnyPrismaClient): Promise<Array<{
  id: string
  slug: string
  name: string
  description?: string | null
}>> {
  return await prisma.workspace.findMany({
    where: visibleWorkspaceScope,
    orderBy: [
      { name: 'asc' },
      { createdAt: 'asc' }
    ],
    select: {
      id: true,
      slug: true,
      name: true,
      description: true
    }
  })
}

interface SoleWorkspaceDeps {
  listCandidateWorkspaces?: () => Promise<RequestWorkspaceSummary[]>
  isWorkspaceDisabled?: (workspaceId: string) => Promise<boolean>
  isPublicDemoWorkspace?: (workspace: RequestWorkspaceSummary) => boolean
}

/**
 * Resolves the single enabled, non-demo workspace on this install, or `null`
 * when the choice is ambiguous (zero or more than one surviving candidate).
 * This is the "exactly one real workspace" test shared by the wide-open
 * workspace-resolution fallback and managed-bridge auto-pairing; it deliberately
 * makes no auth-provider judgement so callers can layer their own policy on
 * top (wide-open requires no enabled provider; managed-bridge does not).
 */
export async function resolveSoleWorkspace(deps: SoleWorkspaceDeps = {}): Promise<RequestWorkspaceSummary | null> {
  const listCandidateWorkspaces = deps.listCandidateWorkspaces
    ?? (async () => (await rootPrisma.workspace.findMany({
      where: visibleWorkspaceScope,
      // A handful is plenty: a second surviving candidate already makes the
      // choice ambiguous and aborts the fallback.
      take: 5,
      orderBy: { createdAt: 'asc' },
      select: REQUEST_WORKSPACE_SELECT
    })).map(toRequestWorkspaceSummary))
  const workspaceIsDisabled = deps.isWorkspaceDisabled
    ?? (async (workspaceId: string) => await isWorkspaceDisabled({ workspaceId }))
  const workspaceIsPublicDemo = deps.isPublicDemoWorkspace ?? isPublicDemoWorkspace

  const candidates: RequestWorkspaceSummary[] = []
  for (const workspace of await listCandidateWorkspaces()) {
    if (workspaceIsPublicDemo(workspace)) continue
    if (await workspaceIsDisabled(workspace.id)) continue
    candidates.push(workspace)
    if (candidates.length > 1) return null
  }
  return candidates[0] ?? null
}

interface WideOpenDefaultWorkspaceDeps extends SoleWorkspaceDeps {
  hasAnyEnabledProvider?: (workspace: RequestWorkspaceSummary | null) => Promise<boolean>
}

/**
 * Resolves the workspace that context-less requests should default into on a
 * deployment that runs "wide open" (no auth provider enabled anywhere — the
 * documented fresh self-hosted install state, in which nobody can be signed
 * in). Returns the workspace only when the choice is unambiguous: exactly one
 * enabled, non-demo workspace, with no enabled auth provider in either the
 * platform scope or that workspace's scope. A provider that is enabled but
 * still awaiting setup also blocks the fallback — that install is mid-setup,
 * not wide open.
 */
export async function resolveWideOpenDefaultWorkspace(deps: WideOpenDefaultWorkspaceDeps = {}): Promise<RequestWorkspaceSummary | null> {
  const hasAnyEnabledProvider = deps.hasAnyEnabledProvider
    ?? (async (workspace: RequestWorkspaceSummary | null) =>
      (await withWorkspaceRequestContext(workspace, async () => await authProviderRegistry.list()))
        .some((provider) => provider.enabled))
  if (await hasAnyEnabledProvider(null)) {
    return null
  }

  const workspace = await resolveSoleWorkspace(deps)
  if (!workspace) {
    return null
  }

  return (await hasAnyEnabledProvider(workspace)) ? null : workspace
}
