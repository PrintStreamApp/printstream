/**
 * Prisma error classification helpers.
 */
import { Prisma } from '@prisma/client'

export function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}
