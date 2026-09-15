/**
 * Who answers a queued dispatch's safety questions.
 *
 * Owns one rule: an `allow*` flag is a CONSENT, so it must be granted
 * deliberately by a named origin and never fall out of an omitted argument. It
 * used to be a defaulted parameter on the dispatch helper, which meant the
 * unattended sweep's consent was what every caller got for free.
 *
 * Contract: every path that builds a queue dispatch states its origin here, and
 * only `person-start` can withhold. Getting it wrong is invisible until a print
 * runs dry, a wrong-machine file starts, or a queue stalls. That is why the
 * answers live together instead of as adjacent booleans at several call sites.
 *
 * Counterparts: `assertSufficientFilament` and `assertFilamentBlacklist` in
 * `apps/api/src/lib/print-filament-compatibility.ts` are what these consent to,
 * and `QueueStartDialog` is where a person's answer comes from.
 */

export type QueueDispatchOrigin =
  /** The unattended pass over idle printers, with nobody present to answer. */
  | 'unattended-sweep'
  /** Someone pressed Start and answered the dialog's confirmation themselves. */
  | 'person-start'
  /** The "Check" dry run, which starts nothing and reports what a Start would meet. */
  | 'dry-run'

/**
 * Whether this dispatch may pass the low-filament guard without a person
 * answering for it.
 *
 * - `unattended-sweep` consents. Holding the item instead would stall a queue on
 *   an ESTIMATE (the printer reports only a percent, and only for tagged
 *   spools) to avoid something the printer already handles by pausing when a
 *   slot runs dry.
 * - `person-start` consents only as far as `personConfirmed` says. Their answer
 *   is the whole point of the dialog's confirmation.
 * - `dry-run` WITHHOLDS, so the check actually runs and the dry run can see what
 *   it found. It must not then report that as a failure: neither real path fails
 *   on it (the sweep consents, and a person gets a confirmation to tick), so the
 *   caller downgrades an `InsufficientFilamentError` to an advisory. Consenting
 *   here instead would make the check silent about the one thing it was pressed
 *   for; reporting it as a failure is what read as "Start would fail: Not enough
 *   filament loaded for this print" on an item the queue starts happily.
 *
 * @param personConfirmed read only for `person-start`; ignored otherwise, since
 *   no person is present on the other two paths.
 */
export function allowsInsufficientFilament(origin: QueueDispatchOrigin, personConfirmed = false): boolean {
  if (origin === 'unattended-sweep') return true
  return origin === 'person-start' ? personConfirmed : false
}

/**
 * Whether this dispatch may pass the filament-blacklist guard without a person answering.
 *
 * Deliberately NOT the same answer as {@link allowsInsufficientFilament}, and the difference is
 * the point: `unattended-sweep` REFUSES here. A low-filament slot makes a print pause, which the
 * printer already handles, whereas a material Bambu forbids on this hardware (TPU through an AMS,
 * an abrasive through an E3D high-flow nozzle) damages the printer. Nobody is present to accept
 * that, so an unattended queue must hold the item rather than assume consent.
 *
 * `dry-run` withholds for the same reason as above, so the Check surfaces the guard rather than
 * silently passing it. Unlike the low-filament case the caller does NOT downgrade this to an
 * advisory, because an unattended start really would refuse it.
 */
export function allowsBlacklistedFilament(origin: QueueDispatchOrigin, personConfirmed = false): boolean {
  return origin === 'person-start' ? personConfirmed : false
}

/** Every consent a queued dispatch carries, resolved together so callers cannot silently omit one. */
export interface QueueDispatchConsents {
  allowInsufficientFilament: boolean
  allowBlacklistedFilament: boolean
  allowPrinterModelMismatch: boolean
}

/**
 * The consents for a dispatch from `origin`, with a person's own answers where there is a person.
 *
 * Bundled rather than threaded as booleans: they travel together through several helpers, and
 * adjacent boolean parameters are a swap waiting to happen that the type checker cannot see.
 */
export function resolveQueueDispatchConsents(
  origin: QueueDispatchOrigin,
  personAnswers: Partial<QueueDispatchConsents> = {}
): QueueDispatchConsents {
  return {
    allowInsufficientFilament: allowsInsufficientFilament(origin, personAnswers.allowInsufficientFilament === true),
    allowBlacklistedFilament: allowsBlacklistedFilament(origin, personAnswers.allowBlacklistedFilament === true),
    // A model mismatch is never assumed by an unattended or diagnostic path.
    allowPrinterModelMismatch: origin === 'person-start' && personAnswers.allowPrinterModelMismatch === true
  }
}
