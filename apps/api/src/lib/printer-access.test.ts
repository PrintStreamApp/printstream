import assert from 'node:assert/strict'
import test from 'node:test'
import { HttpError } from './http-error.js'
import { prisma } from './prisma.js'
import { printerManager } from './printer-manager.js'
import { usePrismaStubs } from '../test-utils/prisma-stubs.js'
import { assertWorkspaceOwnsPrinter, requireWorkspaceOwnedConnectedPrinter } from './printer-access.js'

const stubPrisma = usePrismaStubs()

async function withManagedPrinter<T>(printerId: string, printer: unknown, run: () => Promise<T>): Promise<T> {
  const manager = printerManager as unknown as { getPrinter: (id: string) => unknown }
  const original = manager.getPrinter
  manager.getPrinter = (id: string) => (id === printerId ? printer : undefined)
  try {
    return await run()
  } finally {
    manager.getPrinter = original
  }
}

test('requireWorkspaceOwnedConnectedPrinter 404s on a cross-workspace id even when the manager has it', async () => {
  // The scoped client returns null for a printer owned by another workspace; the helper must
  // 404 BEFORE trusting the (id-only, unscoped) manager map, so a foreign-but-connected
  // printer can never be acted on.
  stubPrisma(prisma.printer, 'findUnique', async () => null)
  await withManagedPrinter('printer-x', { id: 'printer-x', name: 'Foreign' }, async () => {
    await assert.rejects(
      () => requireWorkspaceOwnedConnectedPrinter('printer-x'),
      (error: unknown) => error instanceof HttpError && error.statusCode === 404
    )
  })
})

test('requireWorkspaceOwnedConnectedPrinter returns the live printer when workspace-owned and connected', async () => {
  stubPrisma(prisma.printer, 'findUnique', async () => ({ id: 'printer-1' }))
  const live = { id: 'printer-1', name: 'Mine' }
  const result = await withManagedPrinter<unknown>('printer-1', live, () => requireWorkspaceOwnedConnectedPrinter('printer-1'))
  assert.equal(result, live)
})

test('requireWorkspaceOwnedConnectedPrinter 404s when owned but not currently connected', async () => {
  stubPrisma(prisma.printer, 'findUnique', async () => ({ id: 'printer-1' }))
  await withManagedPrinter('printer-1', undefined, async () => {
    await assert.rejects(
      () => requireWorkspaceOwnedConnectedPrinter('printer-1'),
      (error: unknown) => error instanceof HttpError && error.statusCode === 404
    )
  })
})

test('assertWorkspaceOwnsPrinter 404s on a cross-workspace id and passes for an owned one', async () => {
  stubPrisma(prisma.printer, 'findUnique', async () => null)
  await assert.rejects(
    () => assertWorkspaceOwnsPrinter('printer-x'),
    (error: unknown) => error instanceof HttpError && error.statusCode === 404
  )
  stubPrisma(prisma.printer, 'findUnique', async () => ({ id: 'printer-1' }))
  await assert.doesNotReject(() => assertWorkspaceOwnsPrinter('printer-1'))
})
