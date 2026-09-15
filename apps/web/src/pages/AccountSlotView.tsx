/**
 * A top-level page that hosts one Account plugin slot.
 *
 * Billing and Messages started as sections stacked inside Account. They grew
 * past that: Billing now carries a plan, a promo notice, payment history, a
 * self-hosted key, and a list of licences, and Messages is a conversation
 * inbox. Each is a destination in its own right rather than a section someone
 * scrolls past.
 *
 * Renders the slot and nothing else. The hosted section already draws its own
 * `PageSectionHeading` with the title, description, item count, and actions;
 * this passes `standalone` through the slot context so that heading takes the
 * `h3` every other top-level view uses. Adding a heading here instead would
 * print the title twice.
 *
 * The slot is catalog-aware so a disabled self-hosted cloud connection does
 * not leave behind an empty route.
 *
 * Counterpart: `CurrentAccountPanel`, which links here instead of rendering the
 * same slots inline.
 */
import { PluginSlot } from '../plugin/PluginSlot'

export function AccountSlotView({ slot }: { slot: string }) {
  return <PluginSlot name={slot} context={{ presentation: 'standalone-page' }} />
}
