/**
 * Counted nouns, in one place.
 *
 * The app writes `${n} thing${n === 1 ? '' : 's'}` inline in dozens of places,
 * and the platform workspaces list proved why that is a problem: three counts
 * beside each other, and the ones that read "1 users" and "1 bridges" had simply
 * been typed without the ternary. New counted labels should come through here.
 */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}
