/**
 * Process shutdown hook registry.
 *
 * The graceful-shutdown sequence lives in `index.ts`, but some teardown is owned
 * by the pre-env boot stage in `server.ts` — most importantly stopping the
 * embedded Postgres cluster, whose `stop()` handle `index.ts` has no other way to
 * reach (boot starts the cluster before the app, including this module, loads).
 * Boot code registers a hook here; `shutdown()` drains them as part of teardown,
 * before the process exits, so a clean SIGINT/SIGTERM stops Postgres instead of
 * leaving it to be killed (which costs a crash-recovery on next start).
 */
type ShutdownHook = () => Promise<void> | void

const hooks: ShutdownHook[] = []

export function registerShutdownHook(hook: ShutdownHook): void {
  hooks.push(hook)
}

/** Runs every registered hook, isolating failures so one slow/throwing hook does not block the rest. */
export async function runShutdownHooks(): Promise<void> {
  await Promise.allSettled(hooks.map((hook) => Promise.resolve().then(hook)))
}

export function clearShutdownHooksForTests(): void {
  hooks.length = 0
}
