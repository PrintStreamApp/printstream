/**
 * DEV ONLY. Exits this process when the process that started it goes away.
 *
 * Loaded as a `--require` preload (via `NODE_OPTIONS` in the at-risk `dev` scripts), so it needs no
 * app code and applies to any Node process in the dev tree.
 *
 * The failure it removes: `tsx watch` runs the server as a SEPARATE child process. If the watcher
 * dies, that child is reparented (to PID 1, or to a subreaper) and keeps running -- still holding
 * its port, still answering requests, still serving whatever code it loaded at boot, with no watcher
 * left to reload it. Nothing logs it and the process looks healthy, so the stack reads as up.
 *
 * That is the worst available shape for a dev failure: every subsequent edit appears not to work, so
 * the reasonable next move is to go looking for a bug in code that is already correct. It cost hours
 * and four rounds of "I tried again, still broken" on 2026-08-30, where the API had been serving
 * 9-minute-old code for 14 hours. With this preload the same event kills the server instead, which
 * is unmissable: nothing answers on the port.
 *
 * Detection is by REPARENTING, not by "ppid is 1". A container with an init subreaper adopts orphans
 * itself, so the ppid can change to something other than 1 and the process is orphaned all the same.
 *
 * It ARMS only after a grace period, and that is what keeps it from eating the recovery path. A
 * process started detached (`nohup npx tsx watch ...` / `setsid`, which is how you restart a service
 * whose watcher has died) is reparented within milliseconds of launch, by design, and has no
 * supervisor to outlive -- so killing it achieves nothing and merely takes away the one way back.
 * Measured: an unguarded `setsid` probe was killed by the first version of this file. Sampling the
 * parent twice, at load and again after the grace period, separates the two cases with no flag to
 * remember: a parent still present after ten seconds is a real supervisor, and only then is it
 * watched. The cost is that a watcher dying inside its first ten seconds is not caught, which is the
 * case you would notice anyway because you are standing there watching the stack start.
 *
 * Polling rather than a parent-held pipe because the parent is `tsx`, which offers no such channel.
 * One `process.ppid` read every few seconds costs nothing.
 *
 * BLAST RADIUS: `NODE_OPTIONS` is inherited, so every Node descendant of a wired `dev` script gets
 * this too. That is intended. Nothing in the dev tree is supposed to outlive its parent, so a
 * process this would kill is an instance of the same bug rather than a casualty of the fix.
 *
 * Counterpart: `apps/api/src/lib/dev-source-staleness.ts` reports the cases this cannot prevent (a
 * watcher that is alive but wedged, or a compiled package `dist` that never got rebuilt).
 */
'use strict'

// A production process is never started this way, but refuse to arm there regardless: a guard that
// can kill a live server has no business being one env var away from doing so.
if (process.env.NODE_ENV !== 'production' && process.env.PRINTSTREAM_DEV_EXIT_WITH_PARENT !== 'off') {
  const launchParent = process.ppid

  /** Long enough for a detached launch to have shed its parent, short enough to arm during startup. */
  const ARM_DELAY_MS = 10_000
  const CHECK_INTERVAL_MS = 3_000

  // Already parentless at load: nothing to watch, and nothing to wait for.
  if (launchParent > 1) {
    const arm = setTimeout(() => {
      // Reparented before we even armed: a detached launch, not a supervisor that died.
      if (process.ppid !== launchParent) return

      const timer = setInterval(() => {
        if (process.ppid === launchParent) return
        clearInterval(timer)
        console.error(
          `[dev] parent process ${launchParent} exited (now reparented to ${process.ppid}); ` +
          'stopping so this process cannot keep serving stale code. Restart the dev stack.'
        )
        process.exit(1)
      }, CHECK_INTERVAL_MS)
      timer.unref()
    }, ARM_DELAY_MS)
    // Neither timer may hold the event loop open: a service that is otherwise finished must still be
    // able to exit, and these must not be the reason a clean shutdown hangs.
    arm.unref()
  }
}
