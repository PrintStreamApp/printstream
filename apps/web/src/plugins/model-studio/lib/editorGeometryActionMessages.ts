/** Feedback shared by geometry actions that discard helper volumes from the source models. */

/** Explain the loss after a successful action and point to Undo as the recovery path. */
export function discardedHelperVolumeNotice(count: number): string {
  if (count === 0) return ''
  return ` ${count} helper volume${count === 1 ? '' : 's'} could not be carried over: undo to get ${count === 1 ? 'it' : 'them'} back.`
}
