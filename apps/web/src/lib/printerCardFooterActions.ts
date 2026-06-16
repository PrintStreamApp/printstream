export interface PrinterCardFooterActionDescriptor {
	key: string
	optional?: boolean
}

interface ResolveFooterOverflowKeysOptions {
	actions: readonly PrinterCardFooterActionDescriptor[]
	actionWidths: Readonly<Record<string, number>>
	rowWidth: number | null
	overflowButtonWidth: number
	gapPx: number
}

export function resolvePrinterCardFooterOverflowKeys({
	actions,
	actionWidths,
	rowWidth,
	overflowButtonWidth,
	gapPx
}: ResolveFooterOverflowKeysOptions): Set<string> {
	const overflowKeys = new Set<string>()
	if (rowWidth == null || actions.length === 0) return overflowKeys

	const measurableActions = actions.filter((action) => !action.optional || (actionWidths[action.key] ?? 0) > 0)
	if (
		measurableActions.length === 0
		|| !measurableActions.every((action) => (actionWidths[action.key] ?? 0) > 0)
	) {
		return overflowKeys
	}

	let visibleKeys = measurableActions.map((action) => action.key)
	const widthForKeys = (keys: readonly string[], includeOverflowMenu: boolean) => {
		const buttonsWidth = keys.reduce((total, key) => total + (actionWidths[key] ?? 0), 0)
		const gapCount = includeOverflowMenu ? keys.length : Math.max(0, keys.length - 1)
		return buttonsWidth + gapCount * gapPx + (includeOverflowMenu ? overflowButtonWidth : 0)
	}

	if (widthForKeys(visibleKeys, false) <= rowWidth) return overflowKeys

	while (visibleKeys.length > 0 && widthForKeys(visibleKeys, true) > rowWidth) {
		visibleKeys = visibleKeys.slice(0, -1)
	}

	const visibleKeySet = new Set(visibleKeys)
	for (const action of measurableActions) {
		if (!visibleKeySet.has(action.key)) overflowKeys.add(action.key)
	}

	return overflowKeys
}