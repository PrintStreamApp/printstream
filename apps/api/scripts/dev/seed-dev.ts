/**
 * Development seed: makes a fresh database signable-in and worth looking at.
 *
 * A newly provisioned database has workspaces but no users and no auth provider
 * switched on, which renders a sign-in page with nothing on it. This script
 * creates the account you actually sign in as, switches local auth on, and
 * gives the billing/organisation surfaces something to show.
 *
 * Idempotent: safe to re-run, and re-running is the supported way to mint a
 * fresh sign-in code.
 *
 * Sign-in without mail infra: dev sends real email through Cloudflare, so a
 * code normally arrives in your inbox. This also mints one directly and prints
 * it, so you can sign in through the ordinary UI without waiting for delivery
 * (and without DEMO_MODE, which would put the whole app in read-only).
 *
 * Never wired into startup or tests -- `npm run db:seed:dev` only.
 *
 * Usage:
 *   npm run db:seed:dev                        # seeds you@example.com
 *   npm run db:seed:dev -- me@work.com         # seeds a specific address
 *   npm run db:seed:dev -- me@work.com --no-platform   # workspace user only
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { PrismaClient } from '@prisma/client'
import {
  PLATFORM_ADMIN_GROUP_KEY,
  ensureBuiltInAuthGroups,
  ensureBuiltInPlatformAuthGroups
} from '../../src/lib/default-auth-groups.js'
import { customerNameForOwner } from '../../src/private/cloud/customer.js'
import { enableAuthLocalForWorkspace } from '../../src/plugins/auth-local/provisioning.js'
import { createEmailAuthCode, hashEmailAuthCode } from '../../src/plugins/auth-local/email-code-issuer.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
dotenv.config({ path: path.join(repoRoot, '.env') })

const DEFAULT_EMAIL = 'you@example.com'
const CODE_TTL_MINUTES = 60

const prisma = new PrismaClient()

async function main(): Promise<void> {
  const email = (process.argv[2] ?? DEFAULT_EMAIL).trim().toLowerCase()

  const workspaces = await prisma.workspace.findMany({ orderBy: { slug: 'asc' } })
  if (workspaces.length === 0) {
    throw new Error('No workspaces exist yet. Start the API once so it creates the default workspace.')
  }

  // Platform admin as well as workspace admin: a dev database is no use if the
  // platform surfaces (workspace administration, billing overview, support) are
  // invisible. Pass `--no-platform` to seed a plain workspace user instead,
  // which is what you want when checking what a customer actually sees.
  const platformAdmin = !process.argv.includes('--no-platform')

  const user = await prisma.authUser.upsert({
    where: { email },
    update: { isPlatformUser: platformAdmin },
    create: { email, displayName: 'Dev Admin', isPlatformUser: platformAdmin }
  })

  if (platformAdmin) {
    await ensureBuiltInPlatformAuthGroups(prisma)
    const platformAdminGroup = await prisma.authGroup.findFirst({
      where: { workspaceId: null, key: PLATFORM_ADMIN_GROUP_KEY }
    })
    if (!platformAdminGroup) throw new Error('platform Admin group missing after seeding built-in groups')
    await prisma.authUserGroupMembership.upsert({
      where: { userId_groupId: { userId: user.id, groupId: platformAdminGroup.id } },
      update: {},
      create: { userId: user.id, groupId: platformAdminGroup.id }
    })
  }

  // One account owning every workspace: the shape the billing and organisation
  // surfaces are built around, and the one a single-workspace seed cannot show.
  // Named the way production names one, rather than something only a seed
  // would produce -- the name is user-visible in the switcher and the heading.
  const accountName = customerNameForOwner(user)
  const account = await prisma.customer.upsert({
    where: { id: 'bac_dev' },
    update: { ownerUserId: user.id, name: accountName },
    create: { id: 'bac_dev', name: accountName, ownerUserId: user.id }
  })
  await prisma.customerMembership.upsert({
    where: { customerId_userId: { customerId: account.id, userId: user.id } },
    update: { billingRole: 'billing' },
    create: { customerId: account.id, userId: user.id, billingRole: 'billing' }
  })

  for (const workspace of workspaces) {
    await prisma.workspace.update({ where: { id: workspace.id }, data: { customerId: account.id } })
    await enableAuthLocalForWorkspace(prisma, workspace.id)
    await ensureBuiltInAuthGroups(prisma, workspace.id)

    // `updatedAt` is `@updatedAt` with no database default, and an EMPTY `update`
    // lets Prisma take its native INSERT ... ON CONFLICT path, which then omits
    // the column from the insert too. Both branches have to name it.
    await prisma.authWorkspaceMembership.upsert({
      where: { userId_workspaceId: { userId: user.id, workspaceId: workspace.id } },
      update: { updatedAt: new Date() },
      create: { userId: user.id, workspaceId: workspace.id, updatedAt: new Date() }
    })

    const admin = await prisma.authGroup.findFirst({ where: { workspaceId: workspace.id, name: 'Admin' } })
    if (admin) {
      await prisma.authUserGroupMembership.upsert({
        where: { userId_groupId: { userId: user.id, groupId: admin.id } },
        update: {},
        create: { userId: user.id, groupId: admin.id }
      })
    }
  }

  // A fresh code every run; the old ones are dropped so only the printed one works.
  const code = createEmailAuthCode()
  await prisma.authEmailCodeToken.deleteMany({ where: { email } })
  await prisma.authEmailCodeToken.create({
    data: {
      userId: user.id,
      email,
      tokenHash: hashEmailAuthCode(code),
      expiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60_000)
    }
  })

  const entry = 'http://localhost:5173/auth'

  console.log(`
Seeded ${workspaces.length} workspace(s): ${workspaces.map((workspace) => workspace.slug).join(', ')}
  admin           ${email} (Admin in every workspace${platformAdmin ? ', and platform admin' : ''})
  billing account ${account.name} -- owner, with billing access

Sign in at   ${entry}

  email  ${email}
  code   ${code}     (valid ${CODE_TTL_MINUTES} minutes)

Re-run this script for a fresh code.
`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
  .finally(() => {
    void prisma.$disconnect()
  })
