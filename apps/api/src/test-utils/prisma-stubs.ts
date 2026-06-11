/**
 * Test-only helpers for stubbing Prisma client methods with automatic restore.
 *
 * The Prisma client is a Proxy: `prisma.printJob.findUnique` is produced by the get-trap, so the
 * method has no usable own descriptor (node:test's `mock.method` rejects it, and
 * `Object.getOwnPropertyDescriptor` reports `value: undefined`). The only handle on the real method
 * is the value you read by accessing it. Suites therefore override methods with raw
 * `Object.defineProperty`, which forces each file to hand-track an `originalX` per method plus a
 * matching restore block in `afterEach` — easy to get wrong (a missed restore leaks into the next
 * test).
 *
 * Both helpers capture the real method by reading it once, then restore it by re-pinning that value
 * (the same thing the hand-written teardown blocks did). Pick one:
 * - `usePrismaStubs()` for new/rewritten suites: `stub(prisma.model, 'method', impl)` auto-restores.
 * - `restorePrismaMethodsAfterEach([...])` to migrate an existing suite without touching its (often
 *   multi-line) `Object.defineProperty` setup sites — it just removes the bookkeeping.
 */
import { afterEach } from 'node:test'

type AnyMethod = (...args: never[]) => unknown

export interface PrismaStubber {
  /** Override `target[method]` for the current test; the real method is restored in `afterEach`. */
  <Target extends object, Method extends keyof Target & string>(target: Target, method: Method, impl: AnyMethod): void
}

export function usePrismaStubs(): PrismaStubber {
  const restores: Array<() => void> = []

  afterEach(() => {
    // Drain in reverse (pop) so a method stubbed twice in one test ends up at its true original.
    while (restores.length > 0) {
      restores.pop()?.()
    }
  })

  return function stub(target, method, impl) {
    const original = (target as Record<string, unknown>)[method]
    overrideMethod(target, method, impl)
    restores.push(() => overrideMethod(target, method, original))
  }
}

/**
 * Migration-friendly alternative: capture the listed Prisma delegate methods once (at module load)
 * and restore them after every test. Use for an existing suite that already overrides methods with
 * raw `Object.defineProperty` — it removes the per-method `originalX` variables and the restore block
 * without having to rewrite every setup site.
 */
// `target` is `unknown` (not `object`) so callers can pass `prisma.model` references directly: the
// Prisma client's delegate types are enormous, and a more specific parameter type makes TS try to
// deep-instantiate them across a long list (TS2589). The runtime values are always real objects.
export function restorePrismaMethodsAfterEach(methods: Array<[target: unknown, method: string]>): void {
  const snapshots = methods.map(([target, method]) => {
    const object = target as Record<string, unknown>
    return { object, method, original: object[method] }
  })

  afterEach(() => {
    for (const { object, method, original } of snapshots) {
      overrideMethod(object, method, original)
    }
  })
}

function overrideMethod(target: object, method: string, value: unknown): void {
  Object.defineProperty(target, method, { value, configurable: true, writable: true })
}
