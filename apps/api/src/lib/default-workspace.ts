/**
 * First-run default workspace bootstrap.
 *
 * Self-hosted installs have no workspace-administration UI, so a fresh
 * database would otherwise have zero workspaces and nowhere to land after
 * sign-in. On startup, if no workspace exists yet, create one (with its
 * built-in auth groups) using `DEFAULT_WORKSPACE_SLUG` / `_NAME`.
 *
 * Whether it runs at all is DERIVED from the deployment (see below): neither
 * side has to set `AUTO_CREATE_DEFAULT_WORKSPACE`, which exists only as an
 * override. Existing databases are never touched, because any existing
 * workspace short-circuits the bootstrap.
 */
import { ensureBuiltInAuthGroups } from './default-auth-groups.js'
import { env } from './env.js'
import { isSelfHostedDeployment } from './deployment-mode.js'
import { rootPrisma } from './prisma.js'

interface DefaultWorkspaceDeps {
  enabled?: boolean
  client?: {
    workspace: {
      count(): Promise<number>
      create(args: {
        data: { slug: string; name: string }
        select: { id: true; slug: true }
      }): Promise<{ id: string; slug: string }>
    }
  }
  ensureGroups?: (client: unknown, workspaceId: string) => Promise<void>
}

/** Returns the created workspace slug, or null when nothing was created. */
export async function ensureDefaultWorkspace(deps: DefaultWorkspaceDeps = {}): Promise<string | null> {
  // Unset derives from the deployment: a self-hosted install should come up
  // usable with zero configuration, while the cloud's workspaces only ever come
  // from signups, its empty database is first-run, and auto-minting a "My
  // Workspace" there put a stray workspace in front of the platform operator.
  const enabled = deps.enabled ?? env.AUTO_CREATE_DEFAULT_WORKSPACE ?? isSelfHostedDeployment()
  const client = deps.client ?? rootPrisma
  const ensureGroups = deps.ensureGroups ?? ((groupClient, workspaceId) =>
    ensureBuiltInAuthGroups(groupClient as typeof rootPrisma, workspaceId))
  if (!enabled) return null

  const existing = await client.workspace.count()
  if (existing > 0) return null

  const workspace = await client.workspace.create({
    data: {
      slug: env.DEFAULT_WORKSPACE_SLUG,
      name: env.DEFAULT_WORKSPACE_NAME
    },
    select: { id: true, slug: true }
  })
  await ensureGroups(client, workspace.id)
  console.log(`Created default workspace "${workspace.slug}" (no workspaces existed yet).`)
  return workspace.slug
}
