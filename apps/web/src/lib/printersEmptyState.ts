export function shouldShowNoConnectedPrintersEmptyState(input: {
  showNoConnectedBridgesPlaceholder: boolean
  printersCount: number
  loading: boolean
  hasError: boolean
}): boolean {
  return !input.showNoConnectedBridgesPlaceholder
    && input.printersCount === 0
    && !input.loading
    && !input.hasError
}
