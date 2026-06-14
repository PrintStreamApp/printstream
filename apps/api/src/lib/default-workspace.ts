/**
 * First-run default workspace bootstrap.
 *
 * Self-hosted installs have no tenant-administration UI, so a fresh
 * database would otherwise have zero workspaces and nowhere to land after
 * sign-in. On startup, if no tenant exists yet, create one (with its
 * built-in auth groups) using `DEFAULT_WORKSPACE_SLUG` / `_NAME`.
 *
 * Multi-tenant (cloud) deployments that manage tenants explicitly can opt
 * out with `AUTO_CREATE_DEFAULT_WORKSPACE=false`; existing databases are
 * never touched because any existing tenant short-circuits the bootstrap.
 */
import { ensureBuiltInAuthGroups } from './default-auth-groups.js'
import { env } from './env.js'
import { rootPrisma } from './prisma.js'

interface DefaultWorkspaceDeps {
  enabled?: boolean
  client?: {
    tenant: {
      count(): Promise<number>
      create(args: {
        data: { slug: string; name: string }
        select: { id: true; slug: true }
      }): Promise<{ id: string; slug: string }>
    }
  }
  ensureGroups?: (client: unknown, tenantId: string) => Promise<void>
}

/** Returns the created workspace slug, or null when nothing was created. */
export async function ensureDefaultWorkspace(deps: DefaultWorkspaceDeps = {}): Promise<string | null> {
  const enabled = deps.enabled ?? env.AUTO_CREATE_DEFAULT_WORKSPACE
  const client = deps.client ?? rootPrisma
  const ensureGroups = deps.ensureGroups ?? ((groupClient, tenantId) =>
    ensureBuiltInAuthGroups(groupClient as typeof rootPrisma, tenantId))
  if (!enabled) return null

  const existing = await client.tenant.count()
  if (existing > 0) return null

  const tenant = await client.tenant.create({
    data: {
      slug: env.DEFAULT_WORKSPACE_SLUG,
      name: env.DEFAULT_WORKSPACE_NAME
    },
    select: { id: true, slug: true }
  })
  await ensureGroups(client, tenant.id)
  console.log(`Created default workspace "${tenant.slug}" (no tenants existed yet).`)
  return tenant.slug
}
