/**
 * Prisma error classification helpers.
 */
import { Prisma } from '@prisma/client'

export function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

/**
 * True when Prisma reports that a queried column does not exist on the table
 * (error code `P2022`). Used to gracefully fall back when a pending migration
 * has not yet added newer columns the query references.
 */
export function isMissingColumnError(error: unknown): boolean {
  return typeof error === 'object'
    && error != null
    && 'code' in error
    && (error as { code?: unknown }).code === 'P2022'
}
