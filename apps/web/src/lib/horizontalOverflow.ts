export function resolveHorizontalOverflowState(input: {
  scrollLeft: number
  clientWidth: number
  scrollWidth: number
}) {
  const maxScrollLeft = Math.max(input.scrollWidth - input.clientWidth, 0)
  const isOverflowing = maxScrollLeft > 1

  return {
    isOverflowing,
    showStartFade: isOverflowing && input.scrollLeft > 1,
    showEndFade: isOverflowing && input.scrollLeft < maxScrollLeft - 1
  }
}