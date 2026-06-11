/**
 * Shared tenant-list helper for platform bootstrap flows.
 */
import type { AnyPrismaClient } from './prisma.js'

export async function listTenants(prisma: AnyPrismaClient): Promise<Array<{
  id: string
  slug: string
  name: string
  description?: string | null
}>> {
  return await prisma.tenant.findMany({
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